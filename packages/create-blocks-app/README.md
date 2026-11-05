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

In an npm workspaces monorepo, the app's `aws-blocks/` folder has to be a workspace of the monorepo root too: npm installs the app's dependencies at the root and does not read the app's own `"workspaces": ["aws-blocks"]`. When the app is a workspace of an enclosing root that does not list `<app>/aws-blocks`, `create-blocks-app` stops before it writes anything and prints the `"workspaces"` entry to add; add it and run the command again.

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

Every lifecycle script is a thin alias of the `cdk-blocks` CLI that ships with `@aws-blocks/blocks`: `npm run deploy` runs `cdk-blocks deploy`. Run `npx --no -- cdk-blocks --help` in the app for every command and its options. The dev server settings live in `package.json#blocks.dev`.

```json
{
  "scripts": {
    "dev": "cdk-blocks dev",
    "dev:stop": "cdk-blocks dev stop",
    "sandbox": "cdk-blocks sandbox",
    "sandbox:deploy": "cdk-blocks sandbox deploy",
    "sandbox:preview": "cdk-blocks sandbox preview",
    "sandbox:destroy": "cdk-blocks sandbox destroy",
    "sandbox:console": "cdk-blocks sandbox console",
    "cleanup": "cdk-blocks dev stop --all",
    "deploy": "cdk-blocks deploy",
    "destroy": "cdk-blocks destroy",
    "secret": "cdk-blocks secret",
    "typegen": "cdk-blocks generate types",
    "spec": "cdk-blocks generate spec",
    "vendorize": "cdk-blocks vendorize",
    "prebuild": "cdk-blocks generate client",
    "build": "tsc && vite build"
  },
  "blocks": {
    "dev": { "frontendPort": 3100 }
  }
}
```

No template sets `frontendCommand`: `cdk-blocks dev` starts the frontend dev server it detects from the app's dependencies (`npx vite --port <frontendPort> --strictPort` for `vite`, `npx next dev --webpack --hostname 127.0.0.1 --port <frontendPort>` for `next`), so `npm run dev -- --frontend-port 4100` moves it. Set `frontendCommand` only for another dev server, and give it the same port as `frontendPort`; `cdk-blocks dev` warns when the command does not contain that port. Backend-only templates (`api-only`, `backend`, `sql`) set `"blocks": { "dev": { "port": 3001, "frontend": false } }`: `"frontend": false` keeps `cdk-blocks dev` backend-only even when the project has `vite` or `next` installed. "Add to existing project" mode adds `sandbox`, `sandbox:destroy`, `sandbox:console`, `deploy`, `destroy`, `dev:server` and `dev:stop` the same way. Unless your `package.json` already has `blocks.dev`, it copies only the template's `port` and `"frontend": false`: `--template backend`, `api-only` or `sql` in a Vite or Next.js project runs the backend only, and any other template runs the project's own Vite or Next.js dev server. The Amplify overlay adds `blocks:dev` (`cdk-blocks dev`, backend-only on port 3001 through `"blocks": { "dev": { "port": 3001, "frontend": false } }`, because the Amplify app runs its own frontend) and `blocks:stop`, and keeps its own `aws-blocks/scripts/generate-client.ts` for `blocks:generate-client`, because its client needs the Amplify auth middleware and the API URL from `amplify_outputs.json`.

`npm run destroy` asks for confirmation in a terminal; in CI, run `npm run destroy -- --yes`. `npm run sandbox:destroy` also asks in a terminal; `npm run sandbox:destroy -- --yes` skips the question.

## Templates

Available templates: `default`, `bare`, `react`, `backend`, `nextjs`, `auth-cognito`, `auth-oidc`, `cron`, `amplify`, `demo`.

Every folder under `templates/` is a self-registering template. Each `package.json` in that folder sets a `blocksTemplateDescription` field, which the CLI reads to build the `--help` catalog. To see the current list of templates and their one-line descriptions:

```bash
npx @aws-blocks/create-blocks-app --help
```

## Related Packages

- [blocks](https://github.com/aws-devtools-labs/aws-blocks/tree/main/packages/blocks#readme) - Core runtime and Building Blocks

## License

Apache-2.0
