# @aws-blocks/bb-agent

## 0.3.2

### Patch Changes

- c4313cd: Fix `ERR_MODULE_NOT_FOUND` on a fresh `create-blocks-app` scaffold by making required runtime packages real dependencies of the block that actually loads them. npm does not install peer dependencies of transitive dependencies, so these never landed in `node_modules`.

  - `kysely` → dependency of `@aws-blocks/data-common`. `data-common` is the only package that imports and instantiates `kysely` (in its Kysely adapter); `bb-data` and `bb-distributed-data` merely re-export `createKyselyAdapter` and keep `kysely` as a peer, which is now satisfied transitively via `data-common`. Promoting it on `data-common` alone guarantees a single hoisted instance and installs it for any app that pulls a data block.
  - `@opentelemetry/api` → dependency of `@aws-blocks/bb-agent`. It is a non-optional peer of `@strands-agents/sdk`, which the Agent block loads at runtime, so it must be installed whenever `bb-agent` is present.

  Both packages have zero runtime dependencies and no install scripts, so this adds no transitive tree.

- 997c736: Lazy-load the Strands SDK in the Agent block so that importing `@aws-blocks/blocks` no longer eagerly loads `@strands-agents/sdk` and its non-optional `@modelcontextprotocol/sdk` / `@opentelemetry/api` peers.

  The `@aws-blocks/blocks` umbrella re-exports `Agent` statically, so a fresh scaffold that never instantiates an agent previously failed on the first `npm run dev` with `ERR_MODULE_NOT_FOUND` for those packages. The Strands runtime is now imported on first agent execution (via a cached dynamic `import()`), so it stays off the module **load path** of apps that don't use an agent — those apps run without the packages installed.

  Scope / follow-up: this removes the packages from the _load path_, not from the _install set_. Apps that actually use an Agent block still need `@strands-agents/sdk`'s non-optional peers (`@modelcontextprotocol/sdk`, `@opentelemetry/api`) installed, because Strands imports them when it loads on first agent execution and npm does not auto-install peers of transitive dependencies. Those are supplied to agent-using apps by the Agent scaffold template (and documented for manual installs) rather than promoted to `dependencies` here, which would pull Strands' ~10 MB transitive tree into every app. No public API change.

## 0.3.1

### Patch Changes

- cfe6cb0: fix(bb-agent): use the Lambda execution region for S3Storage (#120)

  The deployed Agent constructed Strands' `S3Storage` without a `region`, so it defaulted to `us-east-1` and hard-pinned the snapshot S3 client there. Because the session bucket is created in the deploy region, any deployment outside `us-east-1` failed snapshot reads/writes with a cross-region 301 `PermanentRedirect`. `S3Storage` is now constructed with `region: process.env.AWS_REGION` — which the Lambda runtime always sets to the function's region — so snapshots resolve against the correct regional endpoint. `region` and `s3Client` are mutually exclusive in `S3StorageConfig`, so only `region` is passed.

## 0.3.0

### Minor Changes

- 179817f: feat(bb-agent): make model config optional, default to BedrockModels.BALANCED

  The `model` field in AgentConfig is now optional. When omitted, the agent
  defaults to `BedrockModels.BALANCED` for deployment and the canned provider
  for local development.

### Patch Changes

- Updated dependencies [e839301]
  - @aws-blocks/core@0.1.10

## 0.2.1

### Patch Changes

- c6ba244: fix(bb-agent): add toJSON() to AgentStreamResult

  `AgentStreamResult` now serializes to `{ channelId, channel: null }` when returned from API methods. Previously `channel` serialized to an empty object `{}`; it is now explicitly `null` to signal it is server-side only.

## 0.2.0

### Minor Changes

- ce61bb7: refactor(bb-agent): capability-based model presets with global inference profiles

  New presets:

  - `BALANCED` (Claude Sonnet 4.6): recommended default for most workloads
  - `SMART` (Claude Opus 4.8): highest capability for hardest tasks
  - `FAST` (Claude Haiku 4.5): lowest latency

  All presets use `global.` inference profiles for region-agnostic deployment.

  Deprecated (non-removing): `DEFAULT` resolves to `BALANCED`, `BUDGET` and `MICRO` resolve to `FAST`. Note this changes the underlying model for existing callers — `DEFAULT` moves from Opus to Sonnet, and `BUDGET`/`MICRO` move from Amazon Nova Pro/Lite to Claude Haiku, so cost and latency profiles differ. The symbols still resolve (no type break), but migrate to `BALANCED`/`FAST` (or a region-scoped profile) explicitly to pin the model you want.

### Patch Changes

- f946736: fix(bb-agent): treat empty channelId as unset in stream()

  An empty `channelId` now falls back to `conversationId` or a random UUID, preventing all streams from sharing the same channel. Empty strings are treated as unset rather than used literally.

## 0.1.3

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
  - @aws-blocks/bb-async-job@0.1.2
  - @aws-blocks/bb-distributed-table@0.1.3
  - @aws-blocks/bb-file-bucket@0.1.2
  - @aws-blocks/bb-logger@0.1.2
  - @aws-blocks/bb-realtime@0.1.2

## 0.1.2

### Patch Changes

- 835c425: docs(bb-agent): document AgentStreamChunk types and Message roles
- dd07335: fix(bb-agent): simplify Bedrock health check to support all inference profile formats

  Removed the prefix regex that determined whether to call `GetInferenceProfile`
  or `GetFoundationModel`. The health check now tries both APIs sequentially —
  any model ID format (cross-region, global, or foundation model) works without
  maintaining a prefix allowlist.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-distributed-table@0.1.1
  - @aws-blocks/bb-file-bucket@0.1.1
  - @aws-blocks/bb-realtime@0.1.1
  - @aws-blocks/bb-async-job@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
