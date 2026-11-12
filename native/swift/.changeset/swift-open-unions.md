---
"aws-blocks-swift": minor
---

feat(swift): decode union arms a client doesn't know

A union with a string discriminator that a response can carry is now open, so an arm a newer
backend adds no longer makes decoding throw `DecodingError`. An object whose discriminator names no
arm decodes to `case unknown(JSONValue)`, which holds the object as the server sent it and encodes
back as equal JSON (key order and number formatting may differ), so it round-trips. The union's
`unknownDiscriminator` gives that arm's tag, and is nil for a known arm. When an arm is already
named `unknown` (an arm tagged `unknown`), the fallback case is `unknownValue`. Unions only parameters use, unions with a boolean discriminator or a bare value arm,
and a union embedded in another arm's object stay closed.

**Breaking in source (pre-1.0).** An exhaustive `switch` over an open union needs a
`case .unknown` (or `default`) branch.
