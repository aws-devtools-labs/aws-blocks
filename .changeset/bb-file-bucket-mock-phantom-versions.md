---
'@aws-blocks/bb-file-bucket': patch
---

The local `FileBucket` mock now treats a key that is only a prefix of other keys as missing, matching AWS. With only `docs/readme.txt` written, `get('docs')` and `get('docs', { versionId: 'readme.txt' })` return `null` instead of throwing `EISDIR`, and `restoreVersion('docs', ...)` throws `VersionNotFound`.
