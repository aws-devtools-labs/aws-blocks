---
'aws-blocks-swift': minor
---

feat(swift): end a realtime subscription with a typed error instead of going quiet

A channel token now expires after about an hour, and the backend can revoke a user's access. The server reports either one with an error frame after the client's keep-alive ping. `RealtimeChannel` now sends that ping and reads those frames, so a subscription that the server ends no longer stops receiving without telling the app.

- The stream from `subscribe()` finishes normally only when you cancel the iteration or call `close()`. Every other end finishes it with an error.
- New case `RealtimeError.subscriptionEnded(channel:code:message:underlyingError:)`: the server ended this channel's subscription or refused it. `code` is the server's string as sent: `"token_expired"` (get the channel again), `"access_revoked"` or `"principal_mismatch"` (don't retry as the same user), or `nil` for a refused subscribe. New codes may appear, so treat an unknown one like `nil`. `underlyingError` is `nil` for now. Because `RealtimeError` is an enum, an exhaustive `switch` over it needs a case for this.
- `RealtimeError.connectionFailed` now also covers an error frame that names no channel: it carries the server's message, ends every subscription on the socket and closes the socket. When the server or the gateway closes the socket, the message includes the close code and reason and there is no underlying error; when the socket fails, the platform error is the underlying error. A socket that ends any of these ways is dropped from the pool, so the next `subscribe()` opens a new one instead of joining the dead one.
- Every subscription to one `wsUrl` (which carries the connect token) now shares one socket, whatever its channel or channel token. Before, each channel token opened its own socket.
- `subscribe()` doesn't wait for the server to confirm the subscription. A refused subscribe ends the stream with `subscriptionEnded`.
- While a socket has a subscriber, the SDK sends `{"action":"ping"}` every 9 minutes, as the web client does. This also keeps API Gateway from closing an idle socket after 10 minutes.
- `close()` now finishes every active stream normally. Before, it closed the socket and left the streams waiting.
- A message that fails to decode still ends the stream with the decoder's error.
- The SDK doesn't renew a subscription or reconnect on its own. To renew, call the API method that returned the channel again and subscribe to the new handle.
- `WebSocketDelegate` and `WebSocketConnection` are deprecated. `RealtimeChannel` no longer uses them.
