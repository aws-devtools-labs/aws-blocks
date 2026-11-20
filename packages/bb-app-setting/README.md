# AppSetting

A single application configuration value backed by SSM Parameter Store.

**When to use:** You need a non-sensitive configuration value (feature flag, API URL, threshold) stored as a single SSM parameter.

**When NOT to use:** For a credential that protects a production app (API key, OAuth client secret, database connection string, token), use [`Secret`](../bb-secret/README.md). `AppSetting` with `secret: true` encrypts the value at rest and is free: use it for a low-value secret in a prototype. If you need structured key-value data with conditional writes and queries, use `KVStore`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick start

```typescript
const auth = new Auth(scope, 'auth', { users: { groups: ['admin'] } });
const apiUrl = new AppSetting(scope, 'apiUrl', {
  value: 'https://api.example.com',
});

export const api = auth.protect(scope, 'api', {
  methods: () => ({
    async getApiUrl() {
      return { url: await apiUrl.get() };
    },
  }),
});
```

## API

```typescript
const setting = new AppSetting(scope, id, options)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `get()` | `Promise<T>` | Read the current value. |
| `put(value)` | `Promise<void>` | Update the value at runtime. |
| `AppSetting.fromExisting(scope, id, { name, secret?, kmsKeyArn? })` | `AppSetting<T>` | Read a parameter that is created outside the stack. See [Existing parameter](#existing-parameter-fromexisting). |

**CDK layer (synth time) only** — read-only properties on the construct, for CDK code and for other Building Blocks' CDK layers. They are not on the local or Lambda runtime class.

| Property | Type | Description |
|----------|------|-------------|
| `parameterName` | `string` | The SSM parameter name: the explicit `name` (always set for `fromExisting`), else the derived `/${fullId}`. The same name the runtime reads. |
| `secret` | `boolean` | `true` for an SSM SecureString (`secret: true`), for created and `fromExisting` settings alike. |

`Auth` accepts an `AppSetting` as an identity provider's client secret only when its `secret` is `true`. A setting with an explicit `name` or from `AppSetting.fromExisting` works.

### Options

Pass exactly one of `value` or `secret: true`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | `/${fullId}` | SSM parameter path. The default is unique within the stack. An explicit `name` must be unique across all stacks in the same AWS account and Region. |
| `value` | `T` | — | Initial value. Required unless `secret: true`. Must not be provided when `secret` is set. |
| `schema` | `StandardSchemaV1<T>` | — | Runtime validation schema (Zod, Valibot, ArkType). Infers `T` from the schema. Requires `value`. Cannot be used with `secret`. |
| `secret` | `boolean` | `false` | When `true`, creates an SSM SecureString encrypted with the default `aws/ssm` KMS key (or `kmsKeyArn` when set). The value is a plain string. Cannot be used with `schema` or `value`. See [Secret values](#secret-values-secret-true). |
| `kmsKeyArn` | `string` | `aws/ssm` key | ARN of a customer-managed KMS key to encrypt the SecureString. Only valid with `secret: true`. |
| `logger` | `ChildLogger` | error-level `Logger` | Logger for internal operations. |

An invalid combination throws `ValidationFailed` at CDK synth, and at construction in local development.

With `kmsKeyArn`:

- The app's Lambda execution role is granted `kms:Decrypt`, plus `kms:Encrypt` for a secret the stack creates, on that key ARN.
- The key policy must authorize the app's execution role. For a stack-created secret, it must also authorize the secret initializer's role (or delegate to IAM).
- For a stack-created secret, changing `kmsKeyArn` re-encrypts its current value on deploy. For an imported secret, its owner must change the encryption key; this option only changes the app's grant.

## Errors

Match an error by name with `isBlocksError`:

```typescript
import { AppSettingErrors, isBlocksError } from 'aws-cdk-blocks';
```

| Constant | `error.name` | Thrown when |
|----------|--------------|-------------|
| `AppSettingErrors.ValidationFailed` | `ValidationFailedException` | `put()`: the value fails the schema, or a non-secret value's JSON exceeds 4 KB (4,096 bytes). The block skips the size check for secrets; SSM still enforces the [parameter tier's limit](https://docs.aws.amazon.com/systems-manager/latest/userguide/parameter-store-advanced-parameters.html). Constructor: the options are an invalid combination. |
| `AppSettingErrors.ParameterNotFound` | `ParameterNotFoundException` | `get()`: the parameter does not exist or has no value (AWS), or a `secret: true` value is an empty string (AWS and local). |

## Secret values (`secret: true`)

```typescript
import { createHmac } from 'node:crypto';

