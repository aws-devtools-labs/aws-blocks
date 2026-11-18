---
"aws-blocks-kotlin": minor
---

A realtime subscription that ends now throws instead of going quiet

`RealtimeChannel.subscribe()` returns a flow that completes normally only when you cancel the collection or call `close()`. Every other end throws a `RealtimeException`:

- **`RealtimeSubscriptionEndedException`** (new) when the server refuses the subscribe or ends it, for example when the channel token expires. It carries `channel`, and `code` as the server sent it: `token_expired`, `access_revoked`, `principal_mismatch`, or `null` when the server refused the subscribe, for example because the token is invalid or expired. On `token_expired`, call the API method that returned the channel again and subscribe to the new handle. Do the same on `null` for a handle the app has held for a while, since its token can expire before the subscribe.
- **`RealtimeConnectionException`** when the socket can't open, fails, or is closed by the server or the gateway. A connect failure used to escape as a Ktor exception, and a closed socket left the flow waiting forever.

The client sends the `{"action":"ping"}` keep-alive every 9 minutes while a socket has a subscription, as the web client does. The server re-checks the socket's subscriptions on that ping, and the ping keeps the gateway from closing an idle socket. The client never repeats the API call that returned a channel and doesn't reconnect on its own.

`close()` now completes every active collection of the channel, including one whose socket is still opening. A socket that fails leaves the pool at once, so the next `subscribe()` opens a new one, and cancelling the first collector on a shared socket no longer stops delivery to the others. Channels on the same URL share one socket whatever their channel tokens, where each token used to open its own. A `message` frame with no payload now reaches the deserializer as null instead of being skipped.

When the last collection of a channel ends and other channels keep the socket open, the client sends `{"action":"unsubscribe","channel":...}`, so the server stops delivering that channel. The WebSocket request no longer inherits the client's 60-second socket timeout, which on iOS could otherwise apply to a socket that is quiet between pings. Opening a socket has its own 30-second limit instead, so a server that never answers the upgrade ends the collection with `RealtimeConnectionException`.

**Breaking:** `RealtimeSubscriptionEndedException` is a new subclass of the sealed `RealtimeException`, so an exhaustive `when` over `RealtimeException` needs a branch for it. `WebSocketPool`, `ConnectionKey` and `ManagedConnection` are no longer public, and the `RealtimeChannel` constructor no longer takes a `pool`.
