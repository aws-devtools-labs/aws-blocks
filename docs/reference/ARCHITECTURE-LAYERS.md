# Building Block Layer Architecture

## Overview

Building Blocks in AWS Blocks are structured with **four independent exports**, each in its own file. All four files must be present, but exports can be no-ops when not needed.

This separation provides:

- **Clear separation of concerns** - Infrastructure, runtime, mocking, and client protocols are distinct
- **Selective bundling** - Only relevant code ships to each environment
- **Explicit contracts** - All Building Blocks have the same file structure
- **Better tooling** - AWS Blocks can analyze and optimize each layer independently

## Export Structure

```
building-block/
├── client-hook.ts  # Client protocol extensions
├── index.ts        # Runtime layer (AWS SDK calls, business logic)
├── infra.ts        # Infrastructure layer (CDK resources)
└── mock.ts         # Mock layer (local development)
```

All four files are **required**. If a Building Block doesn't need a particular layer, export a no-op.

## How AWS Blocks Consumes Each Export

```
Building Block Exports          Consumption
┌─────────────────────┐
│ client-hook.ts      │────────> Browser Bundle
│ index.ts            │────────> Lambda Bundle (production)
│ infra.ts            │────────> CDK Bundle (deployment)
│ mock.ts             │────────> Local Server (development)
└─────────────────────┘
```

| Export | Local Dev | Deployment | Production |
|--------|-----------|------------|------------|
| `client-hook.ts` | ✅ Bundled to browser | ❌ | ✅ Bundled to browser |
| `index.ts` | ❌ | ❌ | ✅ Bundled to Lambda |
| `infra.ts` | ❌ | ✅ Synthesized to CDK | ❌ |
| `mock.ts` | ✅ Used in local server | ❌ | ❌ |

## Export Requirements

### All Exports Required

Every Building Block must have all four files:
- `client-hook.ts`
- `index.ts`
- `infra.ts`
- `mock.ts`

### No-Op Exports

When a Building Block doesn't need a particular layer, export a no-op:

**client-hook.ts** (no client protocol needed):
```typescript
// No client-side protocol extensions needed
export {};
```

**infra.ts** (no infrastructure needed):
```typescript
import { Construct } from 'constructs';

// No infrastructure to provision
export function materialize(scope: Construct, name: string, options: any) {
  return {};
}
```

**mock.ts** (use production implementation locally):
```typescript
// Re-export production implementation for local use
export * from './index.js';
```

## Examples

### Full Building Block (All Layers)

**FileBucket** - S3 storage with local filesystem mock

```
file-bucket/
├── client-hook.ts  # No client protocol needed (no-op)
├── index.ts        # S3Client operations
├── infra.ts        # s3.Bucket CDK resource
└── mock.ts         # fs.readFile/writeFile
```

**client-hook.ts:**
```typescript
export {};
```

**index.ts:**
```typescript
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

export class FileBucket {
  private client?: S3Client;
  private bucketName?: string;

  constructor(public name: string, public options: FileBucketOptions) {}

  private getClient() {
    if (!this.client) {
      this.client = new S3Client({});
      this.bucketName = process.env[`BLOCKS_${this.name}_BUCKET_NAME`];
    }
    return this.client;
  }

  async get(key: string): Promise<Buffer> {
    const client = this.getClient();
    const result = await client.send(new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key
    }));
    return Buffer.from(await result.Body!.transformToByteArray());
  }

  async put(key: string, data: Buffer): Promise<void> {
    const client = this.getClient();
    await client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: data
    }));
  }
}
```

**infra.ts:**
```typescript
import { Construct } from 'constructs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { CfnOutput } from 'aws-cdk-lib';

export function materialize(scope: Construct, name: string, options: any) {
  const bucket = new Bucket(scope, `${name}-bucket`);

  new CfnOutput(scope, `${name}-bucket-name`, {
    value: bucket.bucketName,
    exportName: `BLOCKS_${name}_BUCKET_NAME`
  });

  return { bucket };
}
```

