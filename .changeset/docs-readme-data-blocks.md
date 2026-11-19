---
"@aws-cdk-blocks/bb-kv-store": patch
"@aws-cdk-blocks/bb-database": patch
"@aws-cdk-blocks/bb-file-bucket": patch
"@aws-cdk-blocks/bb-app-setting": patch
"@aws-cdk-blocks/bb-secret": patch
"aws-cdk-blocks": patch
---

docs(bb-kv-store, bb-database, bb-file-bucket, bb-app-setting, bb-secret): the READMEs of the data blocks correct their errors tables and document counters in `KVStore`, `AppSetting.fromExisting` and how a `secret: true` setting gets its value.

**`KVStore`**

- Corrected: for a transaction the README named two packages that do not exist; it names `transaction()` on `Database`.
- Added: there is no atomic increment. The conditional-writes section gives two ways to keep a concurrent counter: a `get()` and conditional `put()` loop (`ifNotExists: true` for a new item, otherwise `ifValueEquals` or `ifFieldEquals`, retry on `KVStoreErrors.ConditionalCheckFailed`, no expiry on the counter), or one item per event aggregated with `query()`.
- Added: a `Default` column in the options table. The errors table follows the options, and `scan` has its own section.
- Removed: "Best practices" and "Scaling and cost (AWS)" items that repeated earlier sections.

**`Database`**

- Corrected: the errors table lists each `DatabaseErrors` constant with the `error.name` the caller sees (`QueryFailedException`, not `QueryFailed`).
- Added: a table of the `transaction()` options (`retryOnConflict`, `maxRetries`, `signal`), `Default` columns in the options tables, and a second table for the four errors that are not for `catch`.
- Moved: `npm run db` is documented once, in `## Command line`, which says which commands apply to a block that provisions its cluster and which to an existing database, and that a command with `--block` refuses `--name`. The steps to move or rename a block are their own section. "Migrations" has one subsection per target. `## Local mode` is now `## Local development`.

**`FileBucket`**

- Corrected: no method throws `FileBucketErrors.FileNotFound` or `FileBucketErrors.FileTooLarge`. `get()` returns `null` for a missing file, and an upload over `maxUploadBytes` throws `ValidationFailed`, which has no `FileBucketErrors` constant and is matched with `isBlocksError(e, 'ValidationFailed')`.
- Corrected: the method table says when to return a download or upload handle and when a raw presigned URL; two bullets gave opposite advice.
- Added: a quick start, the `FileBucket.fromKmsKey(keyArn)` row, tables for `FileContent`, `FileInfo`, `FileDownloadClient` and `FileUploadClient`, a `Default` column in the options table, and a `## Scaling and cost (AWS)` section: an upload is one `PutObject` request, with no multipart upload.
- Removed: the "Best Practices" list, the Batch Delete example, and the on-disk layout of the local mock (it is in `DESIGN.md`).

**`AppSetting`**

- Corrected: `value` is required unless `secret: true`. A missing parameter throws `ParameterNotFound` on AWS only; an empty `secret: true` value throws on AWS and locally. A `secret: true` value is not checked against the 4 KB limit.
- Added: `AppSetting.fromExisting`, with a section: the stack does not create the parameter, the app's role can only read it, and `put()` is denied on AWS although it succeeds locally.
- Added: a section on `secret: true`: the first deploy stores a random value; set the real one with `put()` or in the console; `get()` parses the stored text as JSON, so a console value such as `12345` comes back as a number.

**`Secret`**

- Corrected: `SecretErrors.NotSupported` is also thrown by a deployed `Secret` that has no registered secret ARN, not only in browser code.
- Corrected: `put()` clears the cache of the instance that calls it only; other running instances read the new value once their cache entry expires (`cacheTtlSeconds`).
- Added: one errors table, a `Default` column in the options table, a quick start, and a separate `## What it provisions (AWS)` section.
