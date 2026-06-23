# Building Block Structure

Building Blocks in AWS Blocks are composed of four independent exports, each in its own file. All four files are required, but can export no-ops when not needed.

## File Structure

```
my-building-block/
├── client-hook.ts  # Client protocol extensions
├── index.ts        # Runtime layer
├── infra.ts        # Infrastructure layer
└── mock.ts         # Mock layer
```

## Export Responsibilities

### Runtime Layer (`index.ts`)

The runtime layer exports classes/functions that your production application code uses. This code runs in your compute environment (Lambda, Fargate, EC2, etc.).

```typescript
// my-building-block/index.ts
export class MyBuildingBlock {
  constructor(public name: string, public options: MyOptions) {}
  
  async doSomething(input: string): Promise<string> {
    // Access AWS resources using environment variables
    // injected by AWS Blocks from the infrastructure layer
    const resourceId = process.env[`BLOCKS_${this.name}_RESOURCE_ID`];
    
    // Use AWS SDK
    const client = new SomeAWSClient({});
    const result = await client.send(new SomeCommand({ resourceId, input }));
    
    return result.output;
  }
}
```

### Infrastructure Layer (`infra.ts`)

The infrastructure layer exports a `materialize` function that defines CDK resources. AWS Blocks invokes this during deployment.

```typescript
// my-building-block/infra.ts
import { Construct } from 'constructs';
import { CfnOutput } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';

export function materialize(
  scope: Construct,
  name: string,
  options: MyOptions
) {
  const bucket = new s3.Bucket(scope, `${name}-bucket`);
  
  // Export values for runtime injection
  new CfnOutput(scope, `${name}-resource-id`, {
    value: bucket.bucketName,
    exportName: `BLOCKS_${name}_RESOURCE_ID`
  });
  
  return { bucket };
}
```

**No-op when no infrastructure needed:**
```typescript
// my-building-block/infra.ts
import { Construct } from 'constructs';

export function materialize(scope: Construct, name: string, options: any) {
  return {};
}
```

### Mock Layer (`mock.ts`)

The mock layer exports the same interface as the runtime layer, but with local implementations. AWS Blocks uses this when running locally.

```typescript
// my-building-block/mock.ts
export class MyBuildingBlock {
  constructor(public name: string, public options: MyOptions) {}
  
  async doSomething(input: string): Promise<string> {
    // Local implementation using filesystem, SQLite, in-memory, etc.
    return localResult;
  }
}
```

**No-op when production implementation works locally:**
```typescript
// my-building-block/mock.ts
export * from './index.js';
```

### Client Hook (`client-hook.ts`)

The client hook exports a class with lifecycle methods for client-side protocol handling. AWS Blocks bundles this into the browser.

```typescript
// my-building-block/client-hook.ts
export class MyClientHook {
  async onInit(config: any) {
    // Initialize client-side resources (WebSocket, etc.)
  }
  
  async onResponse(res: Response) {
    // Handle special responses
  }
}
```

**No-op when no client protocol needed:**
```typescript
// my-building-block/client-hook.ts
export {};
```

## Common Patterns

### Composition-Only Blocks

Building Blocks that compose other blocks without custom infrastructure:

**index.ts:**
```typescript
import { Auth } from './auth.js';
import { Storage } from './storage.js';

export class UserStorage {
  private auth: Auth;
  private storage: Storage;
  
  constructor(public name: string) {
    this.auth = new Auth(`${name}-auth`, {});
    this.storage = new Storage(`${name}-storage`, {});
  }
  
  async saveUserData(context: any, data: string) {
    const user = await this.auth.requireUser(context);
    return this.storage.save(user.id, data);
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

**client-hook.ts:**
```typescript
export {};
```

### Infrastructure-Only Blocks

Building Blocks that only provision resources without runtime methods:

**index.ts:**
```typescript
// No runtime behavior
export {};
```

**infra.ts:**
```typescript
import { Construct } from 'constructs';
import { Dashboard } from 'aws-cdk-lib/aws-cloudwatch';

export function materialize(scope: Construct, name: string, options: any) {
  const dashboard = new Dashboard(scope, `${name}-dashboard`, {
    dashboardName: name,
    // ... widgets ...
  });
  
  return { dashboard };
}
```

**mock.ts:**
```typescript
// No mock needed
export {};
```

**client-hook.ts:**
```typescript
export {};
```

### Full-Featured Blocks

Building Blocks with all four layers:

**index.ts:**
```typescript
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

export class FileBucket {
  private client?: S3Client;
  private bucketName?: string;

