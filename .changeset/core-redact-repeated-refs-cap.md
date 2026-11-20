---
'@aws-blocks/core': patch
---

The dev server's redacted RPC request/response logging now stays bounded when a payload holds a large shared object graph: a shared object is copied in full at most 1000 times per logged value, and later repeats are logged as `"[Repeated]"`.
