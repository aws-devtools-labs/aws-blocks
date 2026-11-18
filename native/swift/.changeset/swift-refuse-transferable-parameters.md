---
"aws-blocks-swift": minor
---

Codegen refuses an operation that takes a transferable parameter, as the Kotlin generator does

**Breaking:** a spec with an operation that takes a transferable parameter no longer generates. A transferable (any `x-blocks-transferable` tag: a `RealtimeChannel`, a `FileDownloadHandle`, a `FileUploadHandle`, an `OIDCClient`, or a type a block's native package binds through `x-blocks-native-bindings`) only travels from the server to the client: the server never re-hydrates one that a client sends back. The Swift generator used to emit a method that took one anyway, and the call couldn't work. Generation now fails instead, with the Kotlin generator's message, for the first such parameter Kotlin would report:

```
Transferable types (realtime/channel) cannot be serialized — they are read-only
```

This covers a direct, optional, nullable, array or dictionary parameter, and a `$ref` to a transferable schema: the same parameters Kotlin refuses. A model, an inline object or a union that holds a transferable still generates, in Swift as in Kotlin, as does any transferable in a result.
