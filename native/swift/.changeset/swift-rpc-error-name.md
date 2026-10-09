---
"aws-blocks-swift": patch
---

feat(swift): expose the server error name and code on `RPCError`

Errors cross the wire by name: an AWS Blocks backend puts the error's `name`
(for example `NotAuthenticatedException` or `CodeMismatchException`) in the
JSON-RPC `error.data.name` field, and the Kotlin (`ApiException.name`) and Dart
(`BlocksRpcException.data`) clients already surface it. The Swift client only
put the code and message into `RPCError.message`, so an app could not tell a
signed-out user from a wrong password without parsing text.

`RPCError` now has two optional properties, filled in for JSON-RPC errors from
the server:

- `name` — the server's error name (`error.data.name`), or `nil` when the
  server sent none.
- `code` — the JSON-RPC `error.code`; for a server-side `ApiError` this is its
  HTTP status (for example `401`).

Both are `nil` for transport and decoding failures. `message` is unchanged, and
the existing `RPCError(message:underlyingError:)` initializer still works.
