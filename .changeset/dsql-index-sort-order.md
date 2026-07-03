---
"@aws-blocks/bb-distributed-data": patch
---

Reject index key sort order (`ASC`/`DESC`, `NULLS FIRST/LAST`) in `CREATE INDEX` at dev time. DSQL rejects sort order on index keys ("specifying sort order not supported for index keys"), but the PGlite-based local mock previously accepted it, so the error only surfaced on deploy. Migration and mock validation now fail locally instead.
