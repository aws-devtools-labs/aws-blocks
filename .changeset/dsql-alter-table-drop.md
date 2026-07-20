---
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/blocks": patch
---

Reject `ALTER TABLE DROP COLUMN` at dev time, including the keyword-less Postgres shorthand (`ALTER TABLE t DROP col` / `DROP IF EXISTS col`). It is not in DSQL's supported `ALTER TABLE` subset ("unsupported ALTER TABLE DROP COLUMN statement", 0A000), but the PGlite-based local mock previously accepted it, so the error only surfaced on deploy. Migration and mock validation now fail locally instead. The supported forms — `ALTER COLUMN ... DROP DEFAULT` / `DROP NOT NULL` / `DROP EXPRESSION` / `DROP IDENTITY` and `DROP CONSTRAINT` — are not affected.

The `@aws-blocks/blocks` umbrella package receives a `patch` because its published `docs/` folder is assembled from sibling block READMEs at build time (`scripts/sync-block-docs.mjs`), so this `bb-distributed-data` README update changes `@aws-blocks/blocks` packaged content.
