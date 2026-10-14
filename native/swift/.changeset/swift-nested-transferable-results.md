---
"aws-blocks-swift": patch
---

fix(swift): decode transferables nested in a result

A generated result that holds a `RealtimeChannel`, `FileDownloadHandle` or `FileUploadHandle` below
its top level (in a nested object, a `oneOf` arm or an array) no longer fails to compile with "does
not conform to protocol 'Decodable'". The three types now conform to `Decodable`, `RealtimeChannel`
when its message type does, and hydrate from their descriptor: a channel applies
`BlocksClient.baseHost` and the `connectToken`, and decodes its messages with `JSONDecoder`. A
realtime result at the top level now hydrates the same way, so a channel descriptor without
`channel`, `wsUrl` or `token` throws `DecodingError` instead of trapping, and a descriptor that isn't
an object throws `DecodingError` instead of `RPCError`. A file descriptor without `url` throws
`FileBucketError.invalidURL`, as `fromJSON` does.

The three types also conform to `Encodable`, so the generated `Codable` conformances compile, but
encoding one throws `EncodingError`: transferables are read-only, as on Kotlin.

The three classes are now `final`. They were `public` and not `open`, so only code that imports
`BlocksRuntime` with `@testable` could subclass them. `FileDownloadHandle` and `FileUploadHandle` are
also `Sendable` now, so Swift 6 code can pass them between actors. An `oidc/client` below the top level is still
unsupported.
