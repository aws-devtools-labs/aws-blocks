# AppSetting — Design

**Package:** `@aws-blocks/bb-app-setting`
**Type:** Primitive (new infrastructure)
**AWS Service:** SSM Parameter Store (String + SecureString)

## Infrastructure (CDK)

### String Parameters (`secret` not set or `false`)

Creates one `aws-cdk-lib/aws-ssm.StringParameter` per AppSetting instance:

- **Parameter name:** Taken from `options.name`
- **Parameter type:** String (standard tier, 4 KB limit, free)
- **Initial value:** Serialized form of `options.value` (JSON string for objects, raw string for strings)
- **Removal policy:** DESTROY (parameter cleaned up on stack deletion)
- **Permissions granted to `this.handler`:**
  - `ssm:GetParameter` on the parameter ARN
  - `ssm:PutParameter` on the parameter ARN
- **Environment variable:** SSM parameter name passed to the Lambda handler via `BLOCKS_SSM_PARAM_{ID}` so the AWS runtime can discover the parameter

### SecureString Parameters (`secret: true`)

CloudFormation cannot natively create SSM SecureString parameters. The CDK implementation uses a Custom Resource Lambda to create and manage the parameter:

- **Custom Resource Lambda:**
  - Uses `lambda.Code.fromInline()` with `@aws-sdk/client-ssm` and `crypto`
  - On `Create`: generates a **random** secret via `crypto.randomBytes(32).toString('base64url')` and calls `PutParameterCommand` with `Type: 'SecureString'`, `Overwrite: false` (no serialized initial value — secrets never come from source)
  - On `Delete`: calls `DeleteParameterCommand` to clean up the parameter
  - On `Update`: generates a random secret for newly added names (same as `Create`) **and** deletes parameters for names removed since the previous deployment (not a no-op); existing values are left untouched and managed at runtime via `put()`
  - Granted `ssm:PutParameter` and `ssm:DeleteParameter` scoped to the parameter ARN, plus `kms:Encrypt` (with the `kms:ViaService` condition) so it can write the encrypted SecureString
  - A single shared Lambda + `CustomResource` is created per stack; each secret parameter name is appended to the resource's `ParameterNames` list

- **KMS encryption:** Uses the default `aws/ssm` managed KMS key (no custom key needed, $0/month)

- **Handler permissions (the runtime `this.handler`):**
  - `ssm:GetParameter` on the parameter ARN
  - `ssm:PutParameter` on the parameter ARN
  - `kms:Decrypt` **and** `kms:Encrypt` with a `kms:ViaService` condition restricting usage to `ssm.{region}.amazonaws.com`

## Serialization & Validation

Values are always serialized with `JSON.stringify()` on write and deserialized with `JSON.parse()` on read, regardless of type. This ensures consistent round-tripping for all value types (strings, numbers, booleans, objects). Both the AWS runtime (SSM parameter) and the mock (disk file) store the same JSON-encoded string.

The table below shows the AWS runtime (SSM) representation:

| Operation | Behavior |
|-----------|----------|
| `put()` store | `JSON.stringify(value)` |
| `get()` retrieve | `JSON.parse(stored)` with fallback to raw value |

**Tolerant reader:** `get()` wraps `JSON.parse()` in a try/catch. If parsing fails, the raw value is returned as-is. This fallback is load-bearing in two cases: (1) the CDK secret Lambda writes generated secrets as raw base64url strings (never JSON-stringified), and (2) legacy values written by older versions without `JSON.stringify`. Note: legacy values that happen to be valid JSON (e.g. `"123"`, `"true"`) will be parsed to their JSON type (number, boolean) — not returned as strings. All values written by `put()` going forward will round-trip correctly.

When `options.schema` is provided (any `StandardSchemaV1` implementation — Zod, Valibot, ArkType, etc.), the type parameter `T` is inferred from the schema and every `put()` validates the value at runtime before writing. Validation failures throw with `error.name = 'ValidationFailedException'`. When no schema is provided, `T` defaults to `string` with no runtime validation.

The 4 KB (4096 bytes) size limit applies to the **JSON-encoded** value of non-secret parameters, matching the SSM standard tier. Because `JSON.stringify()` adds overhead (e.g. 2 bytes for string quotes, escaping for special characters), the effective payload capacity is slightly less than 4096 bytes of raw content. The mock enforces this by checking `Buffer.byteLength(serialized, 'utf8')` only when `!isSecret`. Secret (`SecureString`) parameters are auto-generated rather than taking a user-supplied value, so the mock does not size-check them.

## Mock Implementation

- Data stored in `.bb-data/settings/{scope.fullId}/value.json`.
- Data persists across dev server restarts. Customers can wipe with `rm -rf .bb-data`.
- `get()` returns the stored value from disk, or the initial `value` from constructor if no file exists.
- `put()` writes the value to disk immediately.
- Schema validation on `put()` when configured, throws `ValidationFailedException`.
- Validates 4 KB serialized value size limit for non-secret parameters.
- `secret: true` behaves identically to non-secret (no encryption locally).

### Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| No KMS encryption for secrets | Secret values stored in plaintext on disk | Acceptable for local dev — real credentials should not be used in mock mode. Document the gap. |
| No SSM parameter versioning | Local overwrites are not versioned | No mitigation — versioning is not exposed in the API surface |
| No throughput limits (40 TPS for GetParameter) | Code that would be throttled in AWS succeeds locally | Document the gap; recommend sandbox testing for throughput-sensitive flows |
| Immediate consistency | Reads always reflect the latest write locally | No mitigation — SSM same-region reads are strongly consistent for GetParameter, so this is actually close to parity |
| No IAM enforcement | Permission errors only surface in AWS | No mitigation at mock level — IAM is handled by CDK grants automatically |
| Disk I/O vs SSM latency | Local ops are faster and never timeout | No mitigation needed — latency differences don't affect correctness |
| No parameter policies / expiration | Settings never expire locally | No mitigation — parameter policies are an advanced SSM feature outside scope |
