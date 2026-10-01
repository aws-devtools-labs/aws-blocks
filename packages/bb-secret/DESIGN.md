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

- **Secret name:** `options.name` when provided (an explicit, well-known name a
  team/CI pipeline can target with the `aws` CLI), otherwise derived from the
  instance `fullId` (`.substring(0, 255)`). Names are derived, not handed off —
  the runtime resolves by the ARN the CDK layer registers, and the mock keys the
  local store by the same `name`/`fullId`.
- **Encryption:** default `aws/secretsmanager` KMS key.
- **Removal policy:** `options.removalPolicy` (`'destroy'`/`'retain'`) when set,
  otherwise the stack-wide `this.defaults.removalPolicy` (production RETAIN,
  sandbox DESTROY).
- **IAM:** grants the shared `this.executionRole` `grantRead` +
  `grantWrite` on the single secret (scoped, not a wildcard). Secrets Manager
  attaches the KMS grants for the encryption key.
- **Resource group:** the created secret is tagged
  `aws-blocks-stack=<rootStackName>` (walking to the non-nested parent stack,
  mirroring `AppSetting`), so it joins the stack's `-settings` resource group —
  the one the `/aws-blocks/settings` console redirect points at. Core's
  `-settings` group query includes `AWS::SecretsManager::Secret` alongside
  `AWS::SSM::Parameter` for this reason.
- **Config:** the created secret's ARN is passed to the runtime via
  `registerConfig(this, 'BLOCKS_SECRET_ARN_<ID>', arn)` — never
  `handler.addEnvironment()` (the 4 KB Lambda env cap is managed centrally). The
  `BLOCKS_` prefix is framework-reserved.

For an **external** secret (`Secret.fromExisting(arn)` → `options.secret`) it
imports the secret with `Secret.fromSecretCompleteArn` and grants read/write to
it, but creates, seeds, deletes, **and tags** nothing — it is owned outside this
stack (often shared across many installations), so stamping it with this stack's
resource-group tag would mutate a resource we don't own. `registerConfig` still
records the ARN so the runtime resolves the same identity.

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
  **before** writing. The AWS layer stores `JSON.stringify(value)`; the mock
  stores the structured value directly in `settings.json`.
- `get()` returns the typed value (the mock reads the structured value; the AWS
  layer `JSON.parse`s the stored string), validating it. A validation failure —
  or malformed JSON on the AWS side — throws `SecretErrors.ValidationFailed`.

Without a schema the value is an opaque `string` stored/returned verbatim. The
schema library is never a runtime dependency of this package — it is the
consumer's choice (`zod` is a `devDependency` here, used only by tests).

## Mock ↔ AWS differences

| Aspect | Mock (`index.mock.ts`) | AWS (`index.aws.ts`) |
|--------|------------------------|----------------------|
| Storage | Plaintext entry in the shared `.bb-data/settings.json` (keyed by `name`/`fullId`), alongside `AppSetting` — so the `/aws-blocks/settings` route surfaces it | Secrets Manager secret (KMS-encrypted) |
| ARN source | none (keyed by `name`/`fullId`) | `BLOCKS_SECRET_ARN_<ID>` config, or `fromExisting` ARN |
| Missing value | key absent → `null` | `SecretString` absent / `ResourceNotFound` → `null` |
| `put` on missing secret | always writes the entry | may throw `SecretNotFound` if the secret resource is gone |
| Security | **plaintext, insecure — dev only** | KMS-encrypted at rest |

Sharing `settings.json` is deliberate: it makes the single `/aws-blocks/settings`
console/editor route cover both settings and secrets, locally and when deployed.

Because the mock cannot catch serialization/permission differences, behavior is
also validated by the e2e suite in `test-apps/comprehensive` against a real
sandbox and production deploy.

## Managing values

Values are set **out-of-band**, never from source or the constructor — see the
README's "Managing secret values" for the three approaches (auto-generated, the
`/aws-blocks/settings` console route, and a well-known `name` + the `aws` CLI for
CI/CD). The CDK construct's job is name + IAM grant + runtime ARN registration;
it never carries the value.

## Non-goals (v1)

Automatic rotation, secret versioning/staging labels, listing/enumeration,
binary secret values, customer-managed KMS keys, cross-region replication
(`replicaRegions`), and copying one secret's value into another (`copyExisting`
is not a CDK concept — use `fromExisting` to reference, not duplicate). These can
be added later without breaking the current surface.
