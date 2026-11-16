---
'aws-blocks-swift': minor
---

feat(swift)!: a new error taxonomy for the Swift client

Errors now fall into a few types you can tell apart by what the caller should do, and the Swift client follows the same decision table as the Kotlin and Dart clients. **Breaking:** several error types are removed or renamed, so any `catch` that names one needs updating.

**New types**
- `ApiError`: the server rejected the request. It carries `message`, `status`, `name` and `retriable`. Errors cross the wire by name, so match on `name` rather than on `message` or `status`. A named error thrown without a status arrives as a 500 with its name intact, and JSON-RPC's reserved codes (for example `-32601`) arrive as a 500 with a name such as `MethodNotFound`.
- `TransportError`: the request produced no usable JSON-RPC result, for example a connection failure, a non-JSON response, or a non-2xx response with no JSON-RPC error object. It carries `message`, `statusCode` (`nil` when no response arrived) and `underlyingError`. A 2xx body that is not a JSON object on a raw route is now a `TransportError` with the real status, where it previously leaked a raw `NSError`.
- `Error.isBlocksError(_:)`: true when an error is an `ApiError` with the given name, so `error.isBlocksError("ConditionalCheckFailed")` works the same way as the TypeScript client's `isBlocksError`.
- `TransferableError`: a transferable descriptor could not be hydrated. `.unknownType(_)` means no hydrator is registered for the `__blocks` type, and `.invalidDescriptor(blocksType:missingField:)` means a required field is missing or unusable.

**Breaking changes**
- `RPCError` is removed. A rejected JSON-RPC call now throws `ApiError`, and a transport-level failure throws `TransportError`. Generated clients throw these in its place.
- `RawRouteError` is removed. Raw routes (OIDC exchange and refresh, sign-out) throw `ApiError` when the server answers with an error status, and `TransportError` for everything else. A network failure that used to escape as a bare `URLError` or `NSError` is now a `TransportError` with the original in `underlyingError`.
- `FileBucketError` is replaced by `FileTransferError`, a struct rather than an enum. The `.downloadFailed` and `.uploadFailed` cases become a single type with `message`, `statusCode` (the HTTP status the transfer was rejected with, or `nil` when the request got no response) and `underlyingError`. Its `.invalidURL` cases move to `TransferableError.invalidDescriptor`, because a bad URL in a file handle is a descriptor problem.
- `RealtimeError.websocket(_:_:)` is renamed `RealtimeError.connectionFailed(_:_:)`. The associated values are unchanged.
- `OIDCError` loses five cases: `.invalidURL`, `.missingPKCEState`, `.malformedRefreshResponse` and `.invalidResponse` were never thrown, and `.malformedDescriptor` moves to `TransferableError.invalidDescriptor(blocksType: "oidc", missingField:)`.
- `OIDCError` no longer conforms to `Equatable`, because the new `.exchangeFailed` case carries an `Error`. Replace `error == .stateMismatch` with pattern matching, for example `if case .stateMismatch = error`.

**Additions to existing types**
- `OIDCError.cancelled`: a `BrowserLauncher` throws this when the user dismisses the sign-in sheet, so a catch site can tell a dismissal from a failure.
- `OIDCError.exchangeFailed(_:_:)`: the OIDC code exchange was rejected. The `ApiError` or `TransportError` that caused it is available as `underlyingError`. A caller who catches `OIDCError` now sees a rejected exchange; it used to arrive as a raw-route error. A closed client still throws `ClientClosedError`, since that says nothing about the session.
- `RealtimeError.channelClosed` is documented as a catchable error: a channel closes on its own when the server goes away or the connection drops.

`Decodable` conformances still throw `DecodingError` when a payload does not match its type; that is unchanged.
