---
"@aws-blocks/bb-file-bucket": patch
---

Docs: FileBucket object metadata is set when the object is written and can't be edited in place. Each `put()` replaces it, and a `put()` without `metadata` leaves none. A new "Changing Metadata" README section shows how to change it (re-`put()` the same body with the complete new set) and what that implies: a full GET and PUT, `cacheControl` passed again, a new version on versioned buckets, and no custom metadata on presigned uploads. It also notes that S3 stores metadata keys in lowercase while the local mock keeps their case. The `PutOptions.metadata` and `put()` JSDoc say the same.
