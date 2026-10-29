# Secret

A single application secret backed by AWS Secrets Manager.

**When to use:** You need to store a high-value credential — a third-party API key, OAuth client secret, database connection string, webhook signing key, or encryption key. Each `Secret` instance maps to exactly one Secrets Manager secret.

**When NOT to use:** For non-sensitive configuration (feature flags, API URLs, thresholds) use [`AppSetting`](../bb-app-setting/README.md) — it is free for standard values. For application state, use `KVStore` or `DistributedTable`.

> **`Secret` is the recommended home for production secrets.** For any credential that protects a production app — a database connection string, API key, OAuth token, or private key — use `Secret`. It is purpose-built for secrets: a dedicated per-secret resource with its own access controls, cross-account sharing, version history, and (future) managed rotation. This mirrors [AWS's own guidance](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html) on where credentials belong.
>
> `AppSetting` with `secret: true` also encrypts the value at rest and is free, so it is a reasonable choice for a *low-value* secret in a prototype, or when you want to avoid the per-secret cost. But for anything protecting a production app, reach for `Secret`.

> Design & mock/AWS parity details: [DESIGN.md](./DESIGN.md)

## API

```typescript
const secret = new Secret(scope, id, options?)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `get(options?)` | `Promise<T \| null>` | Read the value. `null` when unset/missing. `options.version` selects `'current'` (default), `'previous'`, or a `SecretVersion` from `listVersions()`. |
| `put(value)` | `Promise<void>` | Set or update the value at runtime. **Only present when the secret was created with `allowRuntimeWrite: true`** — otherwise it is absent from the object (and the type). The prior value becomes the `'previous'` version. |
| `listVersions()` | `Promise<SecretVersionInfo[]>` | List retained versions (metadata only, newest first — never values). |
| `Secret.fromExisting(arn)` | `ExternalSecretRef` | Reference an existing Secrets Manager secret (static). Pass to `options.secret`. |

### Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | No | Explicit Secrets Manager secret name. When omitted, derived from the scope tree (unique per stack). Provide a well-known name when a team/CI pipeline sets or rotates the value out-of-band via the `aws` CLI. You own uniqueness across the account/region when set. Ignored for `fromExisting`. |
| `allowRuntimeWrite` | `boolean` | No | **Defaults to `false`.** When `false`/omitted the secret is **read-only at runtime**: no `put()` method on the object, and the execution role gets read-only IAM (no `PutSecretValue`). Set `true` only when the app sets/rotates the value itself at runtime — then `put()` is present and write IAM is granted. Applies to every secret, including `fromExisting`. |
| `schema` | `StandardSchemaV1<T>` | No | Runtime validation schema (Zod, Valibot, ArkType). Infers `T`, treats the stored value as JSON, and validates on `get()`/`put()`. Omit for an opaque `string`. |
| `secret` | `ExternalSecretRef` | No | Wrap an existing Secrets Manager secret from `Secret.fromExisting(arn)` instead of creating one. |
| `generate` | `boolean` | No | When `true`, seed a random value on first create (for a signing/HMAC key that only needs to exist). Otherwise the secret starts empty and `get()` returns `null` until set. Don't combine with `schema`. |
| `cacheTtlSeconds` | `number` | No | How long the runtime reuses a cached value before re-fetching. **Defaults to 300s (5 min)**, matching the AWS Secrets Manager agent — a bounded default so a long-running process can't serve a rotated value indefinitely. Raise it to cut fetches, lower it for fresher reads, or set `0` to disable caching. `put()` always clears the cache. Ignored by the mock. |
| `removalPolicy` | `'destroy' \| 'retain'` | No | Override the stack-wide removal default for the created secret. Ignored by the mock and when wrapping an existing secret. |
| `logger` | `ChildLogger` | No | Optional logger for internal operations. Defaults to an error-level logger. |

### Read-only by default (`allowRuntimeWrite`)

A `Secret` is **read-only at runtime unless you opt in**. By default the instantiated object exposes only `get()` and `listVersions()` — there is no `put()` (a call is a compile error), and the deployed execution role is granted read-only IAM. This is least-privilege: most apps read a credential that is set out-of-band (console, `aws` CLI, or CI), so the running app never needs write access.

```typescript
// Read-only (default): no put(). Set the value out-of-band, read it with get().
const stripeKey = new Secret(scope, 'stripe-api-key');
const key = await stripeKey.get();
// stripeKey.put('…')  ❌ compile error — put is absent

// Writable: the app sets/rotates the value itself. put() is present; the role
// is granted PutSecretValue.
const token = new Secret(scope, 'self-rotating-token', { allowRuntimeWrite: true });
await token.put('t-abc123');
```

This also applies to a secret wrapped via `fromExisting` — it is read-only unless you pass `allowRuntimeWrite: true`.

### Error handling

```typescript
import { isBlocksError } from '@aws-blocks/core';
import { SecretErrors } from '@aws-blocks/bb-secret';

try {
  await secret.put(value);
} catch (e: unknown) {
  if (isBlocksError(e, SecretErrors.ValidationFailed)) {
    // schema validation failed
  }
  if (isBlocksError(e, SecretErrors.SecretNotFound)) {
    // the underlying Secrets Manager secret does not exist
  }
  throw e;
}
```

`get()` returns `null` for a missing value rather than throwing, so a missing secret is normal control flow, not an exception:

```typescript
const key = await stripeKey.get();
if (key === null) throw new Error('Stripe key not configured');
```

## Examples

### Auto-generated signing key (the app creates the value)

Pass `generate: true` and never set a value — Secrets Manager creates a random one on first deploy (the mock seeds an equivalent value locally). Good for a JWT/session signing key or HMAC key, where the app generates the secret and nobody needs to read it.

```typescript
const signingKey = new Secret(scope, 'session-signing-key', { generate: true });

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async issueToken(userId: string) {
    const key = await signingKey.get(); // random value, created on first deploy
    // sign(userId, key)...
  },
}));
```

> Without `generate: true`, a BB-created secret starts **empty**: `get()` returns `null` until a value is set. Don't combine `generate` with `schema` — a random string isn't valid JSON.

### Manually-configured credential (you set an externally-issued value)

A third-party key (Stripe, an OAuth client secret) is **not** auto-generated — you set it out-of-band after deploy. The declaration is the same; the difference is that someone provides the value.

```typescript
const stripeKey = new Secret(scope, 'stripe-api-key');

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async charge(amount: number) {
    const key = await stripeKey.get();
    if (key === null) throw new Error('Stripe key not configured');
    // use key...
  },
}));
```

Set the value once — via the settings console route, a deploy script, or the AWS CLI (see "Managing secret values"). If the app itself updates the value at runtime, create the secret with `allowRuntimeWrite: true` and call `put()`:

```typescript
const stripeKey = new Secret(scope, 'stripe-api-key', { allowRuntimeWrite: true });
await stripeKey.put('sk_live_...');
```

### Typed JSON secret with schema validation

```typescript
import { z } from 'zod';

