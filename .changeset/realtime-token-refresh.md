---
"@aws-blocks/bb-realtime": minor
---

feat(bb-realtime): refresh channel/connect tokens on reconnect so subscriptions outlive token TTLs

Adds an optional `refresh` callback to `SubscribeOptions`:

```ts
refresh?: () => Promise<RealtimeChannelDescriptor>;
```

A reconnect opens a *new* WebSocket, which means API Gateway re-checks the
connect token (carried in the socket URL, validated at `$connect`, ~2h TTL) and
the server re-checks the channel token on resubscribe (~1h TTL, per `utils.ts`
`mintChannelToken`'s 3600s default). Until now both the AWS and mock middlewares
replayed the *original* stored `wsUrl` + channel token on every reconnect, so a
reconnect more than ~1h after the descriptor was minted failed (the channel
token had expired and the resubscribe was rejected), and more than ~2h after
failed to even open the socket (`$connect` 403). Token minting is server-only
(it needs the signing secret), so the client cannot re-sign locally — it must
re-call the server method that produced the descriptor.

When `refresh` is provided, both middlewares now call it **before** opening the
reconnect socket (never on the initial subscribe), then open with the fresh
connect token in the URL and resubscribe with the fresh channel token. The
refresh-before-open ordering is required because the connect token lives in the
socket URL and is validated at `$connect`, so it must be fresh at construction
time. If `refresh` rejects, the middleware does not crash: it surfaces the
failure via the existing `onDisconnect('error')` path and falls back to the
normal exponential-backoff reconnect so a later attempt can retry.

Fully backward compatible: with no `refresh` callback, a reconnect replays the
stored `wsUrl` + token exactly as before, and the initial (non-reconnect) open
stays synchronous and unchanged.

This is a `minor` bump. `@aws-blocks/bb-realtime` is pre-1.0, where `minor` is
this repo's signal for an API addition; the new option is optional and additive,
and existing behavior is unchanged when it is omitted.