**mock.ts:**
```typescript
import * as fs from 'fs/promises';
import * as path from 'path';

export class FileBucket {
  private basePath: string;

  constructor(public name: string, public options: any) {
    this.basePath = path.join(process.cwd(), '.bb-local', name);
    fs.mkdir(this.basePath, { recursive: true });
  }

  async get(key: string): Promise<Buffer> {
    return await fs.readFile(path.join(this.basePath, key));
  }

  async put(key: string, data: Buffer): Promise<void> {
    const filePath = path.join(this.basePath, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
  }
}
```

### Composite Block (Runtime Only)

**UserStorage** - Combines Auth + FileBucket

```
user-storage/
├── client-hook.ts  # No client protocol (no-op)
├── index.ts        # Composes Auth and FileBucket
├── infra.ts        # No infrastructure (no-op)
└── mock.ts         # Re-exports index.ts
```

**client-hook.ts:**
```typescript
export {};
```

**index.ts:**
```typescript
import { Auth } from './auth.js';
import { FileBucket } from './file-bucket.js';

export class UserStorage {
  private auth: Auth;
  private storage: FileBucket;

  constructor(public name: string) {
    this.auth = new Auth(`${name}-auth`, {});
    this.storage = new FileBucket(`${name}-storage`, {});
  }

  async saveUserFile(context: any, filename: string, data: Buffer) {
    const user = await this.auth.requireUser(context);
    await this.storage.put(`${user.id}/${filename}`, data);
  }

  async getUserFile(context: any, filename: string): Promise<Buffer> {
    const user = await this.auth.requireUser(context);
    return await this.storage.get(`${user.id}/${filename}`);
  }
}
```

**infra.ts:**
```typescript
import { Construct } from 'constructs';

// No infrastructure - uses composed blocks' infrastructure
export function materialize(scope: Construct, name: string, options: any) {
  return {};
}
```

**mock.ts:**
```typescript
// Use production implementation locally
export * from './index.js';
```

### Infrastructure-Only Block

**Dashboard** - CloudWatch dashboard

```
dashboard/
├── client-hook.ts  # No client protocol (no-op)
├── index.ts        # No runtime behavior (no-op)
├── infra.ts        # Dashboard CDK resource
└── mock.ts         # No mock needed (no-op)
```

**client-hook.ts:**
```typescript
export {};
```

**index.ts:**
```typescript
// No runtime behavior
export {};
```

**infra.ts:**
```typescript
import { Construct } from 'constructs';
import { Dashboard, GraphWidget } from 'aws-cdk-lib/aws-cloudwatch';

export function materialize(scope: Construct, name: string, options: any) {
  const dashboard = new Dashboard(scope, `${name}-dashboard`, {
    dashboardName: name
  });

  return { dashboard };
}
```

**mock.ts:**
```typescript
// No mock needed
export {};
```

### Protocol Extension Block

**Realtime** - WebSocket communication

```
realtime/
├── client-hook.ts  # WebSocket client setup
├── index.ts        # Server-side pub/sub
├── infra.ts        # AppSync Event API
└── mock.ts         # In-memory pub/sub
```

**client-hook.ts:**
```typescript
export class RealtimeClientHook {
  private ws?: WebSocket;

  async onInit(config: any) {
    this.ws = new WebSocket(config.websocketUrl);
    
    this.ws.onmessage = (event) => {
      // Handle incoming messages
    };
  }

  async subscribe(channel: string) {
    this.ws?.send(JSON.stringify({ type: 'subscribe', channel }));
  }

  async publish(channel: string, message: any) {
    this.ws?.send(JSON.stringify({ type: 'publish', channel, message }));
  }
}
```

