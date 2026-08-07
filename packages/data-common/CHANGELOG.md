# @aws-blocks/data-common

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
