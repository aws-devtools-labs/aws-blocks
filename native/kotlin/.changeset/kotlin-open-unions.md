---
"aws-blocks-kotlin": minor
---

Decode union arms a client doesn't know

A union with a string discriminator that a response can carry is now open, so an arm a newer
backend adds no longer makes decoding throw `SerializationException`. An object whose discriminator
names no arm decodes to `Unknown(json)`, which holds the object as the server sent it and is written
back unchanged, so it round-trips. When an arm is already named `Unknown`, the fallback is
`UnknownValue`. Such a union now uses a generated serializer instead of kotlinx's sealed-class
serializer with `@JsonClassDiscriminator`; the JSON is the same. Unions only parameters use, unions
with a boolean discriminator or a bare value arm, and a union embedded in another arm stay closed.

**Breaking in source.** An exhaustive `when` over an open union needs an `is Unknown` (or `else`)
branch.
