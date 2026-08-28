# @aws-blocks/data-common

## 0.1.4

### Patch Changes

- bfb9a63: Polish the PGlite init-retry helper (`data-common`) following #205 review:
  
  - Narrow the WASM-trap classifier to specific signatures (`RuntimeError: unreachable`, `wasm trap: unreachable`, Emscripten `Aborted(<reason>)`) instead of matching the bare word `unreachable`, so an unrelated probe failure whose text/stack merely contains "unreachable" (e.g. an `assertUnreachable` helper) is no longer misclassified as retryable. The `Aborted(` prefix (not just the empty `Aborted()`) is matched so memory-pressure aborts like `Aborted(Cannot enlarge memory arrays)` / `Aborted(OOM)` — the case this retry exists for — are caught. A `RuntimeError`-named error whose message contains `unreachable` is also treated as a trap, so the real V8/Node trap (message is literally `"unreachable"`, prefix only in the stack) is caught without depending on the stack surviving.
  - Classify retryability BEFORE consulting the attempt budget in `initializePgliteWithRetry`, so instance cleanup is uniform (a non-retryable error is always rethrown untouched) and `maxAttempts === 1` no longer closes the instance on a non-trap failure.
  - Guard `maxAttempts` against `NaN` (which `?? 3` does not default), preventing an unbounded close/recreate loop on a persistent trap.
  - Wrap a `recreate()` failure so the original init trap is preserved as the error `cause`, keeping debugging pointed at "PGlite kept trapping" rather than only the secondary recreate error.
  - Mark the four init-retry exports (`initializePgliteWithRetry`, `isPgliteUnreachableTrap`, `PgliteLike`, `PgliteInitRetryOptions`) `@internal` — they exist only so the engine packages can share the helper — and document the `PgliteLike` methods.
- e4b1498: Retry PGlite's WASM initialization on the intermittent `_pg_initdb` `unreachable` trap.
  
  PGlite defers `initdb` to the first query, which can trap with `unreachable` under memory pressure (notably on CI when several PGlite-backed dev servers boot concurrently) and kill the dev server mid-`runMigrations`. `PGliteEngine` (bb-data) and `DsqlMockEngine` (bb-distributed-data) now force initialization through a shared bounded retry (`initializePgliteWithRetry` in data-common) that closes the aborted WASM instance and boots a fresh one, so a transient init trap recovers instead of crashing the process.
- @aws-blocks/bb-logger@0.1.4

## 0.1.3

### Patch Changes

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

- Updated dependencies [3c56267]
  - @aws-blocks/bb-logger@0.1.3

## 0.1.2

### Patch Changes

- c4313cd: Fix `ERR_MODULE_NOT_FOUND` on a fresh `create-blocks-app` scaffold by making required runtime packages real dependencies of the block that actually loads them. npm does not install peer dependencies of transitive dependencies, so these never landed in `node_modules`.

  - `kysely` → dependency of `@aws-blocks/data-common`. `data-common` is the only package that imports and instantiates `kysely` (in its Kysely adapter); `bb-data` and `bb-distributed-data` merely re-export `createKyselyAdapter` and keep `kysely` as a peer, which is now satisfied transitively via `data-common`. Promoting it on `data-common` alone guarantees a single hoisted instance and installs it for any app that pulls a data block.
  - `@opentelemetry/api` → dependency of `@aws-blocks/bb-agent`. It is a non-optional peer of `@strands-agents/sdk`, which the Agent block loads at runtime, so it must be installed whenever `bb-agent` is present.

  Both packages have zero runtime dependencies and no install scripts, so this adds no transitive tree.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [c0558f3]
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
