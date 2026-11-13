---
"@aws-blocks/bb-file-bucket": patch
---

The FileBucket docs now state that `get()` always downloads the whole body and is the only call that returns `contentType` and `metadata`, because there is no metadata-only read. `scan()` returns `size` and `lastModified` without the body.
