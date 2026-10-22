---
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/blocks": patch
---

Return HTTP 404 for local presigned downloads of unknown or permanently deleted file versions instead of serving the current file's content.
