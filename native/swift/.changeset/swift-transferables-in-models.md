---
"aws-blocks-swift": minor
---

Types that hold a realtime channel, a file handle or an OIDC client now compile and decode

If one of your API's types had a property holding a transferable (a `RealtimeChannel`, a `FileDownloadHandle`, a `FileUploadHandle` or an `OIDCClient`), the generated Swift client didn't compile. This applied to a property, or to an array, dictionary or optional property, or to a property inside another type. An operation that returned a list of channels had the same problem. The transferable types weren't `Codable`, and the generated `Models.swift` didn't import `BlocksRuntime`. So you couldn't build a Swift client for an API that returns, say, a board holding its realtime channels.

The transferable types are now `Codable`. Each one decodes from the descriptor the server sends (`{ "__blocks": "realtime/channel", … }`), the same way an operation that returns one directly hydrates it, and encodes back to that descriptor. A decoded channel rewrites `localhost` to `BlocksClient.baseHost` and connects with its connect token, as before. `Models.swift` now imports `BlocksRuntime` when it uses one of these types.

An `OIDCClient` signs in through the `BlocksClient` that fetched it, so it decodes only with a decoder that carries that client. The new `BlocksClient.makeDecoder()` returns one, and a generated operation whose result holds an OIDC client at any depth now uses it. Every other operation still decodes with `JSONDecoder()`. If you decode such a type yourself, use `client.makeDecoder()`, or set `decoder.userInfo[.blocksClient]`. Without the client, decoding throws `DecodingError.dataCorrupted`.

Decoding a transferable whose descriptor names a different type, or that lacks a required field, throws a `DecodingError`. `RealtimeChannel.fromJSON` still traps on a malformed descriptor, as before.
