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

A transferable is usually a method's whole result, but it can also be a property of one. Nested
position supports `realtime/channel`, `file-bucket/download` and `file-bucket/upload`. An
`oidc/client` has to be returned directly, and a tag with no binding has to be a direct result to
get the `UnknownTransferable` fallback.

That gap is tracked in
[#1206](https://github.com/aws-devtools-labs/aws-blocks/issues/1206).

## HTTP clients

A realtime channel and a file handle each open their own HTTP engine rather than sharing the one
its `Blocks` instance owns, in either position. `Blocks.close()` does not reach them, and
`RealtimeChannel.close()` stops the channel without releasing its engine, so an app that opens
many handles accumulates engines for the lifetime of the process. An `OidcClient` is the
exception — it runs on the instance's engine.

This is tracked in [#1206](https://github.com/aws-devtools-labs/aws-blocks/issues/1206) alongside
the nested-position gap; both come from hydration having no path back to the calling client.
