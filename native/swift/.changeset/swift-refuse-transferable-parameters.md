---
"aws-blocks-swift": minor
---

Codegen refuses an operation that takes a transferable parameter

A transferable (a `RealtimeChannel`, a `FileDownloadHandle`, a `FileUploadHandle` or an `OIDCClient`) only travels from the server to the client: the server never re-hydrates one that a client sends back. The Swift generator used to emit a method that took one anyway, and the call couldn't work. Generation now fails instead, with one line per parameter naming the method, the parameter and, for a model, the field that holds the transferable:

```
Transferable types (realtime/channel) cannot be serialized: they are read-only. Method 'api.relay', parameter 'feed'.
Transferable types (realtime/channel) cannot be serialized: they are read-only. Method 'api.forward', parameter 'bundle' (field Bundle.feed).
```

This covers a direct, optional, nullable, array or dictionary parameter, and a model parameter that holds a transferable in a field, an array, a dictionary or a union arm, at any depth. A model that holds a transferable and only appears in a result still generates.
