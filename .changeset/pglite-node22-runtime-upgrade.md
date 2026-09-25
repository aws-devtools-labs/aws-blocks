---
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
---

Upgrade PGlite from `^0.2.0` to `^0.3.16` to pick up the Node 21/22 WASM runtime fix.

On Node 21/22, PGlite's WASM `initdb` traps with `RuntimeError: unreachable` at `_pg_initdb` (electric-sql/pglite#749, fixed by #753 in 0.3.7). The trapped instance is unrecoverable, so a Database or DistributedDatabase block whose init hits the trap could fail to start under that runtime. Moving to `0.3.16` (latest 0.3.x) picks up the fix and its subsequent patch releases. The query/transaction API surface the engines use (`new PGlite(dir)`, `query().rows`, `query().affectedRows`, `close()`, `BEGIN`/`COMMIT`/`ROLLBACK`) and the on-disk data-directory layout are unchanged, so no engine code changes are required.
