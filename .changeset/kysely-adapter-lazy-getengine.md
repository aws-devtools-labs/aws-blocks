---
"@aws-blocks/data-common": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/bb-data": patch
---

fix(data-common): defer getEngine() in createKyselyAdapter so adapters are safe at module scope

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
