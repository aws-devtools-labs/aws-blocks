# Transferables

Most methods return plain data, and the generated client gives you a data class. Some return a
**live object** instead — a realtime channel you subscribe to, a file handle you upload through, an
OIDC client you sign in with. Those are transferables.

A transferable cannot travel over JSON-RPC as itself, so the backend sends a **descriptor** in its
place: a JSON object carrying a `__blocks` tag that names the kind of object, alongside whatever
that kind needs to reconstitute itself.

```json
{ "__blocks": "realtime/channel", "channel": "cursors/default", "wsUrl": "wss://…", "token": "…" }
```

The client reads the tag, builds the matching Kotlin object, and hands you that rather than the
descriptor. The spec marks the result schema with `x-blocks-transferable` (plus
`x-blocks-type-args` for generic arguments) so codegen knows to emit `RealtimeChannel<Cursor>`
where the raw schema would have produced a struct. Transferables travel in the result position
only — they are what a method hands back, never something you pass in.

## The built-in bindings

| Tag | Kotlin type |
|---|---|
| `realtime/channel` | `RealtimeChannel<T>` |
| `file-bucket/download` | `FileDownloadHandle` |
| `file-bucket/upload` | `FileUploadHandle` |
| `oidc/client` | `OidcClient<P>` |

Hydration validates the descriptor before building anything: the object must carry a `__blocks`
that is a non-empty string and equal to the tag the call site expects, or a `TransferableException`
is thrown naming both. A descriptor from the wrong kind of transferable is therefore a reported
error rather than a half-built object.

## Tags with no binding

When a method returns a transferable whose tag has no runtime binding on this platform, the
generated client returns `UnknownTransferable` rather than failing code generation. It carries the
raw `tag` and `descriptor` without hydrating them, so a spec that uses a block this client does not
implement still compiles and still returns something inspectable.

This covers bare direct results. A *nullable* unbound result fails code generation.

## Declared bindings

A spec can bind a tag to a type you supply. When `x-blocks-native-bindings` names the tag and its
package has an `android` field, the client returns that declared type, hydrated through
`<Type>.fromBlocksDescriptor` after the descriptor is checked against the tag.

The factory a declared package has to expose is specified in
[the schema generation guide](../../../docs/native-clients/schema-generation-guide-for-devs.md#x-blocks-native-bindings-document-root).

To keep the `UnknownTransferable` fallback for a tag the spec declares a binding for, name its
logical identity in [`excludeNativePackages`](gradle-plugin.md#excludenativepackages).

## Nullable results

A nullable result whose body is JSON `null` returns `null`, for both built-in and declared
bindings. Only the unbound case is rejected at code generation.

## Nested transferables

A transferable the runtime binds (a realtime channel, a file handle, an OIDC client) hydrates into
its live object wherever it appears: returned directly, inside a list or map, in a property of a
model, or in the messages of a realtime channel (`RealtimeChannel<List<FileDownloadHandle>>`, or a
channel whose message model holds one). An OIDC client needs the calling client and the configured
`oidc { relayTo }`, so a model that holds one decodes through its generated operation; to decode one
yourself, use `OidcClient.json(blocksClient, relayTo).decodeFromJsonElement<LoginMenu>(json)`.
Transferables are read-only: an operation that takes one as a parameter fails code generation, and
encoding a model that holds one throws `UnsupportedOperationException`. A tag with no binding has to
be a direct result to get the `UnknownTransferable` fallback.

## Realtime subscriptions

`RealtimeChannel.subscribe()` returns a cold `Flow`. Each collection subscribes on the channel's
shared WebSocket and doesn't wait for the server to confirm, so a message published before the
server has the subscription can be missed.

The flow completes normally only when you cancel the collection or call `close()`. Every other end
throws a `RealtimeException`:

| Exception | When | What to do |
|---|---|---|
| `RealtimeSubscriptionEndedException` | The server refused the subscribe or ended it. `code` is the server's code: `token_expired`, `access_revoked`, `principal_mismatch`, or `null` when the server refused the subscribe, for example because the token is invalid or expired. | On `token_expired`, call the API method that returned the channel again and subscribe to the new handle. On `null`, do the same if the handle has been held for a while, since its token can expire before the subscribe. On `access_revoked` and `principal_mismatch`, don't retry as the same user. |
| `RealtimeConnectionException` | The socket couldn't open, failed, or was closed by the server or the gateway. | Get the channel again and subscribe to the new handle. |

A message the deserializer can't decode ends the flow with the deserializer's error.

The client never repeats the API call that returned the channel, and it doesn't reconnect. A
channel token lasts about an hour, and the server checks it when the client sends its keep-alive
ping (every 9 minutes per socket), so a subscriber can go up to 9 minutes without messages before
the `token_expired` error arrives.

```kotlin
suspend fun followCursors(blocks: Blocks) {
    var backoff = 1.seconds
    while (true) {
        try {
            blocks.api.realtimeGetChannel("room-1").subscribe().collect { cursor ->
                backoff = 1.seconds
                draw(cursor)
            }
            return
        } catch (e: RealtimeSubscriptionEndedException) {
            // A fresh channel has a fresh token. Any other code means the user lost access.
            if (e.code != "token_expired" && e.code != null) throw e
            // A refusal with no code repeats if the new token is refused too, so back off.
            if (e.code == null) backoff = waitAndGrow(backoff)
        } catch (e: RealtimeConnectionException) {
            // The socket dropped, for example when the network did.
            backoff = waitAndGrow(backoff)
        }
    }
}

suspend fun waitAndGrow(backoff: Duration): Duration {
    delay(backoff)
    return (backoff * 2).coerceAtMost(30.seconds)
}
```

## HTTP clients

A realtime channel and a file handle each open their own HTTP engine rather than sharing the one
its `Blocks` instance owns, in either position. `Blocks.close()` does not reach them, and
`RealtimeChannel.close()` stops the channel without releasing its engine, so an app that opens
many handles accumulates engines for the lifetime of the process. An `OidcClient` is the
exception — it runs on the instance's engine.

This is tracked in [#1206](https://github.com/aws/cdk-blocks/issues/1206).