**index.ts:**
```typescript
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';

export class Realtime {
  private client?: IoTDataPlaneClient;
  private endpoint?: string;

  constructor(public name: string, public options: any) {}

  private getClient() {
    if (!this.client) {
      this.endpoint = process.env[`BLOCKS_${this.name}_ENDPOINT`];
      this.client = new IoTDataPlaneClient({ endpoint: this.endpoint });
    }
    return this.client;
  }

  async publish(channel: string, message: any) {
    const client = this.getClient();
    await client.send(new PublishCommand({
      topic: channel,
      payload: Buffer.from(JSON.stringify(message))
    }));
  }
}
```

**infra.ts:**
```typescript
import { Construct } from 'constructs';
import { CfnOutput } from 'aws-cdk-lib';
// AppSync or IoT Core setup...

export function materialize(scope: Construct, name: string, options: any) {
  // Create WebSocket API infrastructure
  // ...

  new CfnOutput(scope, `${name}-endpoint`, {
    value: endpoint,
    exportName: `BLOCKS_${name}_ENDPOINT`
  });

  return { endpoint };
}
```

**mock.ts:**
```typescript
import { EventEmitter } from 'events';

const globalEmitter = new EventEmitter();

export class Realtime {
  constructor(public name: string, public options: any) {}

  async publish(channel: string, message: any) {
    globalEmitter.emit(channel, message);
  }

  subscribe(channel: string, handler: (message: any) => void) {
    globalEmitter.on(channel, handler);
  }
}
```

## Implementation Details

### Runtime Layer (`index.ts`)

Exports classes/functions used in production application code:

```typescript
export class MyBlock {
  constructor(public name: string, public options: Options) {}
  
  async doSomething() {
    // Access resources via environment variables
    const resourceId = process.env[`BLOCKS_${this.name}_RESOURCE_ID`];
    // Use AWS SDK...
  }
}
```

### Infrastructure Layer (`infra.ts`)

Exports a `materialize` function that returns CDK resources:

```typescript
import { Construct } from 'constructs';
import { CfnOutput } from 'aws-cdk-lib';

export function materialize(scope: Construct, name: string, options: Options) {
  // Create CDK resources
  const resource = new SomeResource(scope, name);
  
  // Export values for runtime injection
  new CfnOutput(scope, `${name}-id`, {
    value: resource.id,
    exportName: `BLOCKS_${name}_RESOURCE_ID`,
  });
  
  return { resource };
}
```

### Mock Layer (`mock.ts`)

Exports same interface as runtime layer, with local implementations:

```typescript
export class MyBlock {
  constructor(public name: string, public options: Options) {}
  
  async doSomething() {
    // Local implementation (SQLite, filesystem, in-memory, etc.)
  }
}
```

### Client Hook (`client-hook.ts`)

Exports a class with lifecycle methods for client-side protocol handling:

```typescript
export class MyClientHook {
  async onInit(config: any) {
    // Initialize client-side resources
  }
  
  async onResponse(res: Response) {
    // Handle special responses (WebSocket upgrade, etc.)
  }
}
```

## Benefits

1. **Consistent structure** - All Building Blocks have the same four files
2. **No CDK in production bundles** - Infrastructure code never ships to Lambda
3. **Type safety across layers** - Shared types between runtime and mock
4. **Independent testing** - Test each layer in isolation
5. **Clear contracts** - Each export has a well-defined interface
6. **Explicit no-ops** - Missing functionality is visible, not implicit

## Export Discovery

AWS Blocks uses two mechanisms to ensure correct exports are consumed in each context:

1. **Conditional exports** in package.json
2. **Export manifest** generated at build time

This ensures:
- Browser bundles only get `client-hook.ts`
- Lambda bundles only get `index.ts`
- CDK apps only get `infra.ts`
- Local dev only gets `mock.ts`

## See Also

- [Building Block Structure](./building-block-structure.md) - Detailed file structure guide
- [Building Block Structure](./building-block-structure.md) - Creating custom Building Blocks
