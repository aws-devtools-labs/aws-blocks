---
"aws-blocks-swift": patch
---

feat(swift): expose `retriable` and the raw `data` on `RPCError`, add `isBlocksError(name:)`

A server error's `error.data` carries `retriable: true` for a failure the caller
can retry in place, such as a wrong MFA code; the Swift client dropped it, as it
did the raw `data` that Kotlin and Dart keep. `RPCError` now has `retriable`
(`false` when the server sent none) and `data`, the raw `error.data` as
`[String: JSONValue]` (`nil` when absent or not a JSON object).
`Error.isBlocksError(name:)` matches an `RPCError` by its server error name or a
`RawRouteError` by its `errorName`, as `Throwable.isBlocksError` does in Kotlin.

A non-2xx response with no JSON-RPC error (a gateway or route error) now reports
its HTTP status as `RPCError.code`, with `message` `"HTTP Error: <status>"` when
the body is not a JSON object (it was `"Invalid JSON response"`). Every other
`message` is unchanged, and the existing initializers still work.
