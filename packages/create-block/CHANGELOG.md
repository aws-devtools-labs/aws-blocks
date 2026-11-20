# @aws-blocks/create-block

## 1.0.0-rc.1

### Patch Changes

- fbe48c5: Local data moved from `.bb-data/{fullId}/` to `.cdk-blocks/local/data/{fullId}/`. Existing data is copied over on first use. The `@aws-cdk-blocks/core` changelog has the upgrade steps.
- e529b00: fix(blocks): client code can now import the block error constants, `isBlocksError`, and `ApiError` from `aws-cdk-blocks`. Before, `import { KVStoreErrors } from 'aws-cdk-blocks'` type-checked and then failed in the browser with `does not provide an export named 'KVStoreErrors'`. The Building Block classes and `sql` are still server-only, so browser code uses `import type` for their types. `aws-cdk-blocks` now also exports `RealtimeErrors`.

## 1.0.0-rc.0

### Major Changes

- e50b9e9: Rename every published package from the `@aws-blocks` scope to `@aws-cdk-blocks`. The umbrella package is now unscoped: `@aws-blocks/blocks` becomes `aws-cdk-blocks`.

  No export or option moved. To upgrade, replace the dependency names in `package.json` and the specifiers in every import:

  ```diff
   {
     "dependencies": {
  -    "@aws-blocks/blocks": "<your range>",
  -    "@aws-blocks/core": "<your range>"
  +    "aws-cdk-blocks": "<your range>",
  +    "@aws-cdk-blocks/core": "<your range>"
     }
   }
  ```

  ```diff
  -import { KVStore } from '@aws-blocks/blocks';
  +import { KVStore } from 'aws-cdk-blocks';

  -import { ApiNamespace } from '@aws-blocks/core';
  +import { ApiNamespace } from '@aws-cdk-blocks/core';
  ```

  Warning IDs reported at synth carry the package name, so they now start with `@aws-cdk-blocks/` instead of `@aws-blocks/`: update any `Annotations.of(stack).acknowledgeWarning('@aws-blocks/…')` call to the new prefix. An acknowledgement left on an old ID silently stops matching, the warning comes back, and `cdk synth --strict` fails on it.

  The `cdk-blocks` CLI binary, the `aws-blocks` keyword used to discover third-party blocks, and the `aws-blocks` manifest key that carries the `native` and `vendorize` declarations are all unchanged, so a published third-party block is still discovered and still loads its manifest without a republish. A block that depends on `@aws-blocks/core` brings its own copy of core alongside the app's `@aws-cdk-blocks/core`, which is two module instances; block authors should move the dependency to `@aws-cdk-blocks/core`.

  The CDK context key `@aws-blocks/bb-data:encryptStorageByDefault` keeps its name too. `LegacyDatabaseCluster` reads it out of your `cdk.json`, where apps scaffolded before the cutover already set it, and no package was ever published under a `@aws-cdk-blocks/bb-data` name. Renaming the key would leave `StorageEncrypted` unset on a cluster deployed with it on, which CloudFormation answers by replacing the cluster. Keep the key as it is.

  The old `@aws-blocks/*` packages stop receiving releases.

### Minor Changes

- 703238f: refactor: rename the scaffolded backend folder to `cdk-blocks`

  `create-blocks-app` now scaffolds the backend into `cdk-blocks/`, the folder's own package is named `cdk-blocks`, the parent lists it under `"workspaces"`, and the frontend imports it as `cdk-blocks`.

  `@aws-cdk-blocks/bb-database` moves its default migrations root with the folder: `DEFAULT_MIGRATIONS_ROOT` is now `./cdk-blocks/migrations`, and `db pull` writes `cdk-blocks/database.types.ts` by default. An app that keeps an `aws-blocks/migrations` directory finds no migrations after upgrading, so rename the directory or set an explicit migrations path.

  **Breaking: the scaffolded backend folder is `cdk-blocks/`, not `aws-blocks/`.** An existing app renames the directory, the `"workspaces"` entry that names it, the `"name"` in its `cdk-blocks/package.json`, and every `from 'aws-blocks'` import. There is no dual-name support and no compatibility shim.

  The reserved URL namespace (`/aws-blocks/api`, `/aws-blocks/auth/*`, `/aws-blocks/dashboard`) keeps its path, so deployed API Gateway routes and OAuth callback URLs already registered with an identity provider keep working.

