---
'@aws-blocks/blocks': patch
'@aws-blocks/bb-data': patch
'@aws-blocks/bb-auth': patch
'@aws-blocks/pipeline': patch
'@aws-blocks/core': patch
'@aws-blocks/bb-distributed-table': patch
---

docs: check the code samples of every shipped doc against the packages

A new test in `@aws-blocks/blocks` reads every doc shipped in `docs/`, changelogs included, and fails when a code sample imports a name its `@aws-blocks/*` entry doesn't export, uses a missing member or constructor of a Blocks name, or uses an undeclared Blocks-looking name no entry exports (a removed block). Samples that are complete files (a first-line `// path/file.ts` comment and an import) are typechecked in full. Samples labelled as browser files (`// src/…`, `// test/…`, `// frontend/…`) also have their value imports resolved under the `browser` condition, where the root `@aws-blocks/blocks` has none. Intentional exceptions are marked in the doc itself, with a reason: `<!-- doc-snippet: skip — reason -->` or `<!-- doc-snippet: fragment — reason -->` above a sample, or `<!-- doc-snippet: skip-file — reason -->` for a whole doc.

Fixed what it found: the bb-auth README's "Protect every method" frontend file imported `AuthErrors` / `isAuthError` from `@aws-blocks/blocks`, which a browser build doesn't export; it now matches with `isBlocksError(e, 'NotAuthenticatedException')` from `@aws-blocks/blocks/client`.

The bb-data `USE_CASES.md` backend example built `new Database<DB>(…)` and called Kysely methods on it. It now reads through `createKyselyAdapter<DB>(…)`, as the bb-data README does, and inserts with ``queryOne(sql`INSERT … RETURNING …`)``, because the types `bb-data generate-types` emits list a `SERIAL` id as a required column. Its setup steps now agree with the code: the migration is applied with `bb-data migrate`, the types are generated where the API file imports them from, and the `Database` passes `migrationsPath`. The `AuthCognito` / `AuthOIDC` / `AuthBasic` "before" code in the bb-auth migration guide, a few samples that name the app's own classes, and the `@aws-blocks/blocks`, `@aws-blocks/core` and `@aws-blocks/bb-distributed-table` changelogs (whose release notes show the removed auth blocks) are marked.
