---
"@aws-blocks/bb-realtime": minor
---

feat(bb-realtime): production Realtime middleware now auto-reconnects and resubscribes after an unexpected WebSocket drop

The production (`aws-middleware`) Realtime transport previously gave up when the WebSocket
closed unexpectedly (e.g. an API Gateway idle timeout or an abnormal `1006` closure) — only the
local mock middleware recovered. It now transparently reconnects with exponential backoff (capped
retries), rebuilds the socket URL from the retained connection token, and resubscribes every active
channel by replaying its stored per-channel token so the server can re-authorize. The keep-alive
ping timer is re-armed on the fresh socket. Only a client-initiated teardown — unsubscribing the last
channel (or the internal reset/give-up paths) — is treated as terminal; an unexpected drop reconnects on ANY close code, including a clean `1000`/`1005`.

`SubscribeOptions` gains an optional `onReconnect` callback, fired once after a successful
reconnect when every channel on the connection has been re-confirmed by the server (after the
corresponding `onDisconnect` for the drop that triggered it; never on the initial subscribe).

This change is behavior-additive: existing `subscribe(handler)` / `SubscribeOptions` callers are
unaffected and need no changes. Note for maintainers: on a `0.x` package this ships as a `minor`
per this repo's convention (minor is the breaking/behavior-change channel pre-1.0), since it alters
the runtime reconnect behavior of the production transport.
