# AppSetting

A single application configuration value backed by SSM Parameter Store.

**When to use:** You need a configuration value (feature flag, API URL, threshold) or a secret (API key, token) stored as a single SSM parameter. Each `AppSetting` instance maps to exactly one parameter.

**When NOT to use:** If you need structured key-value data with conditional writes and queries, use `KVStore` or `DistributedTable`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## API

```typescript
const setting = new AppSetting(scope, id, options)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `get()` | `Promise<T>` | Read the current value. |
| `put(value)` | `Promise<void>` | Update the value at runtime. |

### Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | No | SSM parameter path. When omitted, derived from the scope tree as `/${fullId}`, guaranteeing uniqueness within the stack. |
| `value` | `T` | No | Initial value. Required for non-secret parameters. Must not be provided when `secret` is set. |
| `schema` | `StandardSchemaV1<T>` | No | Runtime validation schema (Zod, Valibot, ArkType). Infers `T` from the schema. Cannot be used with `secret`. |
| `secret` | `boolean` | No | When `true`, creates an SSM SecureString encrypted with the `aws/ssm` KMS key. Cannot be used with `schema` or `value`. |
| `logger` | `ChildLogger` | No | Optional logger for internal operations. When omitted, a default Logger at error level is created. |

> **Naming:** When you omit `name`, the framework derives a unique SSM path from
> the construct scope tree (`/${fullId}`). This is the recommended approach — it
> prevents collisions across stacks automatically. If you provide an explicit
> `name`, **you** are responsible for ensuring it is unique across all stacks
> deployed to the same AWS account and region.

### Error Handling

```typescript
import { isBlocksError } from '@aws-blocks/core';
import { AppSettingErrors } from '@aws-blocks/bb-app-setting';

try {
  await setting.put(value);
} catch (e: unknown) {
  if (isBlocksError(e, AppSettingErrors.ValidationFailed)) {
    // schema validation failed or value exceeds 4 KB
  }
  throw e;
}

try {
  const value = await setting.get();
} catch (e: unknown) {
  if (isBlocksError(e, AppSettingErrors.ParameterNotFound)) {
    // the parameter is missing (e.g., deleted out-of-band) or a secret has an empty value
  }
  throw e;
}
```

`get()` can throw `AppSettingErrors.ParameterNotFound` when the parameter does not exist or a secret parameter has an empty value (in both the AWS and mock runtimes).

## Examples

### Plain String Setting

```typescript
// Recommended: let the framework manage the SSM name (unique by default)
const apiUrl = new AppSetting(scope, 'apiUrl', {
  value: 'https://api.example.com',
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getApiUrl() {
    return { url: await apiUrl.get() };
  },
  async setApiUrl(url: string) {
    await apiUrl.put(url);
  },
}));
```

### Typed Object with Schema

```typescript
import { z } from 'zod';

const config = new AppSetting(scope, 'config', {
  value: { maxRetries: 3, timeout: 5000 },
  schema: z.object({ maxRetries: z.number(), timeout: z.number() }),
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getConfig() {
    return await config.get(); // { maxRetries: number; timeout: number }
  },
  async updateConfig(cfg: { maxRetries: number; timeout: number }) {
    await config.put(cfg); // validated against schema
  },
}));
```

### Secret

```typescript
const stripeKey = new AppSetting(scope, 'stripeKey', {
  secret: true,
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async charge(amount: number) {
    const key = await stripeKey.get(); // decrypted from SSM SecureString
    // use key...
  },
}));
```

### Explicit Name (Cross-Service Reads)

Use an explicit `name` when the SSM parameter must be read by other services or follow a well-known path convention.

> ⚠️ You must ensure this name is unique across all stacks deployed to the
> same AWS account and region to avoid collisions.

```typescript
const apiUrl = new AppSetting(scope, 'apiUrl', {
  name: '/my-app/production/api-url',
  value: 'https://api.example.com',
});
```

## Validation Rules

These are enforced at CDK synth time:

- `secret` + `schema` → error (secrets are plain strings)
- `schema` without `value` → error (parameter needs a valid initial value)
- `secret` with `value` → error (don't put secrets in source code)
- Non-secret without `value` → error (settings require an initial value)

## Scaling & Cost (AWS)

- **String parameters:** Standard tier, free, 4 KB limit, 10,000 per account/region
- **SecureString parameters:** Standard tier, free, encrypted with `aws/ssm` KMS key
- **Throughput:** 40 TPS default for GetParameter (can be increased)
- **Latency:** Single-digit ms reads and writes

## Local Development

Mock data persists to disk at `.bb-data/settings/{fullId}/value.json` across dev server restarts. Wipe with `rm -rf .bb-data`. Secrets generate a random value locally (no KMS encryption in mock mode).



