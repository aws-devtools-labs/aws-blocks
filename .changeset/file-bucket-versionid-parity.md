---
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/blocks": patch
---

fix(bb-file-bucket): align unknown-`versionId` behavior between the mock and AWS

On a versioned bucket, an unknown `versionId` diverged between runtimes:

- `get()` — the mock returns `null` (per `get()`'s "null if it does not exist"
  contract), but the AWS path mapped only `NoSuchKey` → `null`, so an unknown
  `versionId` (S3 raises `NoSuchVersion`) threw instead. AWS `get()` now maps
  `NoSuchVersion` → `null` too.
- `restoreVersion()` — the mock throws a clean, `NoSuchVersion`-named error
  (matchable via `isBlocksError(e, 'NoSuchVersion')`), but the AWS path let the
  raw S3 error propagate, whose enumerable `$metadata` (request IDs, ARNs) would
  leak to the client on serialization. AWS `restoreVersion()` now re-throws the
  same clean, named error. (Also fixes the `CopySource` to use the URL-encoded
  key, which the surrounding code already computed but didn't use.)
