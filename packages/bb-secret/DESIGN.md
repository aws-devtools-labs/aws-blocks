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

The public read API (`get`, `listVersions`, `fromExisting`, `SecretOptions`,
`ExternalSecretRef`, `SecretErrors`) is identical across layers. `put` is
**conditional** (see below). `types.ts` is the single, types-only source;
`errors.ts` holds the wire-stable error names.

## Read-only by default (`allowRuntimeWrite`)

A `Secret` is read-only at runtime unless `allowRuntimeWrite: true`. This is
enforced at three levels so the type, the object, and the IAM all agree:

- **Type** — `Secret<T>` is `Omit<SecretImpl<T>, 'put'>` (no `put`). The public
  `Secret` is a `SecretConstructor` with overloaded `new`: the overload whose
  options include `allowRuntimeWrite: true` returns `WritableSecret<T>` (adds
  `put`), the other returns the read-only `Secret<T>`. `SecretImpl` is not
  exported; `Secret` is a `const` bound to it via a single internal cast (a class
  can't narrow its own constructor return type per-overload).
- **Object** — `put` is `declare`d (no field emit), then assigned in the
  constructor **only** when `allowRuntimeWrite === true`. So on a read-only
  secret `'put' in secret` is `false` — the method is genuinely absent, not a
  thrower.
- **IAM** — the CDK layer grants `grantWrite` only when `allowRuntimeWrite ===
  true` (see Infrastructure below).

The runtime write logic lives in a private `#put`; the public `put` (when
present) delegates to it. The mock and aws layers mirror this exactly.

## When to use `Secret` vs `AppSetting(secret: true)`

Two blocks can hold an encrypted value, backed by different AWS services:

- **`Secret`** → **AWS Secrets Manager**. A dedicated per-secret resource with
  resource-level access controls, cross-account resource policies, cross-region
  replication, built-in version staging (`AWSCURRENT`/`AWSPREVIOUS`), and
  (future) managed rotation. Costs ~$0.40/secret/month + API calls.
- **`AppSetting(secret: true)`** → **SSM Parameter Store SecureString**. KMS-
  encrypted at rest, free for standard parameters, but no per-secret resource
  policy, no cross-region replication, and no rotation.

AWS's own guidance is that credentials belong in Secrets Manager: the Parameter
Store docs state that for secrets such as database credentials, API keys, or
tokens, AWS recommends Secrets Manager
([*Where should I store my application data?*](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html)).
So the customer-facing recommendation is: **`Secret` for production secrets;
`AppSetting(secret: true)` only as a free, encrypted fallback for a low-value
secret** (e.g. a prototype). The user-facing docs phrase this in Blocks terms
(`Secret` / `AppSetting`) and link out to that AWS page rather than naming the
services inline.

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
- **Empty by default:** the L2 `Secret` construct otherwise emits
  `GenerateSecretString: {}`, seeding a random 32-char value — so a never-set
  `get()` would return that string instead of `null`, breaking the
  configure-after-deploy contract and diverging from the mock. The construct
  removes that property (`addPropertyDeletionOverride('GenerateSecretString')`),
  creating an **empty** secret (CloudFormation treats a secret with neither
  `GenerateSecretString` nor `SecretString` as empty → no `SecretString` on read
  → `null`). `generate: true` keeps the generator for secrets that only need to
  exist (signing/HMAC keys); the mock seeds an equivalent random value so the two
  layers match.
- **Encryption:** default `aws/secretsmanager` KMS key.
- **Removal policy:** `options.removalPolicy` (`'destroy'`/`'retain'`) when set,
  otherwise the stack-wide `this.defaults.removalPolicy` (production RETAIN,
  sandbox DESTROY).
- **IAM:** grants the shared `this.executionRole` `grantRead` + `ListSecretVersionIds` on
  the single secret (scoped, not a wildcard). `grantWrite` (`PutSecretValue`) is
  added **only** when `options.allowRuntimeWrite === true` — the default is
  read-only, matching the runtime object, which exposes no `put()` unless writes
  are opted in. Secrets Manager attaches the KMS grants for the encryption key.
- **Resource group:** the created secret is tagged
  `aws-blocks-stack=<rootStackName>` (walking to the non-nested parent stack,
  mirroring `AppSetting`), so it joins the stack's `-settings` resource group —
  the one the `/aws-blocks/settings` console redirect points at. Core's
  `-settings` group query includes `AWS::SecretsManager::Secret` alongside
  `AWS::SSM::Parameter` for this reason.
- **Config:** the created secret's ARN is passed to the runtime via
  `registerConfig(this, 'BLOCKS_SECRET_ARN_<FULLID>', arn)` — never
  `handler.addEnvironment()` (the 4 KB Lambda env cap is managed centrally). The
  key is derived from the scoped `fullId`, not the bare construct `id`, so two
  secrets with the same `id` in different scopes (per-tenant) get distinct keys
  instead of silently colliding on one ARN. The `BLOCKS_` prefix is
  framework-reserved.

For an **external** secret (`Secret.fromExisting(arn)` → `options.secret`) it
imports the secret with `Secret.fromSecretCompleteArn` and grants read to it
(plus write only when `allowRuntimeWrite: true`), but creates, seeds, deletes, **and tags** nothing — it is owned outside this
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
the config key `BLOCKS_SECRET_ARN_<FULLID>` the CDK layer registered. Deferring to
call time keeps the constructor side-effect-free w.r.t. config, so instantiating
a Secret during CDK synth / client-spec generation (where the Lambda config env
is absent) never throws.

- `get(options?)` → `GetSecretValueCommand`. The `options.version` selector maps
  to the SDK version params: `'current'`/omitted → `AWSCURRENT`; `'previous'` →
  `VersionStage: 'AWSPREVIOUS'`; a `SecretVersion` → its `VersionId`. Returns
  `null` when `SecretString` is absent **or** the secret/version does not exist
  (`ResourceNotFoundException`). A `get` never throws for "not found" — normal
  control flow. The fetched raw value is cached in-process per instance, keyed by
  version selector (`current` / `previous` / `v:<versionId>`), so steady-state
  reads skip the API; the schema (if any) is still applied on every call, so a
  validation error is never cached. `put()` clears the cache. A cached entry is
  held for `cacheTtlSeconds` (from `SecretOptions`), **defaulting to 300s (5
  minutes)** — the same default as the AWS Secrets Manager agent / Lambda
  Parameters and Secrets extension; `0` disables caching, a larger value cuts
  fetches. **Why a bounded default:** the cache is per-instance, and a `Secret`
  instance is constructed once per process and reused for that process's whole
  life. Under request-scoped compute (Lambda) that is a short, self-healing
  window; under long-running compute (a container-backed process alive for
  hours/days handling many requests, as the multi-compute / long-running
  async-job work introduces) an *unbounded* cache would let a rotated secret go
  unnoticed until redeploy — a stale-credential hazard. The 5-minute default
  bounds that staleness everywhere without the caller having to think about it;
  the TTL only governs out-of-band changes, since an in-process `put()` clears
  the cache immediately. This mirrors the hosting value API's `getSecret` cache.
- `put()` → `PutSecretValueCommand`. A `ResourceNotFoundException` maps to
  `SecretErrors.SecretNotFound` (a violated precondition — the secret must exist
  to hold a value). Secrets Manager advances the `AWSCURRENT`/`AWSPREVIOUS`
  labels automatically on each put, so the prior value becomes `'previous'`. On
  success it clears the instance read cache (a write invalidates `current`,
  `previous`, and any specific-version entries), so a later `get()` re-fetches.
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
- `SecretVersion` is a plain structural handle; the intended source is
  `listVersions()`, but a hand-built `{ versionId }` also type-checks. A
  non-existent id is harmless — it simply reads back as `null`.

Deeper access (reading by arbitrary id outside the labeled window, custom
staging labels, full history) is intentionally **not** proxied — use the AWS SDK
against the secret ARN (exposed on the CDK construct as `secret.secretArn`; the
runtime/mock classes don't expose AWS primitives). If a real need appears, add
optional fields to `SecretReadOptions` and/or widen `SecretVersionInfo` — both
non-breaking.

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
| ARN source | none (keyed by `name`/`fullId`) | `BLOCKS_SECRET_ARN_<FULLID>` config, or `fromExisting` ARN |
| Unset value | key absent → `null`; `generate: true` seeds a random 32-char value on first construction | empty secret (neither `GenerateSecretString` nor `SecretString`) → `GetSecretValue` has no `SecretString` → `null`; `generate: true` emits `GenerateSecretString` so a random value exists on deploy |
| Missing value | key absent → `null` | `SecretString` absent / `ResourceNotFound` → `null` |
| `put` on missing secret | always writes the entry | may throw `SecretNotFound` if the secret resource is gone |
| Version history | current + previous, in a `.bb-data/secret-versions.json` sidecar (synthetic version ids) | current + previous via `ListSecretVersionIds` with `IncludeDeprecated: false` (labeled only — real version ids + staging labels) |
| Read caching | none — every `get()` reads fresh from `settings.json` (so `cacheTtlSeconds` is a no-op) | per-instance in-memory cache keyed by version selector, cleared by `put()`; entries held for `cacheTtlSeconds` (default 300s, `0` disables) so steady-state reads skip the API |
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