const dbConfig = new Secret(scope, 'db-config', {
  schema: z.object({ host: z.string(), port: z.number() }),
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async connect() {
    const config = await dbConfig.get(); // { host: string; port: number } | null
    if (config === null) throw new Error('DB config not set');
    // connect(config.host, config.port)...
  },
}));
```

### Wrap an existing secret

```typescript
const legacy = new Secret(scope, 'legacy-key', {
  secret: Secret.fromExisting('arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-AbCdEf'),
});
const value = await legacy.get();
```

AWS Blocks will not create, seed, or delete the referenced secret — it only reads its value (and writes it when `allowRuntimeWrite: true`) and grants the app access.

## Managing secret values

A `Secret` declaration carries only the *name* — never the value. How you set the value depends on how centrally the secret is managed. There are three complementary approaches:

### 1. Auto-generated (random) — no value to set

Pass `generate: true` and never call `put()`: the secret is created with a **random value** on first deploy (the mock seeds an equivalent value locally). Use this for opaque values nobody needs to know — session signing keys, HMAC keys. Read it with `get()`; it is stable across redeploys. Without `generate: true` the secret starts empty and `get()` returns `null` until you set a value.

### 2. Set via the settings endpoint → console — the default for most apps

Every AWS Blocks app exposes a built-in **`/aws-blocks/settings`** route. Deployed, it redirects to the stack's *settings* resource group in the AWS console, where your `Secret` values appear alongside your `AppSetting` parameters — set or rotate them in the console UI. Locally, the same route opens `.bb-data/settings.json`, where secret values live next to settings (plaintext, dev-only). One route, one place, local and deployed.

### 3. Well-known `name` + the `aws` CLI — for CI/CD-driven workflows

If your deployment model is scripted, give the secret an explicit, stable `name` and set/rotate it with the standard AWS CLI. The value travels machine → Secrets Manager over the AWS API; it never enters source, git, or the CloudFormation template.

```typescript
const stripeKey = new Secret(scope, 'stripe-key', { name: 'my-app/stripe-key' });
```

```bash
# Set / rotate — value over stdin, never argv or shell history.
printf '%s' "$STRIPE_KEY" \
  | aws secretsmanager put-secret-value \
      --secret-id my-app/stripe-key \
      --secret-string file:///dev/stdin \
      --region us-east-1

