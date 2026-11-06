# @aws-blocks/create-block

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