const signingKey = new AppSetting(scope, 'prototype-signing-key', { secret: true });

// In a server-side handler, after authorizing the operation:
async function signForPrototype(payload: string) {
  const key = await signingKey.get();
  return createHmac('sha256', key).update(payload).digest('hex');
}
```

- The first deploy stores a random value (32 random bytes, base64url). Later deploys keep the stored value.
- Set the real value with `put()`, or in the AWS console: the deployed app's `/cdk-blocks/settings` route redirects to the stack's settings resource group, which lists the parameter.
- `get()` parses the stored text as JSON and falls back to the raw text. A console value that is valid JSON (`12345`, `true`) is returned as a number or boolean: set such a value with `put()`, which stores it as a JSON string (shown in the console with double quotes).
- Locally the value is a random string in `.cdk-blocks/local/data/settings.json`. Edit the file to change it; the next `get()` reads it.

## Existing parameter (`fromExisting`)

`AppSetting.fromExisting` reads a parameter that something else creates. For example, `npm run db -- connect --stage production` stores the default connection string at `/<stackName>-db-url`. Use the parameter name printed by the command; for a stack named `my-app`:

```typescript
const dbUrl = AppSetting.fromExisting(scope, 'db-url', { name: '/my-app-db-url', secret: true });
```

- The stack does not create, seed, tag or delete the parameter.
- The construct grants `ssm:GetParameter` and, with `secret: true`, `kms:Decrypt`. It does not grant or deny `ssm:PutParameter`. Do not call `put()` on an imported setting: the mock permits it, and on AWS it can overwrite the parameter if another policy grants write access.
- The parameter must exist before the app runs. If it does not, the deploy succeeds and `get()` throws `ParameterNotFound`.
- Locally the value is the entry under the setting's `fullId` in `.cdk-blocks/local/data/settings.json`: a random string with `secret: true`, an empty string otherwise. Edit the file to set it.

## Examples

### Typed Object with Schema

This example uses the `auth` block and its `admin` group from [Quick start](#quick-start).

```typescript
import { z } from 'zod';

const config = new AppSetting(scope, 'config', {
  value: { maxRetries: 3, timeout: 5000 },
  schema: z.object({ maxRetries: z.number(), timeout: z.number() }),
});

// Only members of the admin group can read or change this configuration.
export const settingsAdmin = auth.protect(scope, 'settingsAdmin', {
  methods: () => ({
    async getConfig() {
      return config.get();
    },
    async updateConfig(cfg: { maxRetries: number; timeout: number }) {
      await config.put(cfg); // validated against the schema after authorization
    },
  }),
}, { role: 'admin' });
```

### Explicit Name (Cross-Service Reads)

Use an explicit `name` when the SSM parameter must be read by other services or follow a well-known path convention.

```typescript
const apiUrl = new AppSetting(scope, 'apiUrl', {
  name: '/my-app/production/api-url',
  value: 'https://api.example.com',
});
```

## Scaling and cost (AWS)

- **String parameters:** Standard tier, free, 4 KB limit, 10,000 per account/region
- **SecureString parameters:** Standard tier, free
- **Throughput:** 40 TPS default for GetParameter (can be increased)
- **Latency:** Single-digit ms reads and writes

## Local development

Local values are in the shared `.cdk-blocks/local/data/settings.json` (the file `Secret` uses too), keyed by the setting's `fullId`. A `secret: true` setting gets a random value locally (no KMS encryption in mock mode).
