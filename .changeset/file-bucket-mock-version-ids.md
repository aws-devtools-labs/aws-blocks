---
"@aws-blocks/bb-file-bucket": patch
---

The local mock no longer reissues a version id after that version is permanently deleted with `delete(path, { versionId })`. Like S3, every upload now gets an id that was never used for that key, so `get(path, { versionId })` for a deleted version returns `null` instead of the later upload that used to take its id.
