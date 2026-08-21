# @aws-blocks/bb-data

## 0.2.6

### Patch Changes

- 309a236: refactor(bb): attach IAM grants to the shared execution role
  
  Data and auth blocks now grant permissions to the shared Blocks execution role
  (`this.executionRole`) instead of the handler function directly. Grants land on
  the same role the handler assumes, so the effective runtime permissions are
  identical — this decouples IAM wiring from the concrete Lambda function ahead of
  the multi-compute model.
  
  For `bb-distributed-data`, the DSQL endpoint and region now flow through the
  config registry (loaded into `process.env` at cold start, like every other
  block) rather than being set as direct handler environment variables, and the
  migration Lambda maps the shared execution role's ARN.
- Updated dependencies [309a236]
- Updated dependencies [08ab129]
- Updated dependencies [5bfae0a]
  - @aws-blocks/bb-app-setting@0.1.5
  - @aws-blocks/core@0.3.0
  - @aws-blocks/bb-logger@0.1.5

## 0.2.5

### Patch Changes

- 7b4c62d: Add infrastructure `defaults` chosen once at the app entry point, replacing the per-block `sandboxMode` logic and the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin dance for removal-policy and deletion-protection.
  
  `@aws-blocks/core/cdk` now exports `BlocksDefaults` and the `BlocksPresets.sandbox` / `BlocksPresets.production` starting points. `BlocksStack.create` / `BlocksBackend.create` take a required `defaults` prop; start from a preset and override individual fields with a spread. `defaults` is anchored on the owning `BlocksStack`/`BlocksBackend` (resolved by walking up the construct tree, like `handler`/`executionRole`), so multiple backends in one stack each keep their own posture. Building Blocks read the resolved values via `scope.defaults`, and a per-block option always wins (`option ?? scope.defaults.field`).
  
  Adopted across the stateful Building Blocks: `bb-kv-store`, `bb-data`, `bb-distributed-data`, `bb-distributed-table`, and `bb-knowledge-base` now take their removal policy and deletion protection from `defaults` instead of reading the `sandboxMode` context themselves. (`bb-distributed-table` reads `defaults` directly for now; a richer per-block `protection` override lands with #282.)
  
  The `create-blocks-app` scaffolding templates are updated to pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production` (replacing the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin), so newly-generated apps satisfy the required prop.
  
  **Breaking:** `BlocksStack.create` / `BlocksBackend.create` now require a `defaults` field — pass `BlocksPresets.sandbox` or `BlocksPresets.production` (typically `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`). The previously-shipped experimental `hardening` prop and its `resolve*` helpers are removed; log-retention, API throttling, access-logging and point-in-time-recovery move into `defaults` in follow-up, per-feature changes.
- 6df9e2d: fix(data): declare the `data-common` TypeScript project reference in `bb-data` and `bb-distributed-data`
  
  Both packages depend on `@aws-blocks/data-common` in `package.json`, but neither
  listed it in its `tsconfig.json` `references`. Because `src/` ships in these
  tarballs, `data-common`'s declarations have to already exist for the compiler to
  resolve `@aws-blocks/data-common` — and nothing in the project-reference graph
  guaranteed that.
  
  Correct build order was therefore supplied by the position of `data-common` in
  the root `workspaces` array (index 8, ahead of `bb-data` at 10 and
  `bb-distributed-data` at 11) rather than by the dependency graph. Any build that
  does not follow that array order fails with:
  
  ```
  packages/bb-distributed-data/src/validation.ts(12,54): error TS2307:
    Cannot find module '@aws-blocks/data-common' or its corresponding type declarations.
  ```
  
  That was already reachable from the repo's own scripts: the former
  `npm run build:packages` resolved its `-w` targets in a different order and hit
  exactly this, which is why `scripts/agent-bench/steps/1-init-bench-app.sh`
  carried the comment "`build:packages` runs alphabetically and trips over
  bb-data". Adding the two missing references fixes the root cause, so build order
  now comes from the project-reference graph rather than from the ordering of the
  root `workspaces` array.
  
  No API, runtime, or packaged-output change — `tsconfig.json` is not in either
  package's `files`, so the published tarballs are unchanged.
- 3614a09: Bundle the migration lambdas through `blocksNodejsBundling()` so `import.meta.url` used anywhere in the bundled migration handler is shimmed to its CommonJS equivalent instead of throwing at Lambda load. Consistent with the backend handler; no behavior change for existing migration lambdas. Also documents in the README that `migrationsPath` is simplest as a path relative to your project root, and that `import.meta.url` inside the bundle resolves to the bundled output (not your source tree).
- e4b1498: Retry PGlite's WASM initialization on the intermittent `_pg_initdb` `unreachable` trap.
  
  PGlite defers `initdb` to the first query, which can trap with `unreachable` under memory pressure (notably on CI when several PGlite-backed dev servers boot concurrently) and kill the dev server mid-`runMigrations`. `PGliteEngine` (bb-data) and `DsqlMockEngine` (bb-distributed-data) now force initialization through a shared bounded retry (`initializePgliteWithRetry` in data-common) that closes the aborted WASM instance and boots a fresh one, so a transient init trap recovers instead of crashing the process.
- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [bfb9a63]
- Updated dependencies [e4b1498]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/data-common@0.1.4
  - @aws-blocks/bb-app-setting@0.1.4
  - @aws-blocks/bb-logger@0.1.4

## 0.2.4

### Patch Changes

- 49b3bd9: Make the unconfigured-connection error in the Database runtime intent-aware. When neither an Aurora cluster is provisioned nor an external `connectionString` connection is supplied, the error now names both paths — the provisioned Aurora database (`BLOCKS_*_CLUSTER_ARN` / `SECRET_ARN`) and `Database.fromExisting({ connectionString })` for external databases (Supabase/Neon/etc.) — instead of surfacing an Aurora-only message.
- a584007: fix(data-common): defer getEngine() in createKyselyAdapter so adapters are safe at module scope

  `createKyselyAdapter()` eagerly called `db.getEngine()` at construction. Backend
  `index.ts` is also loaded during `cdk synth`, where the infra-only (cdk) builds of
  `DistributedDatabase` / `Database` expose no engine — so creating the adapter at
  module scope crashed synth with `db.getEngine is not a function`.

  - **data-common** — the adapter now passes a thunk (`() => db.getEngine()`) into
    the Kysely dialect and resolves the engine lazily on the first query (still
    memoized per connection, preserving the one-engine-per-transaction guarantee
    the handle-based transaction API relies on). Adapter creation is now
    side-effect free and safe at module scope. Public API and runtime behavior are
    unchanged.
  - **bb-distributed-data / bb-data** — the cdk builds gain a `getEngine()` that
    throws a clear, actionable message if a query is ever reached during synth,
    replacing the cryptic "is not a function".

- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [a584007]
- Updated dependencies [2d3dfdc]
- Updated dependencies [3c56267]
  - @aws-blocks/core@0.1.17
  - @aws-blocks/data-common@0.1.3
  - @aws-blocks/bb-logger@0.1.3

## 0.2.3

### Patch Changes

- 09b94b8: Bump the Database block's Aurora PostgreSQL engine version from the retired `16.4` to `16.13`, and make the engine version configurable.

  AWS retired Aurora PostgreSQL `16.4` in us-east-1, after which `CreateDBCluster` failed with `Cannot find version 16.4 for aurora-postgresql`, blocking every deployment of a `Database` block. The default now points at the latest available `16.x` minor (`16.13`) for the longest deprecation runway.

  A new optional `postgresVersion` option on `DatabaseOptions` lets callers override the engine version (e.g. `postgresVersion: '16.13'`), so the next AWS retirement is a configuration change rather than a framework code fix. Overrides are validated at synth time (must be `MAJOR.MINOR`, e.g. `16.13`), so a malformed value fails fast with a clear error instead of an opaque `CreateDBCluster` failure.

  The `@aws-blocks/blocks` umbrella package receives a `patch` because its published `docs/` folder is assembled from sibling block READMEs at build time (`scripts/sync-block-docs.mjs`), so this `bb-data` README update changes `@aws-blocks/blocks` packaged content.

## 0.2.2

### Patch Changes

- 4a87ed1: Recover incomplete local PGlite data directories before opening the database so an interrupted first boot does not permanently prevent local dev startup.

## 0.2.1

### Patch Changes

- e839301: fix: stack-scope the external-DB connection-string SSM parameter to prevent multi-app collision

  The external-database connection string was stored in an SSM parameter named only
  by stage (`/blocks/{stage}/db-connection-string`), so two Blocks apps deployed to
  the same AWS account + region + stage computed the same name and silently
  overwrote each other's credentials.

  The parameter name is now stack-scoped (`/<stackName>-db-url`), derived from a
  single new `getStackName({ sandbox, projectRoot })` helper that is also the one
  place the CDK templates compute the stack name (replacing logic duplicated across
  templates). The same `dbConnectionParameterName(stackName)` — fed the stack name
  from `getStackName({ sandbox, projectRoot })` — is used
  by the pre-deploy writer (`ensureSecrets`) and by the `db pull` generated wiring at
  synth, so the written name and the read name are derived once, from committed
  config (`.blocks/config.json`) — never from the connection string — and cannot
  diverge. The name is computable before synth (enabled by the committed stackId from
  PR #51), so no post-deploy write-back or staging-copy machinery is needed.

  The previous stage-only parameter is orphaned and self-heals on the next deploy.

- Updated dependencies [e839301]
  - @aws-blocks/core@0.1.10

## 0.2.0

### Minor Changes

- 42fcbdf: Add an `ssl` option to external database connections and verify the server's TLS
  certificate by default.

  `fromExisting({ connectionString })` now accepts an `ssl` option and verifies the
  server certificate by default instead of silently disabling verification. The `ssl`
  option is a discriminated union — `{ rejectUnauthorized?: true; ca?: string } | { rejectUnauthorized: false }` —
  so the misleading `{ ca, rejectUnauthorized: false }` (a pinned CA that `pg` would
  ignore) is a compile-time error. A TLS 1.2 floor is enforced on every connection.
  `bb-data pull` prompts for your provider CA and commits it to
  `aws-blocks/database.ca.ts` (a public, non-secret cert bundled into the deployed
  function), so the generated connection is verified by default — including in the
  deployed Lambda — with no runtime configuration. `DATABASE_CA_CERT` (inline PEM or
  file path) overrides the committed cert. Without any CA, local dev falls back to a
  visible, editable `rejectUnauthorized: false`, while the **deployed function and
  non-interactive (CI) migrations fail closed** rather than running unverified. Local
  dev keeps the previous unverified default for self-signed local databases (now with
  a warning when `ssl` is omitted, since the deployed runtime verifies).

  Upgrade note: if you call `fromExisting({ connectionString })` **directly** (not via
  `db pull`-generated code) with no `ssl` option, the connection now verifies the
  server certificate. Providers that use a private CA (e.g. Supabase) require pinning
  it — pass `ssl: { ca }` (the certificate contents) — otherwise the connection will
  fail to validate. Pass `ssl: { rejectUnauthorized: false }` to keep the previous
  behavior explicitly. `db pull`-generated apps are unaffected in default
  connectivity.

  CI note: the `bb-data` CLI and migration paths (migrate status, generate-types,
  baseline, external migrations) now **fail closed in non-interactive runs** (`CI`
  set, excluding `CI=false`/`0`) when no CA is available. If you run these in CI/CD,
  set `DATABASE_CA_CERT` to your provider CA (inline PEM or a file path); otherwise
  they will throw instead of connecting unverified. Interactive (local) runs keep the
  warned, encrypted-but-unverified fallback.

## 0.1.2

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
  - @aws-blocks/bb-app-setting@0.1.3
  - @aws-blocks/bb-logger@0.1.2

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-app-setting@0.1.1
  - @aws-blocks/bb-logger@0.1.1
  - @aws-blocks/data-common@0.1.1

## 0.1.0

Initial version
