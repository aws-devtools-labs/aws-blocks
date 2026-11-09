---
'@aws-blocks/bb-secret': patch
'@aws-blocks/blocks': patch
---

`Secret` schema-validation errors no longer include the secret value. Schema libraries often quote the received value in their issue messages, and a `SecretErrors.ValidationFailed` error's message is returned to the RPC caller, so `get()` and `put()` now throw it with a fixed message, `ValidationFailedException: The secret value did not match the schema`. The message doesn't name the failing field, because a record or map schema reports the value's own keys as the path. The library's original issues and the first failing path stay on the error's non-enumerable `cause` (`cause.issues`, `cause.path`) for server-side logging. The error name is unchanged, so `isBlocksError(e, SecretErrors.ValidationFailed)` checks keep working.
