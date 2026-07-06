---
"@aws-blocks/bb-distributed-data": patch
---

Reject index key sort direction (`ASC`/`DESC`) in `CREATE INDEX` at dev time. DSQL does not allow a sort direction on index keys ("specifying sort order not supported for index keys"), but the PGlite-based local mock previously accepted it, so the error only surfaced on deploy. Migration and mock validation now fail locally instead. (`NULLS FIRST/LAST` is supported by DSQL and is not rejected.)