### Patch Changes

- aaf419f: Run the CDK commands of the sandbox, deploy and destroy scripts without a shell

  The `cdk` children the lifecycle scripts start (`synth`, `deploy`, `watch`,
  `destroy`) now always get their arguments as separate argv entries, never
  through a shell. Only the sandbox's local dev-server command, which is a
  configurable command line, still runs under a shell. `create-block` trims
  trailing whitespace with `String.prototype.trimEnd()` when it wires a new
  block's exports, with the same result.

- e098c7a: New Building Blocks scaffolded inside the AWS Blocks repo now get a JSDoc pointer
  to their docs bundled in `aws-cdk-blocks` (`docs/<package>/README.md`),
  matching the other re-exports, instead of a `node_modules` package directory.
- afb2707: Fix the external-mode "Next steps" `cd` hint to use the `--dir` target instead of the default package folder name, shell-quoting the path when it contains spaces or shell metacharacters so the printed command can be pasted safely.

## 0.3.0

### Minor Changes

- 88747f5: feat: Building Block mock entries fail closed in a deployed environment

  - **Runtime guard.** `@aws-blocks/core/bb-utils` exports `assertNotMockInDeployedEnv(bbName)`, the runtime counterpart of the `--conditions=cdk` synth check. It throws when a Building Block's mock (`default` export) entry is loaded in a deployed environment, which happens when the backend was bundled without the `aws-runtime` export condition. A deployed environment is detected from `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY`, which Blocks sets on every compute it provisions (Lambda, container, AgentCore). On compute Blocks doesn't configure, the check is inert and the `aws-runtime` bundler condition is the only protection. It is a no-op in local dev and tests.
  - **Wired into every BB mock entry.** Each Building Block's mock entry calls the guard at module load, so a mis-bundled artifact throws instead of running in-memory stubs: at process start on container and AgentCore computes, and on the first invocation on Lambda (where the backend is imported lazily, so the deploy succeeds and requests then return an error).
  - **AuthOIDC mock cookie secret.** The mock runtime's cookie-signing secret is now random per project instead of a fixed string, persisted (mode 0600) under the instance's `.bb-data/` mock data dir so local sessions survive backend reloads and dev-server restarts. Local sign-in is unchanged.
  - **Bundler conditions.** The `@aws-blocks/hosting` handler bundle and the AuthOIDC IdP-registration and DistributedTable GSI-manager Lambda bundles now pin the `aws-runtime` condition. The hosting bundle uses `['aws-runtime', 'module']` so esbuild keeps preferring packages' ESM builds.
  - **Scaffold template.** `@aws-blocks/create-block`'s primitive template calls the guard in its mock entry and depends on an `@aws-blocks/core` range that exports it.
  - **Docs.** `docs/guides/extending-with-existing-aws-resources.md` documents configuring your own bundler (esbuild, webpack) or unbundled Node (`--conditions=aws-runtime`) with the `aws-runtime` condition when deploying to a compute target Blocks doesn't own, and adds the guard call to the BB-author checklist.

  Maintainer note: these are `minor` bumps because AWS Blocks is pre-1.0, where `minor` is the channel for behavior changes — mock entries that previously ran in a deployed environment now throw.

### Patch Changes

- d366907: chore: manual dependency bump (2026-10-19)
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.2.2

### Patch Changes

