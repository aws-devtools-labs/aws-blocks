---
"aws-blocks-swift": minor
---

Codegen refuses an operation that takes a transferable parameter, as the Kotlin generator does

A transferable (a `RealtimeChannel`, a `FileDownloadHandle`, a `FileUploadHandle` or an `OIDCClient`) only travels from the server to the client: the server never re-hydrates one that a client sends back. The Swift generator used to emit a method that took one anyway, and the call couldn't work. Generation now fails instead, with the Kotlin generator's message, for the first such parameter:

```
Transferable types (realtime/channel) cannot be serialized — they are read-only
```

This covers a direct, optional, nullable, array or dictionary parameter, and a `$ref` to a transferable schema: the same parameters Kotlin refuses. A model, an inline object or a union that holds a transferable still generates, in Swift as in Kotlin, as does any transferable in a result.
