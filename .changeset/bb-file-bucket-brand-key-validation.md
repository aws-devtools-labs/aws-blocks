---
'@aws-blocks/bb-file-bucket': patch
---

Brand the `ValidationFailed` error thrown for an invalid object key so its name and message reach RPC clients instead of a generic internal error.
