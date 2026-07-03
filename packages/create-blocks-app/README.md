# create-blocks-app

CLI tool for scaffolding AWS Blocks projects.

## Overview

`create-blocks-app` adds Blocks to existing applications or creates new projects from templates. It sets up the `aws-blocks/` workspace, configures CDK infrastructure, and provides starter code.

## Usage

### Create a New Project

```bash
npx @aws-blocks/create-blocks-app my-app
```

### Start from Template

```bash
npx @aws-blocks/create-blocks-app my-app --template react
```

For the full list of templates and one-line descriptions, run:

```bash
npx @aws-blocks/create-blocks-app --help
```

Template descriptions are sourced from each template's `package.json` (`blocksTemplateDescription`) so the CLI is always the source of truth.

### Add to Existing Project

```bash
npx @aws-blocks/create-blocks-app .
```

### Add Blocks to an Amplify Gen 2 Project

Already have an Amplify Gen 2 app? Run from your project root:

```bash
npx @aws-blocks/create-blocks-app .
```

The CLI detects your Amplify project (`amplify/backend.ts`) and integrates Blocks alongside it — adding a `aws-blocks/` workspace, wiring auth via bearer tokens, and scaffolding npm scripts for deployment. Your existing Amplify auth, data, and hosting stay untouched.

## What Gets Created

```
./
├── aws-blocks/
│   ├── index.ts          # Backend entry point
│   ├── index.cdk.ts      # CDK stack definition
│   ├── index.handler.ts  # Lambda handler
│   ├── client.js         # Auto-generated frontend client
│   ├── package.json      # Backend workspace dependencies
│   └── scripts/
│       ├── server.ts     # Local dev server
│       ├── sandbox.ts    # Sandbox deployment
│       ├── deploy.ts     # Production deployment
│       └── destroy.ts    # Stack teardown
├── cdk.json              # CDK configuration
├── src/
│   └── ...               # Your existing code
└── package.json          # Updated with Blocks scripts
```

### Backend Structure

**aws-blocks/index.ts**
```typescript
import { ApiNamespace, Scope, AuthBasic, DistributedTable, Realtime } from '@aws-blocks/blocks';
import { z } from 'zod';

const scope = new Scope('my-app');

const auth = new AuthBasic(scope, 'auth', {
  passwordPolicy: { minLength: 8 },
});
export const authApi = auth.createApi();

const todoSchema = z.object({
  userId: z.string(),
  todoId: z.string(),
  title: z.string(),
  completed: z.boolean(),
});

const todos = new DistributedTable(scope, 'todos', {
  schema: todoSchema,
  key: { partitionKey: 'userId', sortKey: 'todoId' },
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async createTodo(title: string) { /* ... */ },
  async listTodos() { /* ... */ },
  async toggleTodo(todoId: string) { /* ... */ },
  async deleteTodo(todoId: string) { /* ... */ },
}));
```

**aws-blocks/index.cdk.ts**
```typescript
import * as cdk from 'aws-cdk-lib';
import { BlocksStack } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stackName = 'my-blocks-stack-prod';

const app = new cdk.App();
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
});
```

### Package.json Scripts

```json
{
  "scripts": {
    "dev": "tsx watch aws-blocks/scripts/server.ts",
    "sandbox": "tsx aws-blocks/scripts/sandbox.ts",
    "sandbox:destroy": "tsx -C cdk aws-blocks/scripts/sandbox-destroy.ts",
    "deploy": "tsx aws-blocks/scripts/deploy.ts",
    "destroy": "tsx aws-blocks/scripts/destroy.ts",
    "build": "tsc && vite build"
  }
}
```

## Templates

Every folder under `templates/` is a self-registering template. Each `package.json` in that folder sets a `blocksTemplateDescription` field, which the CLI reads to build the `--help` catalog. To see the current list of templates and their one-line descriptions:

```bash
npx @aws-blocks/create-blocks-app --help
```

## Related Packages

- [blocks](../blocks/README.md) - Core runtime and Building Blocks

## License

Apache-2.0
