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
| `get()` | `Promise<T \| null>` | Read the value. Returns `null` when the secret has not been set or does not exist. |
| `put(value)` | `Promise<void>` | Set or update the value at runtime. |
| `Secret.fromExisting(arn)` | `ExternalSecretRef` | Reference an existing Secrets Manager secret (static). Pass to `options.secret`. |

### Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
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

### Opaque string secret

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

Set the value once (from an admin path, a deploy script, or the AWS console). At runtime:

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

## Scaling & cost (AWS)

- Backed by AWS Secrets Manager. Billed per secret per month plus per API call — see the [AWS Secrets Manager pricing page](https://aws.amazon.com/secrets-manager/pricing/) for current rates.
- The construct grants the shared execution role `secretsmanager:GetSecretValue` and `secretsmanager:PutSecretValue` scoped to the single secret (not a wildcard), plus the KMS grants Secrets Manager attaches for the encryption key.
- Removal policy follows the stack-wide `defaults` (production retains, sandbox destroys); override per-instance with `removalPolicy`.

## Local development

The mock stores secret values as **plaintext** on disk under `.bb-data/{fullId}/secret` and logs a one-time warning. It is **not** secure — never use real credentials in local development. Wipe with `rm -rf .bb-data`.

`Secret` runs server-side only. Importing and instantiating it in browser/client code throws `SecretErrors.NotSupported` — a secret read in the browser would expose it to the client.
