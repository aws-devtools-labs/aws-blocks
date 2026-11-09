---
'@aws-blocks/bb-file-bucket': patch
---

Local file server now returns 404 `NoSuchKey` for presigned GETs of a versioned key whose current version is a delete marker, matching S3 and `get()`.
