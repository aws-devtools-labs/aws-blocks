---
"aws-blocks-kotlin": minor
---

Generated clients accept transferable parameters, and a parameter named `result` no longer breaks the client

If an operation of your API took a realtime channel, a file handle or an OIDC client as a parameter (for example `relay(feed: RealtimeChannel<Note>)`), code generation failed with `Transferable types (realtime/channel) cannot be serialized`, so the backend got no Kotlin client at all. Such a parameter is now sent as its `{ "__blocks": … }` descriptor, the shape the server sent it in, as the Swift client does. This works for a parameter that is a transferable, an optional or nullable one, a list or map of them, and a model that holds them. `RealtimeChannel`, `FileDownloadHandle`, `FileUploadHandle` and `OidcClient` gain a `toJson()` that returns that descriptor (the one a value was hydrated from, unchanged). Encoding a model that holds a channel or file handle, or one that holds an OIDC client with `OidcClient.json`, now writes the descriptor too; it used to throw `Transferables are read-only`.

An operation with a parameter named `result` whose type is an inline object, enum or union didn't compile: it declared a second `Result` class next to the operation's result (`Conflicting declarations`). The same happened for two properties whose names differ only in their separators, such as `user_name` and `userName`. The operation's result keeps `Result`, and a later type of the same name in the same scope is now `Result_2` (then `_3`, and so on), as in the Swift client. Every other generated name is unchanged.
