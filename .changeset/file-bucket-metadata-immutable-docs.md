---
"@aws-blocks/bb-file-bucket": patch
---

Docs: FileBucket object metadata is set when the object is written and can't be edited in place. Each `put()` replaces it, and a `put()` without `metadata` leaves none. A new "Changing Metadata" README section shows how to change it (re-`put()` the same body with the complete new set) and what that implies: a full GET and PUT, `cacheControl` passed again, another stored version on versioned buckets (the default), a rewrite that isn't atomic, and no custom metadata on presigned uploads. It also notes that S3 stores metadata keys in lowercase while the local mock keeps their case; DESIGN.md lists this among the mock vs AWS differences. The `PutOptions.metadata` and `put()` JSDoc say the same.
