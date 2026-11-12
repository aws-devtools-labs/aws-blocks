---
"aws-blocks-swift": minor
---

feat(swift): decode enum values a client doesn't know

A string enum that a response can carry (one reachable from a method result, at any depth) is now
open, so a value a newer backend adds no longer makes decoding throw `DecodingError`. Such an enum
keeps its cases and gains `case unknown(String)`, which holds the value as the server sent it and
encodes back as that string, so an unknown value round-trips. When a spec value is already named
`unknown`, the fallback case is `unknownValue`. An enum that only parameters use stays a closed
`String` enum.

**Breaking in source (pre-1.0).** An exhaustive `switch` over an open enum needs a
`case .unknown` (or `default`) branch. `init(rawValue:)` no longer returns an optional, so
`if let` or `guard let` on it stops compiling. The enum declares `RawRepresentable, Codable,
Hashable` instead of a `String` raw type; `.rawValue` still returns the wire string.
