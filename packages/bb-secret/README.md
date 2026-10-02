# Secret

A single application secret backed by AWS Secrets Manager.

**When to use:** You need to store a high-value credential — a third-party API key, OAuth client secret, database connection string, webhook signing key, or encryption key. Each `Secret` instance maps to exactly one Secrets Manager secret.

**When NOT to use:** For non-sensitive configuration (feature flags, API URLs, thresholds) use [`AppSetting`](../bb-app-setting/README.md) — it is backed by SSM Parameter Store and is free for standard parameters. For application state, use `KVStore` or `DistributedTable`.

> `Secret` (AWS Secrets Manager) vs. `AppSetting` with `secret: true` (SSM SecureString): both encrypt at rest. Reach for `Secret` when you want a dedicated Secrets Manager resource — its own resource-level access controls, cross-account resource policies, and (future) managed rotation. `AppSetting` is the lighter-weight, no-per-secret-cost option for most secrets.

> Design & mock/AWS parity details: [DESIGN.md](./DESIGN.md)

## API

```typescript
const secret = new Secret(scope, id, options?)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `get(options?)` | `Promise<T \| null>` | Read the value. `null` when unset/missing. `options.version` selects `'current'` (default), `'previous'`, or a `SecretVersion` from `listVersions()`. |
| `put(value)` | `Promise<void>` | Set or update the value at runtime. The prior value becomes the `'previous'` version. |
| `listVersions()` | `Promise<SecretVersionInfo[]>` | List retained versions (metadata only, newest first — never values). |
| `Secret.fromExisting(arn)` | `ExternalSecretRef` | Reference an existing Secrets Manager secret (static). Pass to `options.secret`. |

### Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | No | Explicit Secrets Manager secret name. When omitted, derived from the scope tree (unique per stack). Provide a well-known name when a team/CI pipeline sets or rotates the value out-of-band via the `aws` CLI. You own uniqueness across the account/region when set. Ignored for `fromExisting`. |
| `schema` | `StandardSchemaV1<T>` | No | Runtime validation schema (Zod, Valibot, ArkType). Infers `T`, treats the stored value as JSON, and validates on `get()`/`put()`. Omit for an opaque `string`. |
| `secret` | `ExternalSecretRef` | No | Wrap an existing Secrets Manager secret from `Secret.fromExisting(arn)` instead of creating one. |
| `removalPolicy` | `'destroy' \| 'retain'` | No | Override the stack-wide removal default for the created secret. Ignored by the mock and when wrapping an existing secret. |
| `logger` | `ChildLogger` | No | Optional logger for internal operations. Defaults to an error-level logger. |

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

Declare it and never set a value — Secrets Manager creates a random one on first deploy. Good for a JWT/session signing key or HMAC key, where the app generates the secret and nobody needs to read it.

```typescript
const signingKey = new Secret(scope, 'session-signing-key');

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async issueToken(userId: string) {
    const key = await signingKey.get(); // random value, created on deploy
    // sign(userId, key)...
  },
}));
```

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

Set the value once — via the settings console route, a deploy script, or the AWS CLI (see "Managing secret values"). At runtime you can also update it:

```typescript
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

AWS Blocks will not create, seed, or delete the referenced secret — it only reads and writes its value and grants the app access to it.

## Managing secret values

A `Secret` declaration carries only the *name* — never the value. How you set the value depends on how centrally the secret is managed. There are three complementary approaches:

### 1. Auto-generated (random) — no value to set

If you never call `put()` and never set a value out-of-band, the secret is created with a **random value** on first deploy. Use this for opaque values nobody needs to know — session signing keys, HMAC keys. Read it with `get()`; it is stable across redeploys.

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

- **Rotate:** set a new value (console or `put-secret-value`); the next read picks it up — no redeploy needed for runtime reads.
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

For anything deeper than the current/previous pair (full history, custom staging labels), use the AWS SDK directly against `secret.secretArn` — the BB covers the common path and leaves the raw resource reachable.

## Scaling & cost (AWS)

- **Billing:** $0.40 per secret per month (prorated hourly) + $0.05 per 10,000 API calls. No free tier.
- **Latency:** low-tens-of-ms per API call; the runtime caches the fetched value per cold start, so steady-state reads hit the cache, not the API.
- **Throughput:** GetSecretValue scales to thousands of requests/sec per account (default quotas, raisable). Reads are the hot path; `put()` is rare.
- **Value size limit:** 64 KB per secret value.
- **Version history:** current + previous are always retained; AWS keeps additional versions until there are >100 unlabeled (never removing any created in the last 24h).
- **Encryption:** KMS at rest, using the default `aws/secretsmanager` key.
- **IAM:** the construct grants the shared execution role `secretsmanager:GetSecretValue` + `PutSecretValue` scoped to the single secret (not a wildcard), plus the KMS grants Secrets Manager attaches.
- **Deletion:** recoverable by default (30-day recovery window); `--force-delete-without-recovery` to delete immediately.
- Removal policy follows the stack-wide `defaults` (production retains, sandbox destroys); override per-instance with `removalPolicy`. BB-created secrets are tagged `aws-blocks-stack=<stackName>` (join the settings resource group); `fromExisting` secrets are not tagged.

## Local development

The mock stores the current value as **plaintext** in the shared `.bb-data/settings.json` (the same file `AppSetting` uses, keyed by the secret's `name` or `fullId`) and logs a one-time warning. This is why the local `/aws-blocks/settings` route surfaces secrets alongside settings. The previous value (for `get({ version: 'previous' })` / `listVersions()`) is kept in a small `.bb-data/secret-versions.json` sidecar — current + previous only; deeper history is an AWS-only capability. It is **not** secure — never use real credentials in local development. Wipe with `rm -rf .bb-data`.

`Secret` runs server-side only. Importing and instantiating it in browser/client code throws `SecretErrors.NotSupported` — a secret read in the browser would expose it to the client.
