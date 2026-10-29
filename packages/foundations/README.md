# foundations

Standard Building Blocks for common AWS services in the AWS Blocks.

> **Note:** This README describes an *aspirational* consolidated API for the foundation blocks. It is **not yet implemented** — this package is currently a stub. For the API that actually ships today, see [`packages/bb-kv-store/README.md`](../bb-kv-store/README.md), [`packages/bb-app-setting/README.md`](../bb-app-setting/README.md) and [`packages/bb-auth/README.md`](../bb-auth/README.md), which are the authoritative reference for the shipped blocks. The `Auth` section below matches the shipped API.

## Overview

`foundations` provides production-ready Building Blocks for the most common AWS services. Each block includes CDK infrastructure, runtime SDK integration, and local mocking for development without an AWS account.

## Available Building Blocks

### Auth
One authentication block for email + password, social sign-in, generic OIDC and SAML. This section describes the shipped API; see [`packages/bb-auth/README.md`](../bb-auth/README.md) (including *Which option and why*) for the full reference.

```typescript
import { AppSetting, Auth } from '@aws-blocks/blocks';

const googleSecret = new AppSetting(scope, 'google-secret', { secret: true });

// Email + password is on by default (sign-up confirms the email with a code);
// every other sign-in method is a sibling key on the same options object.
const auth = new Auth(scope, 'auth', {
  socialProviders: { google: { clientId: 'your-google-client-id', clientSecret: googleSecret } }, // via Cognito
  oidcProviders: { okta: { issuer: 'https://dev-12345.okta.com', clientId: '0oa-your-client-id' } }, // direct
});
export const authApi = auth.createApi();

// Inside a request handler:
const user = await auth.requireAuth(ctx);
```

### Storage (FileBucket)
S3-backed file storage with optimized naming patterns.

```typescript
import { FileBucket } from '@aws-blocks/blocks';

const files = new FileBucket('app', 'uploads');
await files.write('key', content);
const data = await files.read('key');
```

### DistributedTable
DynamoDB-like key-value storage with local SQLite mocking.

```typescript
import { DistributedTable } from '@aws-blocks/blocks';

const table = new DistributedTable('app', 'data', {
  partitionKey: 'userId',
  sortKey: 'timestamp'
});
```

### KVStore
Simple key-value storage for user-scoped data.

```typescript
import { KVStore } from '@aws-blocks/blocks';

const store = new KVStore(scope, 'settings');

// Data methods run at request time, inside a handler — not at CDK synth time.
await store.put(`user:${userId}:theme`, 'dark');
const theme = await store.get(`user:${userId}:theme`);
```

See [`packages/bb-kv-store/README.md`](../bb-kv-store/README.md) for the full API, options, TTL, and conditional writes.

### SQLTable
Relational database with SQL query support. Uses SQLite locally, DSQL on AWS.

```typescript
import { SQLTable } from '@aws-blocks/blocks';

const db = new SQLTable('app', 'products', {
  schema: `
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL
    )
  `
});
```

### Secret
Secure secret storage using AWS Secrets Manager.

```typescript
import { Secret } from '@aws-blocks/blocks';

const apiKey = new Secret('app', 'api-key');
const key = await apiKey.getValue();
```

### AppSetting
A single application configuration value using AWS Systems Manager Parameter Store.

```typescript
import { AppSetting } from '@aws-blocks/blocks';

const newUiFlag = new AppSetting(scope, 'new-ui', { value: 'disabled' });

// Data methods run at request time, inside a handler.
await newUiFlag.put('enabled');
const newUI = await newUiFlag.get();
```

See [`packages/bb-app-setting/README.md`](../bb-app-setting/README.md) for the full API and options.

### CronJob
Scheduled background tasks using EventBridge.

```typescript
import { CronJob } from '@aws-blocks/blocks';

const cleanup = new CronJob('app', 'cleanup', {
  schedule: 'rate(1 day)',
  handler: async () => {
    // Cleanup logic
  }
});
```

### AsyncJob
Background job processing for long-running tasks.

```typescript
import { AsyncJob } from '@aws-blocks/blocks';

const processor = new AsyncJob('app', 'processor');
await processor.enqueue({ task: 'process', data: {...} });
```

### Realtime
WebSocket-based real-time communication using AppSync Event API.

```typescript
import { Realtime } from '@aws-blocks/blocks';

const chat = new Realtime('app', 'chat');
await chat.publish('room-1', { message: 'Hello!' });
```

### LLM
Integration with AWS Bedrock for AI/ML capabilities.

```typescript
import { LLM } from '@aws-blocks/blocks';

const ai = new LLM('app', 'assistant', {
  model: 'anthropic.claude-v2'
});
const response = await ai.generate('Explain AWS Blocks');
```

## Installation

```bash
npm install @aws-blocks/blocks
```

## Design Principles

All Building Blocks in this package follow these principles:

1. **Local-first** - Work without AWS account during development
2. **Type-safe** - Full TypeScript support with IDE autocomplete
3. **Scalable** - Built on AWS services that scale automatically
4. **Documented** - Rich docstrings with performance characteristics
5. **Composable** - Can be combined to create higher-level abstractions

## Performance Characteristics

Each Building Block includes detailed performance documentation in its docstrings, visible in your IDE. This helps both humans and AI coding agents make informed decisions about which blocks to use.

## Creating Custom Building Blocks

See the Building Block Guide (see docs/reference/building-block-structure.md) for instructions on creating your own blocks that integrate with this ecosystem.

## Related Packages

- [@aws-blocks/blocks](../blocks/README.md) - Main package with all Building Blocks
- [create-blocks-app](../create-blocks-app/README.md) - Project scaffolding CLI

## License

Apache-2.0
