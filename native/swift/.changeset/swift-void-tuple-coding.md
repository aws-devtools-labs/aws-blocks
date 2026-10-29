---
"aws-blocks-swift": minor
---

Fix generated methods that return nothing, and tuples' wire format

- **A method that returns `Void`** bound the RPC result to a `let result` it never used. Swift warns about the unused value, so an app built with warnings as errors (`SWIFT_TREAT_WARNINGS_AS_ERRORS`) failed to compile its generated client. The method now discards the result (`_ = try await client.execute(request)`). Every other method is unchanged.
- **Tuples** (`prefixItems`, TypeScript `[number, number]`) read and write a JSON array. The generated struct keeps its `item0`, `item1`, … properties, but its synthesized `Codable` read and wrote an object keyed by those names, which the server neither sends nor reads. The struct now decodes and encodes `[1, 2]`. An element missing from a shorter array (an optional element) decodes as `nil`.
