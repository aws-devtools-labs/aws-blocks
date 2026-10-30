# create-blocks-app

CLI tool for scaffolding AWS Blocks projects.

## Overview

`create-blocks-app` adds Blocks to existing applications or creates new projects from templates. It sets up the `aws-blocks/` workspace, configures CDK infrastructure, and provides starter code.

## Usage

### Create a New Project

```bash
npx @aws-blocks/create-blocks-app my-app
```

A target directory that contains only benign metadata (VCS/editor/OS files) or an `INSTRUCTIONS.md` is still treated as a fresh project; any other pre-existing file blocks scaffolding so nothing is overwritten.

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
│   └── package.json      # Backend workspace dependencies
├── cdk.json              # CDK configuration
├── src/
│   └── ...               # Your existing code
└── package.json          # Updated with Blocks scripts and "blocks" CLI settings
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

Every lifecycle script is a thin alias of the `blocks` CLI that ships with `@aws-blocks/blocks`, so the npm script names stay the same and `npm run deploy` runs `blocks deploy`. Run `npx --no -- blocks --help` in the app for every command and its options. The dev server settings that the scripts used to hard-code live in `package.json#blocks.dev`.

```json
{
  "scripts": {
    "dev": "blocks dev",
    "dev:stop": "blocks dev stop",
    "sandbox": "blocks sandbox",
    "sandbox:deploy": "blocks sandbox deploy",
    "sandbox:destroy": "blocks sandbox destroy",
    "sandbox:console": "blocks sandbox console",
    "cleanup": "blocks dev stop --all",
    "deploy": "blocks deploy",
    "destroy": "blocks destroy",
    "secret": "blocks secret",
    "typegen": "blocks generate types",
    "spec": "blocks generate spec",
    "vendorize": "blocks vendorize",
    "prebuild": "blocks-generate-client",
    "build": "tsc && vite build"
  },
  "blocks": {
    "dev": { "frontendCommand": "npx vite --port 3100 --strictPort", "frontendPort": 3100 }
  }
}
```

Backend-only templates (`api-only`, `backend`, `sql`) set `"blocks": { "dev": { "port": 3001 } }`; `nextjs` runs `npx next dev --webpack --hostname 127.0.0.1 --port 3100`. "Add to existing project" mode adds `sandbox`, `sandbox:destroy`, `sandbox:console`, `deploy`, `destroy`, `dev:server` and `dev:stop` the same way, and copies the template's `blocks.dev` unless your `package.json` already has one. The Amplify overlay adds `blocks:dev` (`blocks dev`, backend-only on port 3001) and `blocks:stop`, and keeps its own `aws-blocks/scripts/generate-client.ts` for `blocks:generate-client`, because its client needs the Amplify auth middleware and the API URL from `amplify_outputs.json`.

`npm run destroy` asks for confirmation in a terminal; in CI, run `npm run destroy -- --yes`.

## Templates

Available templates: `default`, `bare`, `react`, `backend`, `nextjs`, `auth-cognito`, `amplify`, `demo`.

Every folder under `templates/` is a self-registering template. Each `package.json` in that folder sets a `blocksTemplateDescription` field, which the CLI reads to build the `--help` catalog. To see the current list of templates and their one-line descriptions:

```bash
npx @aws-blocks/create-blocks-app --help
```

## Related Packages

- [blocks](https://github.com/aws-devtools-labs/aws-blocks/tree/main/packages/blocks#readme) - Core runtime and Building Blocks

## License

Apache-2.0
