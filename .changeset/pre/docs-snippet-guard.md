---
'aws-cdk-blocks': patch
'@aws-cdk-blocks/bb-auth': patch
'@aws-cdk-blocks/pipeline': patch
'@aws-cdk-blocks/core': patch
---

docs: check the code samples of every shipped doc against the packages

A new test in `aws-cdk-blocks` reads every doc shipped in `docs/`, changelogs included, and fails when a code sample imports a name its `@aws-cdk-blocks/*` entry doesn't export, uses a missing member or constructor of a Blocks name, or uses an undeclared Blocks-looking name no entry exports (a removed block). Samples that are complete files (a first-line `// path/file.ts` comment and an import) are typechecked in full. Samples labelled as browser files (`// src/…`, `// test/…`, `// frontend/…`) also have their value imports resolved under the `browser` condition, where the root `aws-cdk-blocks` has none. Intentional exceptions are marked in the doc itself, with a reason: `<!-- doc-snippet: skip — reason -->` or `<!-- doc-snippet: fragment — reason -->` above a sample, or `<!-- doc-snippet: skip-file — reason -->` for a whole doc.

Fixed what it found: the bb-auth README's "Protect every method" frontend file imported `AuthErrors` / `isAuthError` from `aws-cdk-blocks`, which a browser build doesn't export; it now matches with `isBlocksError(e, 'NotAuthenticatedException')` from `aws-cdk-blocks/client`.

The bb-data `USE_CASES.md` backend example built `new Database<DB>(…)` and called Kysely methods on it. It now reads through `createKyselyAdapter<DB>(…)`, as the bb-data README does, and inserts with ``queryOne(sql`INSERT … RETURNING …`)``, because the types `bb-data generate-types` emits list a `SERIAL` id as a required column. Its setup steps now agree with the code: the migration is applied with `bb-data migrate`, the types are generated where the API file imports them from, and the `Database` passes `migrationsPath`. The `AuthCognito` / `AuthOIDC` / `AuthBasic` "before" code in the bb-auth migration guide, a few samples that name the app's own classes, and the `aws-cdk-blocks` and `@aws-cdk-blocks/core` changelogs (whose release notes show the removed auth blocks) are marked.
