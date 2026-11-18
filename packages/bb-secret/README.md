# Secret

A single application secret backed by AWS Secrets Manager.

**When to use:** You need to store a high-value credential — a third-party API key, OAuth client secret, database connection string, webhook signing key, or encryption key. Use `Secret` for any credential that protects a production app.

**When NOT to use:** For non-sensitive configuration (feature flags, API URLs, thresholds) use [`AppSetting`](../bb-app-setting/README.md) — it is free for standard values. For a low-value secret in a prototype, `AppSetting` with `secret: true` is free and encrypts the value at rest. For application state, use `KVStore`.

> Design & mock/AWS parity details: [DESIGN.md](./DESIGN.md)

## Quick start

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

The secret starts empty. Set the value after deploy: see [Managing secret values](#managing-secret-values).

## API

```typescript
const secret = new Secret(scope, id, options?)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `get(options?)` | `Promise<T \| null>` | Read the value. `null` when unset/missing. `options.version` selects `'current'` (default), `'previous'`, or a `SecretVersion` from `listVersions()`. |
| `put(value)` | `Promise<void>` | Set or update the value at runtime. Present only when the secret was created with `allowRuntimeWrite: true`; otherwise it is absent from the object and the type. The prior value becomes the `'previous'` version. |
| `listVersions()` | `Promise<SecretVersionInfo[]>` | List retained versions (metadata only, newest first — never values). |
| `Secret.fromExisting(arn)` | `ExternalSecretRef` | Reference an existing Secrets Manager secret (static). Pass to `options.secret`. |

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | derived from the scope tree | Explicit Secrets Manager secret name. The default is unique per stack. Provide a well-known name when a team/CI pipeline sets or rotates the value out-of-band via the `aws` CLI. You own uniqueness across the account/region when set. Ignored for `fromExisting`. |
| `allowRuntimeWrite` | `boolean` | `false` | When `false` the secret is read-only at runtime: no `put()` method on the object, and the execution role gets read-only IAM (no `PutSecretValue`). Set `true` only when the app sets/rotates the value itself at runtime — then `put()` is present and write IAM is granted. Applies to every secret, including `fromExisting`. |
| `schema` | `StandardSchemaV1<T>` | — | Runtime validation schema (Zod, Valibot, ArkType). Infers `T`, treats the stored value as JSON, and validates on `get()`/`put()`. Omit for an opaque `string`. |
| `secret` | `ExternalSecretRef` | — | Wrap an existing Secrets Manager secret from `Secret.fromExisting(arn)` instead of creating one. |
| `generate` | `boolean` | `false` | When `true`, seed a random value on first create (for a signing/HMAC key that only needs to exist). Otherwise the secret starts empty and `get()` returns `null` until set. Don't combine with `schema`. |
| `cacheTtlSeconds` | `number` | `300` | Seconds the runtime reuses a cached value before re-fetching. `0` disables caching. `put()` clears the cache. Ignored by the mock. |
| `removalPolicy` | `'destroy' \| 'retain'` | stack `defaults` | Override the stack-wide removal default for the created secret. Ignored by the mock and when wrapping an existing secret. |
| `logger` | `ChildLogger` | error-level logger | Logger for internal operations. |

### Read-only by default (`allowRuntimeWrite`)

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

## Errors

Match an error by name with `isBlocksError`:

```typescript
import { isBlocksError } from '@aws-cdk-blocks/core';
import { SecretErrors } from '@aws-cdk-blocks/bb-secret';
```

| Constant | `error.name` | Thrown when |
|----------|--------------|-------------|
| `SecretErrors.ValidationFailed` | `ValidationFailedException` | With a `schema`: `put()` is given a value that fails the schema, or `get()` reads a stored value that fails the schema or is not valid JSON. |
| `SecretErrors.SecretNotFound` | `ResourceNotFoundException` | `put()` on AWS: the Secrets Manager secret does not exist. |
| `SecretErrors.NotSupported` | `NotSupportedException` | `Secret` is instantiated in browser/client code (it runs server-side only), or a deployed `Secret` has no registered secret ARN. |

- `get()` returns `null` for a missing value; it does not throw. On AWS that `null` is cached like any other value, so a value set afterwards is seen once the cache entry expires (`cacheTtlSeconds`).
- A schema failure's message is always `ValidationFailedException: The secret value did not match the schema`. It never contains the secret value, the failing field or the schema library's issue text. The original issues and the first failing path are on the error's non-enumerable `cause` (`cause.issues`, `cause.path`) for server-side logging.

## Examples

### Auto-generated signing key (the app creates the value)

Use `generate: true` for a JWT/session signing key or HMAC key that nobody needs to read.

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

AWS CDK Blocks will not create, seed, or delete the referenced secret — it only reads its value (and writes it when `allowRuntimeWrite: true`) and grants the app access.

## Managing secret values

The declaration never holds the value: the constructor takes none, and a secret cannot be seeded from source code or an environment variable. Set the value one of these ways:

| Scenario | Approach |
|----------|----------|
| An opaque value nobody needs to read | `generate: true` — nothing to set; the value is stable across redeploys |
| A normal app, set the value once after deploy | [Settings route and console](#settings-route-and-console) |
| Scripted / CI/CD-driven provisioning | [Well-known `name` and the `aws` CLI](#well-known-name-and-the-aws-cli) |
| Centrally-managed credential shared across many app installations | `fromExisting(arn)` — reference it; the app never owns or sets it |

### Settings route and console

Every AWS CDK Blocks app exposes a built-in `/cdk-blocks/settings` route. Deployed, it redirects to the stack's *settings* resource group in the AWS console, where your `Secret` values appear alongside your `AppSetting` parameters — set or rotate them in the console UI. Locally, the same route opens `.bb-data/settings.json`, where secret values live next to settings (plaintext, dev-only).

### Well-known `name` and the `aws` CLI

Give the secret an explicit, stable `name` and set/rotate it with the standard AWS CLI.

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

- Run the CLI after the first deploy: the deploy creates the secret.
- Re-running `put-secret-value` overwrites the value. Running instances pick up the new value once their cached copy expires (`cacheTtlSeconds`).
- Write to the same region the app deploys to, or reads see an unset secret.

Without an explicit `name`, the secret name is derived from the scope tree; find it in the settings resource group, the console, or `aws secretsmanager list-secrets`.

### As an `Auth` provider secret

A string-valued `Secret` can be the `clientSecret` (or Sign in with Apple's `privateKey`) of an `Auth` provider. For a provider that federates through Cognito (a social or `type: 'oidc'` entry on `Auth`'s default store), the deploy reads the value and registers it with the user pool:

1. Declare the secret with `generate: true`, so the first deploy has a placeholder value to register.
2. Deploy.
3. Set the value.
4. Deploy again. A new value takes effect only after a deploy.

See the `Auth` README's social sign-in recipe (`@aws-cdk-blocks/bb-auth`).

### Rotating & removing

- **Rotate:** set a new value (console, `put-secret-value`, or `put()` from within the app). No redeploy is needed. A running instance that cached the old value reads the new one once its cache entry expires (`cacheTtlSeconds`); `put()` clears the cache of the instance that calls it only.
- **Remove:** `aws secretsmanager delete-secret --secret-id <name>` (recoverable for 30 days by default; `--force-delete-without-recovery` to skip the recovery window).

## Reading an earlier version (rotation grace window)

Each change keeps the prior value available as the **previous** version. This is useful during a key rollout: validate against both the new and the old value for a grace period.

A key the app generates and rotates itself is **one** `Secret` with `generate: true` (so it has a value from the start) and `allowRuntimeWrite: true` (so the app can `put()` the next key). Rotate it from a scheduled job rather than from an API method, and accept signatures made with either the current or the previous key:

```typescript
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CronJob } from '@aws-cdk-blocks/bb-cron-job';
import { KVStore, KVStoreErrors } from '@aws-cdk-blocks/bb-kv-store';
import { Secret } from '@aws-cdk-blocks/bb-secret';
import { isBlocksError } from '@aws-cdk-blocks/core';

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

