---
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/blocks": patch
---

Give new local FileBucket versions UUID-suffixed IDs so re-uploading or restoring after permanent deletion does not reuse saved version references, including across dev-server restarts. Preserve existing numeric version files, metadata, download URLs, and equal-timestamp ordering without a migration or persistent counter. References already reused by an older mock cannot be repaired retroactively. The AWS runtime is unchanged.
