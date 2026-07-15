---
"@aws-blocks/bb-distributed-data": patch
---

Reject `ALTER TABLE DROP COLUMN` and `ALTER TABLE DROP CONSTRAINT` at dev time. Neither is in DSQL's supported `ALTER TABLE` subset ("unsupported ALTER TABLE DROP COLUMN statement", 0A000), but the PGlite-based local mock previously accepted them, so the error only surfaced on deploy. Migration and mock validation now fail locally instead. (The supported `ALTER COLUMN ... DROP IDENTITY` / `DROP DEFAULT` forms are not affected.)
