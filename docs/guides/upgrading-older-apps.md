# Upgrading an app from an older template

An app keeps the `aws-blocks/index.cdk.ts` that `create-blocks-app` copied into it when it was scaffolded. Upgrading `@aws-blocks/blocks` doesn't change that file. Templates declare `"@aws-blocks/blocks": "*"`, so a fresh install of an old app pulls the current release, and an `index.cdk.ts` written for an older release can stop synthesizing.

Find your app's shape below and apply the edits. Every other file is unchanged.

| Template version | What you see on current `@aws-blocks/blocks` |
|---|---|
| 0.1.0 to 0.1.19 | `BlocksStack.create() requires a \`defaults\` field` (older releases: `TypeError: Cannot read properties of undefined (reading 'vpc')`) |
| 0.1.20 to 0.2.0 | `error TS2339: Property 'handler' does not exist on type 'BlocksStack'` |
| 0.3.0 and later | Nothing to change |

## 0.1.0 to 0.1.19: add `defaults`, drop the sandbox overrides

`BlocksStack.create` now takes a `defaults` posture. `BlocksPresets.sandbox` already applies the destroy-on-delete removal policy and turns off deletion protection, which these templates did by hand, so those lines go.

Before:

```ts
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
import { Hosting, BlocksStack, SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts')
});

if (sandboxMode) {
  RemovalPolicies.of(blocksStack).destroy();
  Mixins.of(blocksStack).apply(new SandboxDisableDeletionProtection());
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');
}
```

After:

```ts
import { Hosting, BlocksStack, BlocksPresets } from '@aws-blocks/blocks/cdk';

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production,
});
```

Then apply the 0.1.20 to 0.2.0 change below if your `aws-blocks/index.ts` passes `crossDomain: process.env.BLOCKS_SANDBOX === 'true'` to an auth Building Block.

## 0.1.20 to 0.2.0: remove `blocksStack.handler`

`BlocksStack.handler` was removed. It reached only the default compute's function, not every compute an app runs on. These templates used it only to set `BLOCKS_SANDBOX`, which current releases don't need: `npm run sandbox` serves the app through the local dev server, so the browser talks to `localhost` only and the default session cookie works.

Delete this block from `aws-blocks/index.cdk.ts`:

```ts
if (sandboxMode) {
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');
}
```

If `aws-blocks/index.ts` passes `crossDomain: process.env.BLOCKS_SANDBOX === 'true'` to an auth Building Block, delete that line too. Set `crossDomain: true` yourself only when a frontend on a different registrable domain calls the API directly.

If your own code uses `blocksStack.handler`, use the stack-wide equivalents, which reach every compute:

| Before | After |
|---|---|
| `blocksStack.handler.addEnvironment('KEY', value)` | `registerConfig(blocksStack, 'KEY', value)` |
| `resource.grantRead(blocksStack.handler)` | `resource.grantRead(blocksStack.executionRole)` |
| `blocksStack.handler.addToRolePolicy(statement)` | `blocksStack.executionRole.addToPrincipalPolicy(statement)` |

`registerConfig` is exported from `@aws-blocks/blocks/cdk`. Values it registers are loaded into `process.env` on every compute at cold start, but a real environment variable of the same name wins.

## Keep Node types out of the frontend

This one is optional: nothing stops working if you skip it. It is for:

