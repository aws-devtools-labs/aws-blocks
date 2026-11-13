# Secret

A single application secret backed by AWS Secrets Manager.

**When to use:** You need to store a high-value credential — a third-party API key, OAuth client secret, database connection string, webhook signing key, or encryption key. Each `Secret` instance maps to exactly one Secrets Manager secret.

**When NOT to use:** For non-sensitive configuration (feature flags, API URLs, thresholds) use [`AppSetting`](../bb-app-setting/README.md) — it is free for standard values. For application state, use `KVStore` or `DistributedTable`.

> **`Secret` is the recommended home for production secrets.** For any credential that protects a production app — a database connection string, API key, OAuth token, or private key — use `Secret`. It is purpose-built for secrets: a dedicated per-secret resource with its own access controls, cross-account sharing, and version history. This mirrors [AWS's own guidance](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html) on where credentials belong.
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
import { Secret, SecretErrors } from '@aws-blocks/bb-secret';

const secret = new Secret(scope, 'api-key', { allowRuntimeWrite: true });

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

A `ValidationFailed` error's message is fixed and never contains the secret value or the schema library's issue text, because schema libraries often quote the received value and the message reaches the client. It doesn't name the failing field either, because a record or map schema reports the value's own keys as the path: the message is always `ValidationFailedException: The secret value did not match the schema`. The original issues and the first failing path stay on the error's non-enumerable `cause` (`cause.issues`, `cause.path`) for server-side logging.

`get()` returns `null` for a missing value rather than throwing, so a missing secret is normal control flow, not an exception:

```typescript
const key = await stripeKey.get();
if (key === null) throw new Error('Stripe key not configured');
```

On AWS that `null` is cached like any other value, so a value set afterwards is seen once the cache entry expires (`cacheTtlSeconds`).

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
>
> If the app also rotates the key itself, add `allowRuntimeWrite: true` and call `put()` with the new key — see [Reading an earlier version](#reading-an-earlier-version-rotation-grace-window) for the complete pattern.

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

The Blocks app **creates** the secret (empty/random) when you deploy, so the value is set against a secret that already exists — run the CLI once the secret exists. The exact sequencing in your pipeline is up to you. Re-running `put-secret-value` overwrites (rotation); running instances pick up the new value once their cached copy expires (`cacheTtlSeconds`, default 300 s). Write to the **same region** the app deploys to, or reads see an unset secret.

Without an explicit `name`, the secret name is derived from the scope tree; find it in the settings resource group, the console, or `aws secretsmanager list-secrets`.

### As an `Auth` provider secret

A string-valued `Secret` can be the `clientSecret` (or Sign in with Apple's `privateKey`) of an `Auth` provider. For a provider that federates through Cognito (a social or `type: 'oidc'` entry on `Auth`'s default store), the deploy reads the value and registers it with the user pool, so set the value and **deploy again** for a new value to take effect — and give the secret `generate: true`, so the first deploy has a placeholder value to register. See the `Auth` README's social sign-in recipe (`@aws-blocks/bb-auth`).

### Rotating & removing

- **Rotate:** set a new value (console or `put-secret-value`); a warm runtime that already cached the old value picks up the change once its cache entry expires (`cacheTtlSeconds`, default 300 s) — no redeploy needed. (A `put()` from within the app clears that instance's cache immediately.)
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

A key the app generates and rotates itself is **one** `Secret` with `generate: true` (so it has a value from the start) and `allowRuntimeWrite: true` (so the app can `put()` the next key). Rotate it from a scheduled job rather than from an API method, and accept signatures made with either the current or the previous key:

```typescript
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CronJob } from '@aws-blocks/bb-cron-job';
import { KVStore, KVStoreErrors } from '@aws-blocks/bb-kv-store';
import { Secret } from '@aws-blocks/bb-secret';
import { isBlocksError } from '@aws-blocks/core';

const signingKey = new Secret(scope, 'signing-key', { generate: true, allowRuntimeWrite: true });
const rotations = new KVStore(scope, 'signing-key-rotations'); // one marker per tick, never key material

// put() makes the new key current and keeps the replaced one as the 'previous' version.
new CronJob(scope, 'rotate-signing-key', {
  schedule: 'rate(7 days)',
  handler: async (event) => {
    // A tick can be delivered more than once and only one previous version is kept.
    // Claim the tick first: the conditional write succeeds for exactly one delivery.
    try {
      await rotations.put(event.scheduledTime, 'rotated', { ifNotExists: true });
    } catch (e: unknown) {
      if (isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)) return; // another delivery claimed this tick
      throw e;
    }
    await signingKey.put(randomBytes(32).toString('hex'));
  },
});

function matches(payload: string, signature: string, key: string | null): boolean {
  if (key === null) return false;
  const expected = Buffer.from(createHmac('sha256', key).update(payload).digest('hex'));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// Call from your request handlers. Signatures made with the previous key stay valid until the next rotation.
async function isValidSignature(payload: string, signature: string): Promise<boolean> {
  const current = await signingKey.get();
  const previous = await signingKey.get({ version: 'previous' }); // null until the first rotation
  return matches(payload, signature, current) || matches(payload, signature, previous);
}
```

The handler claims the tick before it rotates because a `CronJob` handler must be idempotent: a tick can be delivered more than once, and a failed tick is retried. Without the claim, a second `put()` for the same tick would replace the previous version with the key from the first `put()`, and signatures made with the key that was current before the tick would stop verifying. A repeated delivery carries the same `scheduledTime`, and a `KVStore` `put()` with `ifNotExists` is one conditional write, so only one delivery of a tick gets past it. If the secret's `put()` then fails, that tick is skipped rather than retried and the next tick rotates; until then the current and previous keys both stay valid. The `rotations` store holds only the tick's timestamp, one small item per tick.

Keep the old key as this previous version — `put()` retains it for you. Don't pack `{ current, previous }` into one JSON value (the secret's value is then no longer the key, and every reader has to unpack it), and don't copy old keys into a `KVStore`, table or second `Secret` (that spreads key material into stores without the secret's access controls).

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

The mock has no cache: every `get()` reads `.bb-data/settings.json` again, so a value written to that file reaches the next call without a restart. The key is the secret's `name` when you pass one, otherwise its `fullId` (for example `new Secret(new Scope('my-app'), 'stripe-key')` is stored under `my-app-stripe-key`). To simulate an externally set secret in a local test, add the value under that key, keeping the entries already in the file — for the secret declared with `{ name: 'my-app/stripe-key' }` above:

```json
{ "my-app/stripe-key": "sk_test_123" }
```

Delete the key to simulate an unset secret (`get()` returns `null`). A value written this way replaces only the current value — it is not recorded as a version, so to exercise `get({ version: 'previous' })` locally, rotate with `put()`. A `generate: true` secret seeds its random value only when its key is absent, so a value you write before the backend starts is kept.

`Secret` runs server-side only. Importing and instantiating it in browser/client code throws `SecretErrors.NotSupported` — a secret read in the browser would expose it to the client.

## Keys AWS Blocks generates for its own blocks

Keys that AWS Blocks generates for its own blocks are created through an internal part of this package. Where they are stored follows the stack's `defaults.secretsStore`: a `Secret` in Secrets Manager (`'secrets-manager'`, the production preset) or an `AppSetting` SSM SecureString (`'ssm'`, the sandbox preset). This covers the `Auth` session secret and the `Realtime` connection token key. That internal part is for AWS Blocks' own blocks only and is not a public API; it does not change the defaults of a `Secret` you declare.
