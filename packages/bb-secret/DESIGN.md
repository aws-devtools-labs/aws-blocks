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

`index.aws.ts` captures the construct `id` and any `ExternalSecretRef` in its
constructor and resolves the secret ARN at **call time** via `resolveSecretArn()`
— from the `ExternalSecretRef` when wrapping an existing secret, otherwise from
the config key `BLOCKS_SECRET_ARN_<ID>` the CDK layer registered. Deferring to
call time keeps the constructor side-effect-free w.r.t. config, so instantiating
a Secret during CDK synth / client-spec generation (where the Lambda config env
is absent) never throws.

- `get(options?)` → `GetSecretValueCommand`. The `options.version` selector maps
  to the SDK version params: `'current'`/omitted → `AWSCURRENT`; `'previous'` →
  `VersionStage: 'AWSPREVIOUS'`; a `SecretVersion` → its `VersionId`. Returns
  `null` when `SecretString` is absent **or** the secret/version does not exist
  (`ResourceNotFoundException`). A `get` never throws for "not found" — normal
  control flow.
- `put()` → `PutSecretValueCommand`. A `ResourceNotFoundException` maps to
  `SecretErrors.SecretNotFound` (a violated precondition — the secret must exist
  to hold a value). Secrets Manager advances the `AWSCURRENT`/`AWSPREVIOUS`
  labels automatically on each put, so the prior value becomes `'previous'`.
- `listVersions()` → `ListSecretVersionIdsCommand` (paginated, `IncludeDeprecated:
  false`), mapped to `SecretVersionInfo[]` (versionId + staging labels + created
  date — never values) and sorted newest-first.

The client is built with `buildUserAgentChain()` + `installClientUserAgent()`
so calls carry the framework user-agent, matching the other AWS BBs.

## Version retrieval & extensibility

The read surface is designed to grow without breaking:

- `get(options?: { version?: 'current' | 'previous' | SecretVersion })` — an
  options object, so new fields are additive.
- `SecretVersion` is the minimal handle (`{ versionId }`) `get()` consumes;
  `SecretVersionInfo extends SecretVersion` (adds `stages`, `createdDate`) is
  what `listVersions()` produces. The consumer takes the base, the producer emits
  the richer subtype — so a `listVersions()` item passes straight to `get()`.
- A raw `versionId` is never a string input; it only ever travels inside a
  `SecretVersion` obtained from `listVersions()`, so callers can't fabricate ids.

Deeper access (reading by arbitrary id outside the retained window, custom
staging labels, full history) is intentionally **not** proxied — use the AWS SDK
against `secret.secretArn`. If a real need appears, add optional fields to
`SecretReadOptions` and/or widen `SecretVersionInfo` — both non-breaking.

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
| Version history | current + previous, in a `.bb-data/secret-versions.json` sidecar (synthetic version ids) | full retained history in Secrets Manager (real version ids + staging labels) |
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

- **Automatic rotation.** Managed rotation is credential-type-specific (AWS only
  ships hosted rotators for database engines), so a generic `Secret` doesn't
  expose a rotation flag. Rotate by setting a new value (`put()`/console/CLI) —
  the prior value stays readable via `get({ version: 'previous' })` — and for a
  custom schedule drive `put()` from a `CronJob`.
- **Deeper version access.** `get({ version })` + `listVersions()` cover
  current/previous and browsing retained versions; reading by an arbitrary id
  outside that, custom staging labels, or manipulating versions is left to the
  AWS SDK against `secret.secretArn` (and can be added as additive
  `SecretReadOptions` fields later).
- Binary secret values, customer-managed KMS keys, cross-region replication
  (`replicaRegions`), and copying one secret into another (`copyExisting` is not
  a CDK concept — use `fromExisting` to reference, not duplicate).

All of the above can be added later without breaking the current surface.
