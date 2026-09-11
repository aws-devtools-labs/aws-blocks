---
"@aws-blocks/bb-file-bucket": patch
---

Validate presigned URL expiration values before creating local tokens or AWS signatures. `getUrl`, `putUrl`, and upload/download handles now reject values that are not whole seconds between 1 and 604800 with `ValidationFailed`, matching Signature Version 4 requirements.
