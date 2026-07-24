---
"@aws-blocks/data-common": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
---

Retry PGlite's WASM initialization on the intermittent `_pg_initdb` `unreachable` trap.

PGlite defers `initdb` to the first query, which can trap with `unreachable` under memory pressure (notably on CI when several PGlite-backed dev servers boot concurrently) and kill the dev server mid-`runMigrations`. `PGliteEngine` (bb-data) and `DsqlMockEngine` (bb-distributed-data) now force initialization through a shared bounded retry (`initializePgliteWithRetry` in data-common) that closes the aborted WASM instance and boots a fresh one, so a transient init trap recovers instead of crashing the process.
