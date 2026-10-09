---
"aws-blocks-kotlin": patch
---

Fix realtime channels whose messages hold transferables, and OIDC clients in a model's additional properties

A realtime channel's messages now hydrate the transferables they hold. If a channel's message type was a list or map of file handles or channels (for example `RealtimeChannel<List<FileDownloadHandle>>` or `RealtimeChannel<List<RealtimeChannel<Note>>>`), every message threw `Serializer for class 'FileDownloadHandle' is not found` when it arrived. Each message now decodes into live handles and channels. When such a channel sat inside a list or map of a model (`Map<String, RealtimeChannel<FileUploadHandle>>`), the generated client didn't compile; it does now. A channel whose message model has a file handle or channel field already worked and is unchanged.

A channel whose messages hold an OIDC client (`RealtimeChannel<SignInOption>`, where `SignInOption` has an `OidcClient` property) threw on every message, because nothing bound the client to your `BlocksClient`. Each message now decodes with `OidcClient.json(blocksClient, relayTo)`, whether the channel is returned directly or sits in a model. As with any other operation that returns an OIDC client, such an operation is replaced by a stub that names the missing configuration when `oidc { relayTo }` is required and not set, and the build warns.

An operation that returns a model whose additional properties are OIDC clients (a schema with `properties` and `additionalProperties: oidc/client`, through a `$ref`) now decodes with `OidcClient.json` too, and is gated on `relayTo` like the others. Before, it decoded with plain `BlocksJson`, which can't hydrate an OIDC client.
