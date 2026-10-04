---
'@aws-blocks/bb-file-bucket': patch
'@aws-blocks/blocks': patch
---

Fix local FileBucket version deletion so removing the current version promotes the next stored version, including its metadata, for reads, scans, and downloads. Removing the last stored version now removes the current file instead of leaving deleted content accessible. Existing delete markers and older-version deletion behavior are preserved.