  constructor(public name: string, public options: any) {}

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

**client-hook.ts:**
```typescript
export {};
```

### Protocol Extension Blocks

Building Blocks with custom client protocols (WebSocket, etc.):

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
  const endpoint = '...';

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

## How AWS Blocks Uses These Exports

AWS Blocks consumes different exports in different contexts:

| Context | Consumes | Output |
|---------|----------|--------|
| **Local Development** | `mock.ts` | Local server with mock implementations |
| **Deployment** | `infra.ts` | CDK bundle → CloudFormation |
| **Production Runtime** | `index.ts` | Lambda bundle with AWS SDK calls |
| **Client Bundle** | `client-hook.ts` | Browser bundle with protocol extensions |

AWS Blocks uses conditional exports and build-time analysis to ensure:
- Browser bundles only include `client-hook.ts`
- Lambda bundles only include `index.ts`
- CDK apps only include `infra.ts`
- Local dev only includes `mock.ts`

## Type Safety

Share types between layers by defining them in a common location:

```typescript
// types.ts
export interface MyOptions {
  timeout?: number;
  retries?: number;
}

export interface MyResult {
  success: boolean;
  data?: string;
}
```

```typescript
// index.ts
import { MyOptions, MyResult } from './types.js';

export class MyBlock {
  constructor(public name: string, public options: MyOptions) {}
  async doSomething(): Promise<MyResult> { /* ... */ }
}
```

```typescript
// mock.ts
import { MyOptions, MyResult } from './types.js';

export class MyBlock {
  constructor(public name: string, public options: MyOptions) {}
  async doSomething(): Promise<MyResult> { /* ... */ }
}
```

## Agent Tool Support (`toAgentTools`)

BBs can expose their operations as agent tools by implementing `toAgentTools()`. This lets users spread BB operations directly into an Agent's `tools` callback without writing manual tool definitions.

### How to Implement

1. Create a shared `agent-tools.ts` file with the tool registry (used by both mock and AWS runtimes):

```typescript
// my-bb/src/agent-tools.ts
import { buildAgentTools } from '@aws-blocks/core';
import type { AgentToolProviderOptions, ToolMethodDef } from '@aws-blocks/core';
import type { Scope } from '@aws-blocks/core';

interface MyBBLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export const MY_BB_TOOL_METHODS: Record<string, ToolMethodDef<MyBBLike>> = {
  get: {
    description: 'Retrieve a value by key',
    parameters: { type: 'object', properties: { key: { type: 'string', description: 'The key' } }, required: ['key'] },
    handler: (self) => async ({ input }) => self.get(input.key),
  },
  put: {
    description: 'Store a value',
    parameters: { type: 'object', properties: { key: { type: 'string' }, value: {} }, required: ['key', 'value'] },
    needsApproval: true,
    trustable: true,
    handler: (self) => async ({ input }) => { await self.put(input.key, input.value); return { success: true }; },
  },
};

export function myBBToAgentTools(self: Scope & MyBBLike, options?: AgentToolProviderOptions): Record<string, any> {
  return buildAgentTools(self, MY_BB_TOOL_METHODS, options);
}
```

2. Add `toAgentTools()` to both runtime classes (one-liner each):

```typescript
// In index.mock.ts and index.aws.ts
import { myBBToAgentTools } from './agent-tools.js';
import type { AgentToolProviderOptions } from '@aws-blocks/core';

export class MyBB extends Scope {
  // ... existing methods ...

  toAgentTools(options?: AgentToolProviderOptions): Record<string, any> {
    return myBBToAgentTools(this, options);
  }
}
```

### Guidelines

- **Parameters use JSON Schema** — avoids adding zod as a dependency to your BB. Users can override with zod via the `overrides.schema` option.
- **Read operations** set `needsApproval: false`; **write operations** set `needsApproval: true` (and optionally `trustable: true`); **delete operations** set `needsApproval: true` and `trustable: false` (each deletion requires explicit approval).
- **Descriptions** should be concise and tell the LLM what the tool does and when to use it.
- **Handlers** should return JSON-serializable values. For `AsyncIterable` results (like `scan`), collect into an array with a default limit.
- **Tool names** are generated automatically as `{bbId}__{methodName}` by `buildAgentTools`.
- **The interface** (`MyBBLike`) ensures the tool registry stays in sync with the BB's public API.

### What `buildAgentTools` Handles

The `buildAgentTools` helper from `@aws-blocks/core` handles:
- `include`/`exclude` filtering
- `overrides` (description, needsApproval, trustable, schema, fixed)
- `scope` injection (merges context fields into handler input)
- Tool naming (`{bbId}__{methodName}`)

You only need to define the tool registry and delegate.

## Best Practices

1. **Keep interfaces consistent** - Runtime and mock should export the same interface
2. **Use no-ops explicitly** - Don't omit files, export `{}` instead
3. **Share types** - Define common types in a separate file
4. **Document behavior** - Explain differences between runtime and mock
5. **Test both layers** - Ensure runtime and mock behave similarly
6. **Minimize client hooks** - Only use for non-REST protocols
7. **Export environment variables** - Use `CfnOutput` with `BLOCKS_${name}_*` pattern

## See Also

- [Building Block Layer Architecture](./ARCHITECTURE-LAYERS.md) - Detailed layer documentation
- [Building Block Structure](./building-block-structure.md) - Creating custom Building Blocks
