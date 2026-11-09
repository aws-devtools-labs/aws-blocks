---
'@aws-blocks/bb-secret': patch
'@aws-blocks/blocks': patch
---

`Secret` schema-validation errors no longer include the secret value. Schema libraries often quote the received value in their issue messages, and a `SecretErrors.ValidationFailed` error's message is returned to the RPC caller, so `get()` and `put()` now throw it with a fixed message that names at most the path of the first failing field (for example `The secret value did not match the schema at 'port'`). The library's original issues stay on the error's non-enumerable `cause` (`cause.issues`) for server-side logging. The error name is unchanged, so `isBlocksError(e, SecretErrors.ValidationFailed)` checks keep working.
