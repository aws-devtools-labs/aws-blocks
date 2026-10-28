---
'@aws-blocks/core': patch
'@aws-blocks/blocks': patch
---

An RPC error response no longer passes through a `Set-Cookie` whose `Max-Age` is malformed but could be read as a positive lifetime (such as `+999` or `999abc`), even when its `Expires` is in the past. Error responses carry only cookies that every browser deletes.
