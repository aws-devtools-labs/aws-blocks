---
"aws-blocks-swift": patch
---

feat(swift): expose `retriable` and the raw `data` on `RPCError`, add `isBlocksError(name:)`

`RPCError` now has `retriable` (`true` only when the server marked the failure
retriable, otherwise `false`) and `data`, the `error.data` object as
`[String: JSONValue]` (`nil` when absent or not a JSON object). Kotlin and Dart
runtimes keep the raw `data` too; neither exposes `retriable`.
`Error.isBlocksError(name:)` matches an `RPCError` by its server error name or a
`RawRouteError` by its `errorName`; like Kotlin's `Throwable.isBlocksError` it
is offered on any error.

A non-2xx response with no JSON-RPC error now reports its HTTP status as
`RPCError.code`, with `message` `"HTTP Error: <status>"` when the body is not a
JSON object (was `"Invalid JSON response"`); other messages are unchanged.