# Inspect (metadata only; the value requires explicit get-secret-value perms).
aws secretsmanager describe-secret --secret-id my-app/stripe-key
```

The Blocks app **creates** the secret (empty/random) when you deploy, so the value is set against a secret that already exists — run the CLI once the secret exists. The exact sequencing in your pipeline is up to you. Re-running `put-secret-value` overwrites (rotation); the next cold start reads the new value. Write to the **same region** the app deploys to, or reads see an unset secret.

Without an explicit `name`, the secret name is derived from the scope tree; find it in the settings resource group, the console, or `aws secretsmanager list-secrets`.

### Rotating & removing

- **Rotate:** set a new value (console or `put-secret-value`); a warm runtime that already cached the old value picks up the change on its next cold start — no redeploy needed. (A `put()` from within the app clears that instance's cache immediately.)
- **Remove:** `aws secretsmanager delete-secret --secret-id <name>` (recoverable by default; `--force-delete-without-recovery` to skip the recovery window).

### Which approach, when

| Scenario | Approach |
|----------|----------|
| Centrally-managed credential shared across **many** app installations | `fromExisting(arn)` — reference it; the app never owns or sets it |
| A normal app, set the value once after deploy | **Settings endpoint → console** (approach 2) |
| Scripted / CI/CD-driven provisioning | Well-known `name` + `aws` CLI (approach 3) |
| An opaque value nobody needs to read | Auto-generated (approach 1) |

> There is intentionally **no** way to seed a secret's value from source code or an environment variable through the constructor — a literal in source would land in git and the template, and env-seeding is kept out of the declaration (consistent with how hosting `secret()` separates *declare* from *set*). Set values out-of-band via the console or CLI.

## Reading an earlier version (rotation grace window)

Each change keeps the prior value available as the **previous** version. This is useful during a key rollout: validate against both the new and the old value for a grace period.

```typescript
const current  = await signingKey.get();                       // live value
const previous = await signingKey.get({ version: 'previous' }); // value before the last change, or null
// verify(token, current) || (previous !== null && verify(token, previous))
```

`get({ version: 'previous' })` returns `null` until the secret has been changed at least once. To browse the retained versions (metadata only — never values), use `listVersions()` and pass a returned item straight back to `get()`:

```typescript
const versions = await signingKey.listVersions();
// [{ versionId, stages: ['AWSCURRENT'], createdDate }, { versionId, stages: ['AWSPREVIOUS'], createdDate }]
const value = await signingKey.get({ version: versions[1] });  // read a specific version
```

For anything deeper than the current/previous pair (full history, custom staging labels, reading by an arbitrary id), use the AWS SDK directly against the secret — the BB covers the common path and leaves the raw resource reachable. The secret's ARN is exposed on the **CDK construct** (`secret.secretArn`, available at synth) — pass it where you build the SDK client; the runtime/mock classes deliberately don't expose AWS primitives.

## Scaling & cost (AWS)

- **Billing:** $0.40 per secret per month (prorated hourly) + $0.05 per 10,000 API calls. No free tier.
- **Latency:** low-tens-of-ms per API call; the runtime caches the fetched value in-process, so steady-state reads hit the cache, not the API. A cached value is held for `cacheTtlSeconds` — **default 5 minutes** (matching the AWS Secrets Manager agent) — so a rotated value is picked up within the TTL even on a long-running process; raise it to cut fetches, or set `0` to disable caching.
- **Throughput:** GetSecretValue scales to thousands of requests/sec per account (default quotas, raisable). Reads are the hot path; `put()` is rare.
- **Value size limit:** 64 KB per secret value.
- **Version history:** `listVersions()` returns the **labeled** versions — current + previous. Secrets Manager retains additional unlabeled versions internally (until >100, never removing any created in the last 24h), but the BB surfaces only current/previous; reach for the AWS SDK for deeper history.
- **Encryption:** KMS at rest, using the default `aws/secretsmanager` key.
- **IAM:** the construct grants the shared execution role `secretsmanager:GetSecretValue` + `ListSecretVersionIds` scoped to the single secret (not a wildcard). `PutSecretValue` is granted **only** when `allowRuntimeWrite: true` — the default is read-only. KMS grants Secrets Manager attaches as needed.
- **Deletion:** recoverable by default (30-day recovery window); `--force-delete-without-recovery` to delete immediately.
- Removal policy follows the stack-wide `defaults` (production retains, sandbox destroys); override per-instance with `removalPolicy`. BB-created secrets are tagged `aws-blocks-stack=<stackName>` (join the settings resource group); `fromExisting` secrets are not tagged.

## Local development

The mock stores the current value as **plaintext** in the shared `.bb-data/settings.json` (the same file `AppSetting` uses, keyed by the secret's `name` or `fullId`) and logs a one-time warning. This is why the local `/aws-blocks/settings` route surfaces secrets alongside settings. The previous value (for `get({ version: 'previous' })` / `listVersions()`) is kept in a small `.bb-data/secret-versions.json` sidecar — current + previous only; deeper history is an AWS-only capability. It is **not** secure — never use real credentials in local development. Wipe with `rm -rf .bb-data`.

`Secret` runs server-side only. Importing and instantiating it in browser/client code throws `SecretErrors.NotSupported` — a secret read in the browser would expose it to the client.

## Keys AWS Blocks generates for its own blocks

Keys that AWS Blocks generates for its own blocks are created through this package's internal `@aws-blocks/bb-secret/internal` entry point. Where they are stored follows the stack's `defaults.secretsStore`: a `Secret` in Secrets Manager (`'secrets-manager'`, the production preset) or an `AppSetting` SSM SecureString (`'ssm'`, the sandbox preset). Today this covers the `Realtime` connection token key; other generated keys will move to it. That entry point is for AWS Blocks' own blocks only and is not a public API; it does not change the defaults of a `Secret` you declare.
