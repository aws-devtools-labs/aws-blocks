---
"@aws-cdk-blocks/bb-file-bucket": patch
"aws-cdk-blocks": patch
---

Return HTTP 404 for local presigned downloads of unknown or permanently deleted file versions instead of serving the current file's content.