- 66f4be2: BREAKING: remove `BlocksStack.handler`, `BlocksBackend.handler`, and `Scope.handler`.

  These returned the default compute's Lambda function, so anything wired through them reached only that one function — not every compute an app runs on. Use the stack-wide equivalents instead, which reach every compute:

  | Before                                              | After                                                                                                                                         |
  | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
  | `blocksStack.handler.addEnvironment('KEY', value)`  | `registerConfig(blocksStack, 'KEY', value)` — loaded into `process.env` on every compute at cold start, before the backend module is imported |
  | `resource.grantRead(blocksStack.handler)`           | `resource.grantRead(blocksStack.executionRole)`                                                                                               |
  | `blocksStack.handler.addToRolePolicy(statement)`    | `blocksStack.executionRole.addToPrincipalPolicy(statement)`                                                                                   |
  | `this.handler` inside a custom Building Block       | `this.executionRole` / `registerConfig(this, …)`                                                                                              |
  | `handler.addEnvironment('CORS_ALLOWED_ORIGINS', …)` | `defaults: { ...BlocksPresets.production, allowedOrigins: [...] }`                                                                            |

  `registerConfig` and `executionRole` are exported from `@aws-blocks/blocks/cdk` (and `@aws-blocks/core/cdk`).

  **Precedence differs from `addEnvironment`.** `addEnvironment` wrote a real Lambda environment variable, so the last call won. `registerConfig` entries are loaded at cold start only into keys that aren't already set, so a real environment variable of the same name always wins — for example one the framework sets itself (`NODE_ENV`, `BLOCKS_STACK_NAME`) or one set on the function outside CDK. When that happens with a different value, the compute now logs a warning at cold start naming the ignored keys (names only, never values).

  `registerConfig` can be called from app code after `BlocksStack.create()` / `BlocksBackend.create()` resolves. This already worked for every stack, because the framework always registers config of its own; finalize now creates the config deployment unconditionally, so it no longer depends on that.

## 0.2.1

### Patch Changes

- d4b32f2: Add `README.md` and `DESIGN.md` to `@aws-blocks/create-block` and ship them in the published package (`files`), matching the first-party package convention.

  Tidy two `extract-ts-types` test nits (test/comment only, no runtime change): replace a redundant re-assert with a direct check of the documented lingering-bare-key behavior, and link the array/tuple & nested-destructuring boundary to its tracking issue (#552).

- f04dbc4: Validate the derived npm scope and run the workspace build/test via `execFileSync` (argument array) instead of a shell string in the block scaffolder.

  The scope resolved from the customer workspace `package.json` `name` now passes the same allowlist as the `--scope` flag before it flows into the package name, and `verify()` invokes `npm run build`/`npm test` through an argv array rather than an interpolated shell command.

## 0.2.0

### Minor Changes

- a4ee47e: Add `@aws-blocks/create-block` — a scaffolder for new Building Blocks.

  `npm create @aws-blocks/block@latest <ClassName>` (or `npm run new:bb` inside this repo) generates a complete `bb-*` package: the conditional-export layers (`index.mock/aws/cdk/browser.ts` + `types.ts`/`errors.ts`), `README.md`/`DESIGN.md`, `package.json`, `tsconfig.json`, `api-extractor.json`, and passing `node:test` suites (behavior, export parity, and CDK synth). It scaffolds a **primitive** block — a storage-agnostic `Scope` skeleton with an example method and `TODO`s to fill in (composite and client-facing shapes can follow in a later release).

  The CLI auto-detects its context:

  - **Contributor mode** (run inside the aws-blocks monorepo): also wires the block into `@aws-blocks/blocks` (runtime + CDK re-exports, dependency, and vendorize map, via idempotent HTML markers), the root `workspaces`, the `comprehensive` test app, and a changeset; then regenerates the README catalog via `sync-docs`.
  - **Customer mode** (run inside your own npm-workspaces repo): generates `packages/bb-<name>`, registers it in your root `workspaces` (unless an existing glob like `packages/*` already covers it), and `npm install`s so your app can `import` it with no publish step. Does not modify your app's `package.json` or source. The npm scope is derived from your root package name (or `--scope`).
  - **External mode** (run anywhere else): generates a standalone `@<scope>/bb-<name>` package tagged `keywords: ["aws-blocks"]` with a self-contained build, no workspace wiring.

  Zero runtime dependencies (Node stdlib only). Flags: `--dir`, `--scope`, `--yes`, `--skip-install`, `--skip-verify`, `--dry-run`.

### Patch Changes

- b49fdd9: chore(create-block): add the `aws-blocks` keyword for npm discoverability

  `@aws-blocks/create-block` was published without a `keywords` array, so it did
  not appear in `npm search keywords:aws-blocks`, the discovery path the
  publishing guide documents (#491). This adds the `aws-blocks` keyword, which
  also satisfies the `keywords-guard.ts verify-discovery-tag` CI check that was
  failing on every PR because of this gap.
