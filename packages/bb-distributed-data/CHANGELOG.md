# @aws-blocks/bb-distributed-data

## 0.1.4

### Patch Changes

- 0f3c73c: Reject `ALTER TABLE DROP COLUMN` at dev time, including the keyword-less Postgres shorthand (`ALTER TABLE t DROP col` / `DROP IF EXISTS col`). It is not in DSQL's supported `ALTER TABLE` subset ("unsupported ALTER TABLE DROP COLUMN statement", 0A000), but the PGlite-based local mock previously accepted it, so the error only surfaced on deploy. Migration and mock validation now fail locally instead. The supported forms — `ALTER COLUMN ... DROP DEFAULT` / `DROP NOT NULL` / `DROP EXPRESSION` / `DROP IDENTITY` and `DROP CONSTRAINT` — are not affected.

  The `@aws-blocks/blocks` umbrella package receives a `patch` because its published `docs/` folder is assembled from sibling block READMEs at build time (`scripts/sync-block-docs.mjs`), so this `bb-distributed-data` README update changes `@aws-blocks/blocks` packaged content.

## 0.1.3

### Patch Changes

- c7f1e7c: Reject index key sort direction (`ASC`/`DESC`) in `CREATE INDEX` at dev time. DSQL does not allow a sort direction on index keys ("specifying sort order not supported for index keys"), but the PGlite-based local mock previously accepted it, so the error only surfaced on deploy. Migration and mock validation now fail locally instead. (`NULLS FIRST/LAST` is supported by DSQL and is not rejected.)

## 0.1.2

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
  - @aws-blocks/bb-logger@0.1.2

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-logger@0.1.1
  - @aws-blocks/data-common@0.1.1

## 0.1.0

Initial version
