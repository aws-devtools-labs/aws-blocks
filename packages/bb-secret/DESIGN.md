# Secret — Design

**Package:** `@aws-blocks/bb-secret`
**Type:** Primitive (new infrastructure)
**AWS Service:** AWS Secrets Manager

## Overview

Each `Secret` instance is one secret value. It follows the standard four-layer
conditional-export shape:

| Entry | Condition | Role |
|-------|-----------|------|
| `index.mock.ts` | `default` / `types` | Local dev + tests. Persists plaintext to `.bb-data`. Canonical implementation. |
| `index.aws.ts` | `aws-runtime` | Lambda runtime. Calls Secrets Manager via `@aws-sdk/client-secrets-manager`. |
| `index.cdk.ts` | `cdk` | Provisions the `secretsmanager.Secret`, grants IAM, registers config. |
| `index.browser.ts` | `browser` | Stub; instantiation throws `NotSupported`. |

The public API (`get`, `put`, `fromExisting`, `SecretOptions`, `ExternalSecretRef`,
`SecretErrors`) is identical across layers. `types.ts` is the single, types-only
source; `errors.ts` holds the wire-stable error names.

## Infrastructure (CDK)

`index.cdk.ts` extends `BuildingBlockScope` and requests the Secrets Manager
interface VPC endpoint (`InterfaceVpcEndpointAwsService.SECRETS_MANAGER`) so the
runtime can reach the service from inside a VPC.

For a stack-managed secret it creates one `aws-cdk-lib/aws-secretsmanager.Secret`:

- **Secret name:** derived from the instance `fullId` (`this.fullId.substring(0, 255)`).
  Names are derived, not handed off — the runtime and mock compute their own
  identifier independently.
- **Encryption:** default `aws/secretsmanager` KMS key.
- **Removal policy:** `options.removalPolicy` (`'destroy'`/`'retain'`) when set,
  otherwise the stack-wide `this.defaults.removalPolicy` (production RETAIN,
  sandbox DESTROY).
- **IAM:** grants the shared `this.executionRole` `grantRead` +
  `grantWrite` on the single secret (scoped, not a wildcard). Secrets Manager
  attaches the KMS grants for the encryption key.
- **Config:** the created secret's ARN is passed to the runtime via
  `registerConfig(this, 'BLOCKS_SECRET_ARN_<ID>', arn)` — never
  `handler.addEnvironment()` (the 4 KB Lambda env cap is managed centrally). The
  `BLOCKS_` prefix is framework-reserved.

For an **external** secret (`Secret.fromExisting(arn)` → `options.secret`) it
imports the secret with `Secret.fromSecretCompleteArn` and grants read/write to
it, but creates, seeds, and deletes nothing. `registerConfig` still records the
ARN so the runtime resolves the same identity.

The runtime data methods (`get`, `put`) are stubbed on the CDK class with
`synthGuard('Secret', …)` so calling them during synth throws an actionable
error instead of a cryptic `X is not a function`.

## Runtime (AWS)

`index.aws.ts` resolves the secret ARN in its constructor — from the
`ExternalSecretRef` when wrapping an existing secret, otherwise from the config
key `BLOCKS_SECRET_ARN_<ID>` that the CDK layer registered — and calls
`registerSdkIdentifiers(this.fullId, { secretArn })`. It resolves the ARN at
**call time** with `getSdkIdentifiers(this)`.

- `get()` → `GetSecretValueCommand`. Returns `null` when `SecretString` is
  absent **or** the secret does not exist (`ResourceNotFoundException`). A `get`
  never throws for "not found" — that is normal control flow.
- `put()` → `PutSecretValueCommand`. A `ResourceNotFoundException` maps to
  `SecretErrors.SecretNotFound` (a violated precondition — the secret must exist
  to hold a value).

The client is built with `buildUserAgentChain()` + `installClientUserAgent()`
so calls carry the framework user-agent, matching the other AWS BBs.

## Schema handling

When `options.schema` (any `StandardSchemaV1`) is provided:

- `put(value)` validates `value` via `schema['~standard'].validate(value)`
  **before** writing, then stores `JSON.stringify(value)`.
- `get()` parses the stored JSON and validates it, returning the typed value.
  Invalid JSON or a validation failure throws `SecretErrors.ValidationFailed`.

Without a schema the value is an opaque `string` stored/returned verbatim. The
schema library is never a runtime dependency of this package — it is the
consumer's choice (`zod` is a `devDependency` here, used only by tests).

## Mock ↔ AWS differences

| Aspect | Mock (`index.mock.ts`) | AWS (`index.aws.ts`) |
|--------|------------------------|----------------------|
| Storage | Plaintext file `.bb-data/{fullId}/secret` | Secrets Manager secret (encrypted) |
| ARN source | none (keyed by `fullId`) | `BLOCKS_SECRET_ARN_<ID>` config, or `fromExisting` ARN |
| Missing value | file absent → `null` | `SecretString` absent / `ResourceNotFound` → `null` |
| `put` on missing secret | always writes (creates the file) | may throw `SecretNotFound` if the secret resource is gone |
| Security | **plaintext, insecure — dev only** | KMS-encrypted at rest |

Because the mock cannot catch serialization/permission differences, behavior is
also validated by the e2e suite in `test-apps/comprehensive` against a real
sandbox and production deploy.

## Non-goals (v1)

Automatic rotation, secret versioning/staging labels, listing/enumeration,
binary secret values, customer-managed KMS keys, and cross-stack references.
These can be added as options later without breaking the current surface.