- The handler claims the tick before it rotates. A tick can be delivered more than once, and a failed tick is retried. Without the claim, a second `put()` for the same tick would replace the previous version with the key from the first `put()`, and signatures made with the key that was current before the tick would stop verifying.
- A repeated delivery carries the same `scheduledTime`, and a `KVStore` `put()` with `ifNotExists` is one conditional write, so only one delivery of a tick gets past it.
- If the secret's `put()` then fails, that tick is skipped rather than retried and the next tick rotates. Until then the current and previous keys both stay valid.
- The `rotations` store holds only the tick's timestamp, one small item per tick.

Keep the old key as this previous version — `put()` retains it for you. Don't pack `{ current, previous }` into one JSON value (the secret's value is then no longer the key, and every reader has to unpack it), and don't copy old keys into a `KVStore`, table or second `Secret` (that spreads key material into stores without the secret's access controls).

To read a listed version, pass an item returned by `listVersions()` straight back to `get()`:

```typescript
const versions = await signingKey.listVersions();
// [{ versionId, stages: ['AWSCURRENT'], createdDate }, { versionId, stages: ['AWSPREVIOUS'], createdDate }]
const value = await signingKey.get({ version: versions[1] });  // read a specific version
```

For anything deeper than the current/previous pair (full history, custom staging labels, reading by an arbitrary id), use the AWS SDK directly against the secret. The secret's ARN is on the CDK construct only (`secret.secretArn`, available at synth); the runtime and mock classes do not expose it.

