---
'@aws-blocks/bb-email-client': patch
'@aws-blocks/bb-secret': patch
'@aws-blocks/bb-file-bucket': patch
---

Correct JSDoc: the `EmailErrors` example now calls `send()` with a single message object, `Secret` examples that call `put()` now pass `allowRuntimeWrite: true`, and the `FileBucket` `removalPolicy` docs now say an omitted policy inherits the stack's `BlocksDefaults.removalPolicy`.
