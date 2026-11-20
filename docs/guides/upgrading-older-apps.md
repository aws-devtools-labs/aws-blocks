# Upgrading an older app

An app keeps the `cdk-blocks/index.cdk.ts` that `create-blocks-app` copied into it when it was scaffolded. Upgrading `aws-cdk-blocks` doesn't change that file. Templates declare `"aws-cdk-blocks": "*"`, so a fresh install of an old app pulls the current release, and an `index.cdk.ts` written for an older release can stop synthesizing.

Find your app's shape below and apply the edits. Every other file is unchanged.

| Template version | What you see on current `aws-cdk-blocks` |
|---|---|
| 0.1.0 to 0.1.19 | `BlocksStack.create() requires a \`defaults\` field` (older releases: `TypeError: Cannot read properties of undefined (reading 'vpc')`) |
| 0.1.20 to 0.2.0 | `error TS2339: Property 'handler' does not exist on type 'BlocksStack'` |
| 0.3.0 and later | Nothing to change |
| Any version before the `cdk-blocks/` rename | `Cannot find module 'aws-blocks'` |

A deploy can fail with `CloudFormation cannot update a stack when a custom-named resource requires replacing` on the table of a `KVStore`. The cause is then the `KVStore` release, not the template. See [A `KVStore` from release 0.4.0 or earlier](#a-kvstore-from-release-040-or-earlier-custom-named-resource-requires-replacing).

An app with a `DistributedDatabase` keeps its Aurora DSQL cluster when the block becomes a `Database`. See [A `DistributedDatabase`: keep its cluster with `Database`](#a-distributeddatabase-keep-its-cluster-with-database). An app with a `Database` of `@aws-blocks/bb-data` keeps its Aurora cluster with `LegacyDatabaseCluster`. See [A `Database` of `@aws-blocks/bb-data`](#a-database-of-aws-blocksbb-data-keep-its-cluster-with-legacydatabasecluster).

## Rename `aws-blocks/` to `cdk-blocks/`

The scaffolded backend folder is `cdk-blocks/`. An app scaffolded before the rename keeps `aws-blocks/`, and its frontend cannot resolve the backend until the folder, the workspace that names it and the imports move together. `cdk-blocks migrate` rewrites script wrappers only; it does not move the folder or rewrite imports.

From the app root:

```sh
git mv aws-blocks cdk-blocks
```

Then set `"name": "cdk-blocks"` in `cdk-blocks/package.json`, change the `"workspaces"` entry that names it from `"aws-blocks"` to `"cdk-blocks"`, and replace every `from 'aws-blocks'` import with `from 'cdk-blocks'`. Run `npm install` afterwards so npm relinks the workspace.

If the app uses `Database` with the default migrations root, move `aws-blocks/migrations` to `cdk-blocks/migrations` as part of the `git mv`, or pass an explicit migrations path.

## 0.1.0 to 0.1.19: add `defaults`, drop the sandbox overrides

`BlocksStack.create` now takes a `defaults` posture. `BlocksPresets.sandbox` already applies the destroy-on-delete removal policy and turns off deletion protection, which these templates did by hand, so those lines go.

Before:

```ts
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
import { Hosting, BlocksStack, SandboxDisableDeletionProtection } from 'aws-cdk-blocks/cdk';

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
import { Hosting, BlocksStack, BlocksPresets } from 'aws-cdk-blocks/cdk';

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production,
});
```

Then apply the 0.1.20 to 0.2.0 change below if your `cdk-blocks/index.ts` passes `crossDomain: process.env.BLOCKS_SANDBOX === 'true'` to an auth Building Block.

## 0.1.20 to 0.2.0: remove `blocksStack.handler`

`BlocksStack.handler` was removed. It reached only the default compute's function, not every compute an app runs on. These templates used it only to set `BLOCKS_SANDBOX`, which current releases don't need: `npm run sandbox` serves the app through the local dev server, so the browser talks to `localhost` only and the default session cookie works.

Delete this block from `cdk-blocks/index.cdk.ts`:

```ts
if (sandboxMode) {
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');
}
```

If `cdk-blocks/index.ts` passes `crossDomain: process.env.BLOCKS_SANDBOX === 'true'` to an auth Building Block, delete that line too. Set `crossDomain: true` yourself only when a frontend on a different registrable domain calls the API directly.

If your own code uses `blocksStack.handler`, use the stack-wide equivalents, which reach every compute:

| Before | After |
|---|---|
| `blocksStack.handler.addEnvironment('KEY', value)` | `registerConfig(blocksStack, 'KEY', value)` |
| `resource.grantRead(blocksStack.handler)` | `resource.grantRead(blocksStack.executionRole)` |
| `blocksStack.handler.addToRolePolicy(statement)` | `blocksStack.executionRole.addToPrincipalPolicy(statement)` |

`registerConfig` is exported from `aws-cdk-blocks/cdk`. Values it registers are loaded into `process.env` on every compute at cold start, but a real environment variable of the same name wins.

## A `KVStore` from release 0.4.0 or earlier: `custom-named resource requires replacing`

This section is for an app that deployed a `KVStore` with `@aws-cdk-blocks/bb-kv-store` 0.4.0 or earlier and now deploys on a later release. The cause is the Building Block, not the template. The deploy fails on the table of that store:

```text
CloudFormation cannot update a stack when a custom-named resource requires replacing. Rename <table name> and update the stack again.
```

The stack rolls back, and the table keeps its items.

Release 0.4.0 or earlier keeps each item as `{ pk, value: <JSON text>, ttl? }`. Later releases key the table by another attribute and keep one attribute for each field. DynamoDB cannot change the key of a table, and CloudFormation does not replace a table that has a fixed name. So the new `KVStore` cannot take over the old table. Don't rename or delete the table to get past the error: your items are in it.

Keep the old table with `LegacyKVStore`, and migrate its items to a `KVStore` with a new id:

1. In `cdk-blocks/index.ts`, change the class on the line of the old store to `LegacyKVStore`. Keep its id and every option it had. Add a `KVStore` with a new id next to it:

   ```ts
   import { KVStore, LegacyKVStore } from 'aws-cdk-blocks';

   // Before: const prefs = new KVStore<Prefs>(scope, 'prefs', { ttl: true });
   const oldPrefs = new LegacyKVStore<Prefs>(scope, 'prefs', { ttl: true });
   const prefs = new KVStore<Prefs>(scope, 'prefs-v2');
   ```

   Deploy. The deploy goes through: it creates the table of `prefs-v2` and doesn't change the old one. `LegacyKVStore` has the `get`, `put`, `delete`, and `scan` of release 0.4.0. Its `scan` adds `limit`, `cursor`, and expiry metadata; its `get` defaults to a strongly consistent read at twice the read capacity. Pass `{ consistentRead: false }` to keep eventually consistent reads.

2. Migrate the data however is appropriate for your app. `LegacyKVStore` does not copy the items. The [`KVStore` README](../../packages/bb-kv-store/README.md#step-2-migrate-the-data) describes one way to migrate while the app stays live and explains its limits.

3. When the data is in the new store, remove the `LegacyKVStore` line and any read of the old store, and deploy. The old table leaves the stack. A table with a removal policy of `destroy` is deleted. A retained table, which is the default of the production preset, stays in your account until you delete it.

`LegacyKVStore` is deprecated and frozen. It exists only for this upgrade, it has the methods of release 0.4.0, and it gets no new features. Use `KVStore` for anything new. The [`KVStore` README](../../packages/bb-kv-store/README.md#upgrade-from-release-040-or-earlier) has the options to keep and what to know before you start. For example, the table name changes with the id.

## A `DistributedDatabase`: keep its cluster with `Database`

This section is for an app that deployed a `DistributedDatabase` with `@aws-blocks/bb-distributed-data` and now deploys on a release where `aws-cdk-blocks` exports `Database` and no `DistributedDatabase`.

A `Database` with no `cluster` option owns an Aurora DSQL cluster, as `DistributedDatabase` did. When the `Database` has the id of the `DistributedDatabase`, in the same scope and the same stack, it is the same cluster to CloudFormation. The deploy keeps the cluster and its rows.

1. In `cdk-blocks/index.ts`, change the class to `Database`. Keep the id, the scope, and `migrationsPath`:

   ```ts
   import { Database, sql } from 'aws-cdk-blocks';

   // Before: const ledger = new DistributedDatabase(scope, 'ledger', { migrationsPath: './aws-blocks/dsql-migrations' });
   const ledger = new Database(scope, 'ledger', { migrationsPath: './aws-blocks/dsql-migrations' });
   ```

   `query`, `queryOne`, `execute`, `transaction`, and `sql` take the same arguments. `DatabaseErrors` has every name of `DistributedDatabaseErrors`.

2. Keep the migration files and their names. `Database` reads the `_migrations` table that `DistributedDatabase` wrote, so a file that is applied does not run again. Put new files in the same directory.

3. Before you deploy, run `cdk diff`. The cluster (`AWS::DSQL::Cluster`) must show as changed (`[~]`: it gets tags), not as removed (`[-]`) and added (`[+]`). A removed cluster means that the id, the scope, or the stack name is not the one of the `DistributedDatabase`. With the removal policy `destroy`, which is the sandbox default, a deploy deletes a removed cluster with its rows.

4. Deploy. The migration functions of `DistributedDatabase` leave the stack, and those of `Database` take their place.

This path is only for `DistributedDatabase`. For a `Database` of `@aws-blocks/bb-data`, see the next section.

## A `Database` of `@aws-blocks/bb-data`: keep its cluster with `LegacyDatabaseCluster`

This section is for an app that deployed `Database` with `@aws-blocks/bb-data` and now deploys on a release where `Database` comes from `@aws-cdk-blocks/bb-database`.

The old `Database` owned an Aurora PostgreSQL cluster in a VPC. The new `Database` owns a different kind of cluster, so the same line of code would give you a new, empty database, and the deploy would delete the credentials secret of the old cluster. Keep the old cluster with `LegacyDatabaseCluster`, and run a `Database` with a new id on it:

```ts
import { Database, LegacyDatabaseCluster } from 'aws-cdk-blocks';

// Before: const db = new Database(scope, 'main', { minCapacity: 1, migrationsPath: './cdk-blocks/migrations' });
const cluster = new LegacyDatabaseCluster(scope, 'main', { minCapacity: 1 });
const db = new Database(scope, 'main-db', { cluster, migrationsPath: './cdk-blocks/migrations' });
```

Run `cdk diff` before you deploy. The [`Database` README](../../packages/bb-database/README.md#upgrade-from-aws-blocksbb-data) has the steps, the options to keep, and what to know before you remove the `LegacyDatabaseCluster`.

## Keep Node types out of the frontend

This one is optional: nothing stops working if you skip it. It is for:

- an app scaffolded from a Vite template (`default`, `bare`, `react`, `auth`, `agent`, `demo`) whose `tsconfig.json` still lists `cdk-blocks/**/*` in `include`, and
- a project you added AWS CDK Blocks to, when its frontend `tsconfig` sets `types` (such as create-vite's `"types": ["vite/client"]`) and `tsc` reports `error TS2591: Cannot find name 'process'` in `cdk-blocks/`.

The frontend imports the backend (`import { api } from 'cdk-blocks'`), so its `tsconfig` typechecks the backend source with the frontend's settings. A single `tsconfig.json` with Node types makes that pass, but it also lets browser code use `process` or `Buffer` without an error. Current templates make the backend a TypeScript project of its own, with Node types, and the frontend reads it through a [project reference](https://www.typescriptlang.org/docs/handbook/project-references.html). `tsc -b` builds the backend's declarations into `node_modules/.tmp/` first.

Skip this for a Next.js app: `next build` ignores project references when it type-checks, so it checks `cdk-blocks/` with the app's `tsconfig.json` either way, and that needs Node types (a `tsconfig.json` that sets no `types` has them). Skip it for a backend-only app (`backend`, `api-only`, `sql`, `cron`, `observability`, `observability`) too: all its code runs on Node.

### An app from a CDK Blocks Vite template

1. Copy the TypeScript files of a fresh scaffold of the same template (pass its name to `--template`), made in a folder outside your app (on Windows, pick another folder than `/tmp`):

   ```bash
   npx @aws-cdk-blocks/create-blocks-app@latest /tmp/fresh-app --template default --skip-install
   cp /tmp/fresh-app/tsconfig.json /tmp/fresh-app/tsconfig.app.json /tmp/fresh-app/tsconfig.node.json .
   cp /tmp/fresh-app/cdk-blocks/tsconfig.json cdk-blocks/
   ```

   This replaces your `tsconfig.json`. If you added options to it (such as `paths`), add them again to the file that compiles the code using them: `tsconfig.app.json` (`src/`), `tsconfig.node.json` (`vite.config.ts`, `test/`) or `cdk-blocks/tsconfig.json` (the backend).

2. In `package.json`, use the scripts of the fresh scaffold:

   ```json
   "typecheck": "tsc -b --force",
   "build": "tsc -b --force && vite build",
   "test:e2e": "tsx --tsconfig tsconfig.node.json -C browser --test-force-exit test/e2e.test.ts"
   ```

3. Run `npm run typecheck`. Browser code that used a Node global now fails with `TS2591` (`TS2307` for a `node:` import). Move that code into the backend, or read build-time values with `import.meta.env`.

### Any other project

1. Give the backend its own project: copy [the default template's `cdk-blocks/tsconfig.json`](../../packages/create-blocks-app/templates/default/cdk-blocks/tsconfig.json) into `cdk-blocks/`. Adding CDK Blocks to a project with `create-blocks-app` already wrote it. Make sure `@types/node` is in your `devDependencies`.

2. In the `tsconfig` that compiles the code importing `cdk-blocks` (`tsconfig.app.json` in a create-vite app, otherwise `tsconfig.json`), add:

   ```jsonc
   "references": [{ "path": "./cdk-blocks" }]
   ```

3. Typecheck in build mode, which builds the referenced backend first: `tsc -b --force` instead of `tsc` (a create-vite app's `"build": "tsc -b && vite build"` already is). If your script passed `--noEmit`, set `"noEmit": true` in that `tsconfig` instead: `tsc -b --noEmit` fails with `TS6310`, and without `noEmit` (or an `outDir`) `tsc -b` writes `.js` files next to your sources.

### Notes

- `--force` is there because on TypeScript 5.x, `tsc -b` skips a project whose own files did not change and does not notice a changed package in `node_modules`, so after a dependency upgrade it can pass where the new types fail. It costs under a second.
- A plain `tsc -p tsconfig.app.json` does not build the backend: before the first `tsc -b`, or after `node_modules` is reinstalled, it reports `error TS6305: Output file '.../node_modules/.tmp/cdk-blocks/cdk-blocks/index.d.ts' has not been built`. Run `npm run typecheck`. At a root `tsconfig.json` that only lists references, `npx tsc --noEmit` checks nothing.
- A backend file that imports a `.json` file, or a file outside `cdk-blocks/`, fails with `TS6307: File '...' is not listed within the file list of project`. Add its folder to `include` in `cdk-blocks/tsconfig.json`, for example `"data/**/*.json"`.
- Code that both the browser and the backend import does not belong in the backend's `include`: the frontend would then read it through the backend's declarations, checked with Node types, and a `Buffer` in it would pass. Give it a project of its own without Node types, and reference that project from `cdk-blocks/tsconfig.json` and from the frontend `tsconfig`. For a `shared/` folder, `shared/tsconfig.json`:

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

  Then add `{ "path": "../shared" }` to `references` in `cdk-blocks/tsconfig.json`, and `{ "path": "./shared" }` to those of `tsconfig.app.json`.
- A backend method whose signature uses a Node type, such as one that returns a `Buffer`, reads as `any` in the frontend, with no error (`skipLibCheck` hides it). Return plain JSON-serializable values from API methods.
- [TROUBLESHOOTING.md](../../packages/blocks/TROUBLESHOOTING.md#typescript-errors-in-cdk-blocks-from-the-frontend) lists the errors of this layout, including `TS2742` under pnpm.

## Keep the next upgrade from surprising you

Pin `aws-cdk-blocks` (for example `"^0.9.0"` instead of `"*"`) in `package.json`, so a fresh install doesn't pull a release with breaking changes. Check the package's `CHANGELOG.md` when you move the range.