## What it provisions (AWS)

- **Encryption:** KMS at rest, using the default `aws/secretsmanager` key.
- **IAM:** the construct grants the shared execution role `secretsmanager:GetSecretValue` + `ListSecretVersionIds` scoped to the single secret (not a wildcard), and `PutSecretValue` only when `allowRuntimeWrite: true`.
- **Removal policy:** follows the stack-wide `defaults` (production retains, sandbox destroys); override per-instance with `removalPolicy`.
- **Tags:** BB-created secrets are tagged `aws-blocks-stack=<stackName>` (join the settings resource group); `fromExisting` secrets are not tagged.

## Scaling and cost (AWS)

- **Billing:** $0.40 per secret per month (prorated hourly) + $0.05 per 10,000 API calls. No free tier.
- **Latency:** low-tens-of-ms per API call. The runtime caches the fetched value in-process for `cacheTtlSeconds`, so steady-state reads hit the cache, not the API.
- **Throughput:** GetSecretValue scales to thousands of requests/sec per account (default quotas, raisable).
- **Value size limit:** 64 KB per secret value.
- **Version history:** `listVersions()` returns the labeled versions — current + previous. Secrets Manager retains additional unlabeled versions internally (until >100, never removing any created in the last 24h).

## Local development

- The mock stores the current value as plaintext in the shared `.bb-data/settings.json` (the same file `AppSetting` uses) and logs a one-time warning. Never use real credentials in local development.
- The key in that file is the secret's `name` when you pass one, otherwise its `fullId` (for example `new Secret(new Scope('my-app'), 'stripe-key')` is stored under `my-app-stripe-key`).
- The previous value (for `get({ version: 'previous' })` / `listVersions()`) is kept in `.bb-data/secret-versions.json` — current + previous only.
- The mock has no cache: every `get()` reads `.bb-data/settings.json` again, so a value written to that file reaches the next call without a restart.
- Wipe with `rm -rf .bb-data`.

To simulate an externally set secret in a local test, add the value under that key, keeping the entries already in the file — for the secret declared with `{ name: 'my-app/stripe-key' }` above:

```json
{ "my-app/stripe-key": "sk_test_123" }
```

Delete the key to simulate an unset secret (`get()` returns `null`). A value written this way replaces only the current value — it is not recorded as a version, so to exercise `get({ version: 'previous' })` locally, rotate with `put()`. A `generate: true` secret seeds its random value only when its key is absent, so a value you write before the backend starts is kept.

## Keys AWS CDK Blocks generates for its own blocks

AWS CDK Blocks stores the keys it generates for its own blocks (the `Auth` session secret and the `Realtime` connection token key) where the stack's `defaults.secretsStore` says: a `Secret` in Secrets Manager (`'secrets-manager'`, the production preset) or an `AppSetting` SSM SecureString (`'ssm'`, the sandbox preset). The setting does not change the defaults of a `Secret` you declare.