- an app scaffolded from a Vite template (`default`, `bare`, `react`, `auth-cognito`, `demo`) whose `tsconfig.json` still lists `aws-blocks/**/*` in `include`, and
- a project you added AWS Blocks to, when its frontend `tsconfig` sets `types` (such as create-vite's `"types": ["vite/client"]`) and `tsc` reports `error TS2591: Cannot find name 'process'` in `aws-blocks/`.

The frontend imports the backend (`import { api } from 'aws-blocks'`), so its `tsconfig` typechecks the backend source with the frontend's settings. A single `tsconfig.json` with Node types makes that pass, but it also lets browser code use `process` or `Buffer` without an error. Current templates make the backend a TypeScript project of its own, with Node types, and the frontend reads it through a [project reference](https://www.typescriptlang.org/docs/handbook/project-references.html). `tsc -b` builds the backend's declarations into `node_modules/.tmp/` first.

Skip this for a Next.js app: `next build` ignores project references when it type-checks, so it checks `aws-blocks/` with the app's `tsconfig.json` either way, and that needs Node types (a `tsconfig.json` that sets no `types` has them). Skip it for a backend-only app (`backend`, `api-only`, `sql`, `cron`) too: all its code runs on Node.

### An app from a Blocks Vite template

1. Copy the TypeScript files of a fresh scaffold of the same template (pass its name to `--template`), made in a folder outside your app (on Windows, pick another folder than `/tmp`):

   ```bash
   npx @aws-blocks/create-blocks-app@latest /tmp/fresh-app --template default --skip-install
   cp /tmp/fresh-app/tsconfig.json /tmp/fresh-app/tsconfig.app.json /tmp/fresh-app/tsconfig.node.json .
   cp /tmp/fresh-app/aws-blocks/tsconfig.json aws-blocks/
   ```

   This replaces your `tsconfig.json`. If you added options to it (such as `paths`), add them again to the file that compiles the code using them: `tsconfig.app.json` (`src/`), `tsconfig.node.json` (`vite.config.ts`, `test/`) or `aws-blocks/tsconfig.json` (the backend).

2. In `package.json`, use the scripts of the fresh scaffold:

   ```json
   "typecheck": "tsc -b --force",
   "build": "tsc -b --force && vite build",
   "test:e2e": "tsx --tsconfig tsconfig.node.json -C browser --test-force-exit test/e2e.test.ts"
   ```

3. Run `npm run typecheck`. Browser code that used a Node global now fails with `TS2591` (`TS2307` for a `node:` import). Move that code into the backend, or read build-time values with `import.meta.env`.

### Any other project

1. Give the backend its own project: copy [the default template's `aws-blocks/tsconfig.json`](../../packages/create-blocks-app/templates/default/aws-blocks/tsconfig.json) into `aws-blocks/`. Adding AWS Blocks to a project with `create-blocks-app` already wrote it. Make sure `@types/node` is in your `devDependencies`.

2. In the `tsconfig` that compiles the code importing `aws-blocks` (`tsconfig.app.json` in a create-vite app, otherwise `tsconfig.json`), add:

   ```jsonc
   "references": [{ "path": "./aws-blocks" }]
   ```

3. Typecheck in build mode, which builds the referenced backend first: `tsc -b --force` instead of `tsc` (a create-vite app's `"build": "tsc -b && vite build"` already is). If your script passed `--noEmit`, set `"noEmit": true` in that `tsconfig` instead: `tsc -b --noEmit` fails with `TS6310`, and without `noEmit` (or an `outDir`) `tsc -b` writes `.js` files next to your sources.

### Notes

- `--force` is there because on TypeScript 5.x, `tsc -b` skips a project whose own files did not change and does not notice a changed package in `node_modules`, so after a dependency upgrade it can pass where the new types fail. It costs under a second.
- A plain `tsc -p tsconfig.app.json` does not build the backend: before the first `tsc -b`, or after `node_modules` is reinstalled, it reports `error TS6305: Output file '.../node_modules/.tmp/aws-blocks/aws-blocks/index.d.ts' has not been built`. Run `npm run typecheck`. At a root `tsconfig.json` that only lists references, `npx tsc --noEmit` checks nothing.
- A backend file that imports a `.json` file, or a file outside `aws-blocks/`, fails with `TS6307: File '...' is not listed within the file list of project`. Add its folder to `include` in `aws-blocks/tsconfig.json`, for example `"data/**/*.json"`.
- Code that both the browser and the backend import does not belong in the backend's `include`: the frontend would then read it through the backend's declarations, checked with Node types, and a `Buffer` in it would pass. Give it a project of its own without Node types, and reference that project from `aws-blocks/tsconfig.json` and from the frontend `tsconfig`. For a `shared/` folder, `shared/tsconfig.json`:

  ```jsonc
  {
    "compilerOptions": {
      "composite": true,
      "emitDeclarationOnly": true,
      "outDir": "../node_modules/.tmp/shared",
      "rootDir": "..",
      "target": "ES2022",
      "module": "ES2022",
      "moduleResolution": "bundler",
      "lib": ["ESNext", "DOM"],
      "types": [],
      "strict": true,
      "skipLibCheck": true
    },
    "include": ["**/*"]
  }
  ```

  Then add `{ "path": "../shared" }` to `references` in `aws-blocks/tsconfig.json`, and `{ "path": "./shared" }` to those of `tsconfig.app.json`.
- A backend method whose signature uses a Node type, such as one that returns a `Buffer`, reads as `any` in the frontend, with no error (`skipLibCheck` hides it). Return plain JSON-serializable values from API methods.
- [TROUBLESHOOTING.md](../../packages/blocks/TROUBLESHOOTING.md#typescript-errors-in-aws-blocks-from-the-frontend) lists the errors of this layout, including `TS2742` under pnpm.

## Keep the next upgrade from surprising you

Pin `@aws-blocks/blocks` (for example `"^0.9.0"` instead of `"*"`) in `package.json`, so a fresh install doesn't pull a release with breaking changes. Check the package's `CHANGELOG.md` when you move the range.
