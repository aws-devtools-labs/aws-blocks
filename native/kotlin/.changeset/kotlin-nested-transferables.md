---
"aws-blocks-kotlin": minor
---

Generated clients now hydrate transferables inside lists, maps and models, and accept a `$ref` to an enum

If one of your API's types held a realtime channel or a file handle inside a list or a map (for example `channels: List<RealtimeChannel<Note>>`, `feedsByRoom: Map<String, RealtimeChannel<Note>>` or `downloads: List<FileDownloadHandle>`), the generated Kotlin client didn't compile, because only a property that was itself a transferable got a serializer. Each transferable inside a list, map or nullable element now gets its serializer on that type usage (`List<@Serializable(with = RealtimeChannelNoteSerializer::class) RealtimeChannel<Note>>`), at any depth. An operation that returns a list or map of transferables directly, such as `listFeeds(): List<RealtimeChannel<Note>>`, compiled but threw `Serializer for class 'RealtimeChannel' is not found` when called; it now decodes each element into a live channel or handle.

An OIDC client (`oidc/client`) inside a model threw `Unknown transferable: oidc/client`, or didn't compile when no relay target was configured. It is now a `@Contextual` property or element, and an operation whose result holds one at any depth decodes it with the new `OidcClient.json(blocksClient, relayTo)`, which binds every OIDC client in the result to the calling client and the configured `oidc { relayTo }`. As for an operation that returns an OIDC client directly, such an operation is replaced by a stub that names the missing configuration when `relayTo` is required and not set, and the build warns.

A `$ref` to a component schema that isn't an object failed generation with `$ref '#/components/schemas/Level' resolved to non-object type`. A `$ref` to an enum now generates one top-level enum named after the schema (`enum class Level`), shared by every property, parameter and result that uses it. A `$ref` to any other schema (a string, an array, a map, a nullable) uses the type that schema declares.
