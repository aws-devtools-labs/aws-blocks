---
'@aws-blocks/bb-file-bucket': patch
'@aws-blocks/blocks': patch
---

Fix local FileBucket version deletion so removing the newest stored data version updates the current body and metadata from the next stored data version, or removes the current copies when none remain. Active delete-marker flags and older-version deletion behavior are preserved. Document that historical delete markers discarded by a subsequent upload are not reconstructed, so deletion across re-uploads still differs from S3.

Ignore nested-key directories when reading version history. Retain the target version body until current-copy reconciliation and version-sidecar removal succeed, allowing filesystem failures to be retried with the same version ID.
