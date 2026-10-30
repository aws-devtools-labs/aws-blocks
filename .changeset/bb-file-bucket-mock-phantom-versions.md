---
'@aws-blocks/bb-file-bucket': patch
---

The local `FileBucket` mock no longer reports phantom versions for a key that is a prefix of another key. `listVersions('docs')` now returns `[]` when only `docs/readme.txt` was written, `get('docs', { versionId: 'readme.txt' })` returns `null` instead of throwing `EISDIR`, and `restoreVersion` throws `VersionNotFound`, matching AWS.
