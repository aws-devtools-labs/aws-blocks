---
"aws-blocks-swift": patch
---

fix(swift): send the realtime connect token on the WebSocket handshake

`RealtimeChannel.subscribe()` could never connect to a deployed backend. The
channel descriptor carries two separate credentials, and the Swift client used
only one of them:

- `connectToken` authenticates the WebSocket **handshake**. API Gateway's
  `$connect` route reads it from `queryStringParameters.token`.
- `token` authorizes the per-channel **subscribe** message sent after the socket
  opens.

`fromJSON` parsed `channel`, `wsUrl`, and `token`, and ignored `connectToken`
entirely. `WebSocketSession.acquire` then connected to the bare `wsUrl`, so the
handshake arrived unauthenticated and API Gateway rejected it. On Apple
platforms that surfaces as `NSURLErrorDomain` code -1011, "There was a bad
response from the server", with `_NSURLErrorWebSocketHandshakeFailureReasonKey`
set — an error that names neither the token nor the route.

`fromJSON` now appends `connectToken` to `wsUrl` as a `token` query parameter,
which is what the Kotlin and Dart clients already do. Existing query parameters
are preserved, and a descriptor without a `connectToken` hydrates unchanged.

Everything that did not open a socket kept working, which is why this went
unnoticed: `getChannel`, `publish`, and the cursor RPC calls are plain HTTP.
`testGetChannelDescriptor` also passed, because it only asserted the descriptor
was non-nil. It now asserts the hydrated `wsUrl` carries a connect token, so the
gap is caught without a socket, and six unit tests in `RealtimeChannelTests`
cover the query building (real base64url tokens pass through byte-for-byte,
existing parameters survive, and `&` is encoded so a token cannot be truncated).
