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

This writes `aws-blocks/tsconfig.json`, a TypeScript project that checks the backend with Node types, and never edits your own `tsconfig`. To keep Node types out of your frontend, reference that project from the `tsconfig` that compiles the code importing `aws-blocks`, and typecheck with `tsc -b --force`: the CLI prints the steps, and [Keep Node types out of the frontend](https://github.com/aws-devtools-labs/aws-blocks/blob/main/docs/guides/upgrading-older-apps.md#keep-node-types-out-of-the-frontend) has them in full. In a Next.js project, it writes no `aws-blocks/tsconfig.json`: `next build` ignores project references, so the app's `tsconfig.json` keeps checking `aws-blocks/`.

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
│   ├── package.json      # Backend workspace dependencies
│   └── tsconfig.json     # Backend TypeScript project (not in a Next.js app)
├── cdk.json              # CDK configuration
├── src/
│   └── ...               # Your existing code
└── package.json          # Updated with Blocks scripts and "blocks" CLI settings
```

### Backend Structure

**aws-blocks/index.ts**
```typescript
import { ApiNamespace, Scope, Auth, KVStore, Realtime } from '@aws-blocks/blocks';
import { z } from 'zod';

const scope = new Scope('my-app');

// Email + password sign-in. Sign-up confirms the email address with a code;
// locally the code is printed in the `npm run dev` terminal. The email is the
// username and matches ignoring case — both fixed when the user pool is created.
const auth = new Auth(scope, 'auth', {
  users: { signInWith: ['email'], caseSensitive: false },
  codeDelivery: async (username, code, purpose) => {
    console.log(`[auth] ${purpose} code for ${username}: ${code}`);
  },
});
export const authApi = auth.createApi();

// Per-user data is keyed on the owner's `userSub`, stable for the user's lifetime.
const todoSchema = z.object({
  userSub: z.string(),
  todoId: z.string(),
  title: z.string(),
  completed: z.boolean(),
});

const todos = new KVStore(scope, 'todos', {
  schema: todoSchema,
  key: { partitionKey: 'userSub', sortKey: 'todoId' },
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
import { BlocksStack, BlocksPresets } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stackName = 'my-blocks-stack-prod';

const app = new cdk.App();
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: BlocksPresets.production,
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
    "typecheck": "tsc -b --force",
    "build": "tsc -b --force && vite build"
  },
  "blocks": {
    "dev": { "frontendPort": 3100 }
  }
}
```

No template sets `frontendCommand`: `cdk-blocks dev` starts the frontend dev server it detects from the app's dependencies (`npx vite --port <frontendPort> --strictPort` for `vite`, `npx next dev --webpack --hostname 127.0.0.1 --port <frontendPort>` for `next`), so `npm run dev -- --frontend-port 4100` moves it. Set `frontendCommand` only for another dev server, and give it the same port as `frontendPort`; `cdk-blocks dev` warns when the command does not contain that port. Backend-only templates (`api-only`, `backend`, `cron`, `sql`) set `"blocks": { "dev": { "port": 3001, "frontend": false } }`: `"frontend": false` keeps `cdk-blocks dev` backend-only even when the project has `vite` or `next` installed. "Add to existing project" mode adds `sandbox`, `sandbox:destroy`, `sandbox:console`, `deploy`, `destroy`, `dev:server` and `dev:stop` the same way. Unless your `package.json` already has `blocks.dev`, it copies only the template's `port` and `"frontend": false`: `--template backend`, `api-only`, `cron` or `sql` in a Vite or Next.js project runs the backend only, and any other template runs the project's own Vite or Next.js dev server. The Amplify overlay adds `blocks:dev` (`cdk-blocks dev`, backend-only on port 3001 through `"blocks": { "dev": { "port": 3001, "frontend": false } }`, because the Amplify app runs its own frontend) and `blocks:stop`, and keeps its own `aws-blocks/scripts/generate-client.ts` for `blocks:generate-client`, because its client needs the Amplify auth middleware and the API URL from `amplify_outputs.json`.

`npm run destroy` asks for confirmation in a terminal; in CI, run `npm run destroy -- --yes`. `npm run sandbox:destroy` also asks in a terminal; `npm run sandbox:destroy -- --yes` skips the question.

Apps that create-blocks-app 0.1.0 to 0.4.0 scaffolded run `aws-blocks/scripts/*.ts` wrappers. Run `npx --no -- cdk-blocks migrate` in such an app to switch its scripts to these aliases and delete the wrappers it generated (see [Migrating an app from `aws-blocks/scripts`](https://github.com/aws-devtools-labs/aws-blocks/tree/main/packages/blocks#migrating-an-app-from-aws-blocksscripts)).

### `@aws-blocks/*` Dependency Versions

Every `@aws-blocks/*` package the CLI writes into your `package.json` (and into `aws-blocks/package.json` for an Amplify Gen 2 project) gets a caret range on the release line this CLI version was tested with, for example:

```json
{
  "dependencies": {
    "@aws-blocks/blocks": "^0.9.0",
    "@aws-blocks/hosting": "^0.5.0"
  }
}
```

A reinstall stays on that release line and picks up later releases on it. Before 1.0, a new minor (`0.9.x` to `0.10.0`) is a new, breaking release line, and your app moves to it only when you edit the range. The CLI is released with every `@aws-blocks/blocks` release and has the same version number, so the latest CLI starts a new app on the latest `@aws-blocks/blocks` release. If you add AWS Blocks to an existing project that already lists one of these packages in `dependencies`, your range is kept. For an Amplify Gen 2 project, `aws-blocks/package.json` follows the root's range too (from `dependencies` or `devDependencies`) when it is a semver range; a `*`, path or protocol spec gets the stamp instead.

Apps scaffolded by an older CLI declare `"*"` instead, so their next clean install can pull a breaking release. Replace each `"*"` for an `@aws-blocks/*` package with a caret range for the version you have installed (`npm ls @aws-blocks/blocks` shows it), then run `npm install`.

## Templates

Available templates: `default`, `bare`, `react`, `backend`, `api-only`, `sql`, `nextjs`, `auth`, `agent`, `cron`, `observability`, `amplify`, `demo`.

The `auth` template was previously named `auth-cognito`; `--template auth-cognito` still works and scaffolds `auth`.

The Vite templates (`default`, `bare`, `react`, `auth`, `agent`, `demo`) typecheck the browser and the backend as separate [TypeScript projects](https://www.typescriptlang.org/docs/handbook/project-references.html), the way create-vite's `react-ts` template does: `tsconfig.app.json` checks `src/` with `"types": ["vite/client"]`, so a Node global there is an error, and `aws-blocks/tsconfig.json` checks the backend with Node types. `nextjs` and the backend-only templates keep one `tsconfig.json` with Node types. [Keep Node types out of the frontend](https://github.com/aws-devtools-labs/aws-blocks/blob/main/docs/guides/upgrading-older-apps.md#keep-node-types-out-of-the-frontend) explains the layout and how to move an older app to it.

Every folder under `templates/` is a self-registering template. Each `package.json` in that folder sets a `blocksTemplateDescription` field, which the CLI reads to build the `--help` catalog. To see the current list of templates and their one-line descriptions:

```bash
npx @aws-blocks/create-blocks-app --help
```

A template declares each `@aws-blocks/*` dependency as `"*"`, a placeholder. Inside this monorepo the CLI rewrites the placeholders in the app's root `package.json` to `file:` paths to the sibling packages. From the published CLI it stamps the range listed for that package in create-blocks-app's own `devDependencies`, which `changeset version` keeps on the package's current release line. So when a template starts using another `@aws-blocks/*` package, add it to create-blocks-app's `devDependencies` too; the unit tests fail until you do. A devDependency bump never releases the CLI on its own, so `.changeset/config.json` puts create-blocks-app and `@aws-blocks/blocks` in one `fixed` group: every blocks release also releases the CLI, at the same version number, with the updated ranges. A new release line of a package blocks depends on (such as `@aws-blocks/hosting`) falls outside blocks' caret range for it, so changesets releases blocks, and with it the CLI. So a template should import Building Blocks from `@aws-blocks/blocks`, and only write an `@aws-blocks/*` package that blocks itself lists in `dependencies`.

## Related Packages

- [blocks](https://github.com/aws-devtools-labs/aws-blocks/tree/main/packages/blocks#readme) - Core runtime and Building Blocks

## License

Apache-2.0
