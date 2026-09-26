---
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
---

Upgrade PGlite from `^0.2.0` to `^0.5.8` to address the `_pg_initdb` WASM init crash seen on Node 22 / CI.

On the CI runner (Node 22), PGlite's WASM `initdb` traps with `RuntimeError: unreachable` at `_pg_initdb`; the trapped instance is unrecoverable, so a Database or DistributedDatabase block whose init hits the trap fails to start. The `0.3.7` "wasm runtime exception" fix (electric-sql/pglite#753) did NOT resolve it — an upgrade to `0.3.16` was verified to still trap. PGlite `0.4.0` re-architected initdb into a separate module and `0.4.3` added an initial-memory-size control, so the plausible fix for an initdb-path trap is in the 0.4.x+ line, not 0.3.x. This moves to the current `0.5.8`.

The query/transaction API surface the engines use (`new PGlite(dir)`, `query().rows`, `query().affectedRows`, `close()`, `BEGIN`/`COMMIT`/`ROLLBACK`) and the on-disk data-directory layout are verified unchanged on `0.5.8` (despite the PG18 upgrade and extension repackaging), so no engine code changes are required.

Note: the trap does not reproduce locally (it is CI-runner-specific), so the crash fix is verified in CI by the `oidc-dsql-notes` / `sql-kb-catalog` dead_server rate; the API compatibility is verified locally.
