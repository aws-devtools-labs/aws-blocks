---
"@aws-blocks/data-common": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/blocks": patch
---

Keep the local dev server alive when a PGlite init trap aborts constructor-time migrations, and recover from it

A `Database` / `DistributedDatabase` configured with `migrationsPath` runs its
migrations eagerly in the constructor, before any query awaits them. If PGlite's
WASM `_pg_initdb` aborts (notably under memory pressure, where the WASM linear
heap can't grow), that eager, unawaited promise rejected with no handler — an
unhandled rejection that terminated the whole `npm run dev` process. A shared
`trackEager` helper (in `@aws-blocks/data-common`) now attaches a logging handler
so the dev server survives; the same rejection still reaches callers via the
ready-gate, so a query after a failed init surfaces a branded
`QueryFailedException` rather than being swallowed.

A transient trap no longer wedges the data layer: on an init trap the cached
rejected promise is cleared, so the next query re-runs the idempotent migrations
once memory eases (matching the engine's own recover-on-retry behaviour).
