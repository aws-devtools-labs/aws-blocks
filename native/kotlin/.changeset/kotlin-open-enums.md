---
"aws-blocks-kotlin": minor
---

Decode enum values a client doesn't know

A string enum that a response can carry (one reachable from a method result, at any depth) is now
open, so a value a newer backend adds no longer makes decoding throw `SerializationException`. Such
an enum is a sealed class: each known value is a `data object` with the same name it had as an
enum constant (`Status.Active`), and any other value decodes to `Status.Unknown(value)`, which
holds the string as the server sent it. Every case has the wire string as `value`, a generated
serializer writes it back, so an unknown value round-trips, and `Status.entries` lists the known
cases. When a spec value is already named `unknown`, the fallback is `UnknownValue`. An enum that
only parameters use stays a closed `enum class`.

**Breaking in source.** An exhaustive `when` over an open enum needs an `is Status.Unknown` (or
`else`) branch. `valueOf`, `name`, `ordinal`, `enumValues`, `EnumSet` and `EnumMap` don't apply to
a sealed class; use `value`, `entries` and `fromValue` instead.
