# foundations

Standard Building Blocks for common AWS services in the AWS Blocks.

## Overview

`foundations` provides production-ready Building Blocks for the most common AWS services. Each block includes CDK infrastructure, runtime SDK integration, and local mocking for development without an AWS account.

## Available Building Blocks

### AuthBasic
Username/password authentication with code-based verification.

```typescript
import { AuthBasic } from '@aws-blocks/blocks';

const auth = new AuthBasic(scope, 'auth', {
  codeDelivery: async (username, code) => { /* send code via email */ },
});
```

### AuthOIDC
OIDC/OAuth 2.0 sign-in gate — Google, GitHub, Okta, or any OIDC provider. Sessions outlive the IdP's ID token with transparent background refresh.

```typescript
import { AuthOIDC, google } from '@aws-blocks/blocks';

const auth = new AuthOIDC(scope, 'auth', {
  providers: [google({ clientId: '...', clientSecret: '...' })],
  onSignIn: async (user) => { /* persist profile */ },
});

const user = await auth.requireAuth(ctx);
```

### AuthCognito
Cognito User Pool integration with sign-up, MFA, groups, and custom attributes.

```typescript
import { AuthCognito } from '@aws-blocks/blocks';

const users = new AuthCognito(scope, 'users');
export const auth = users.buildAPI();
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

### KeyValueStore
Simple key-value storage for user-scoped data.

```typescript
import { KeyValueStore } from '@aws-blocks/blocks';

const store = new KeyValueStore('app', 'settings');
await store.set(userId, 'theme', 'dark');
const theme = await store.get(userId, 'theme');
```

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

### Setting
Application configuration values using AWS Systems Manager Parameter Store.

```typescript
import { Setting } from '@aws-blocks/blocks';

const config = new Setting('app', 'feature-flags');
await config.set('newUI', 'enabled');
```

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
