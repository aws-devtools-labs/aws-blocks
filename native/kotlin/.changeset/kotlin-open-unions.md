---
"aws-blocks-kotlin": minor
---

Decode union arms a client doesn't know

A union with a string discriminator that a response can carry is now open, so an arm a newer
backend adds no longer makes decoding throw `SerializationException`. An object whose discriminator
is a string that names no arm decodes to `Unknown(json)`, which holds the object as the server sent
it and is written back as that object, so it round-trips; its `discriminator` is the arm's tag. An
object with no discriminator, or a discriminator that isn't a string, still throws. When an arm is
already named `Unknown` (an arm tagged `unknown`), the fallback is `UnknownValue`.

Such a union now uses a generated serializer instead of kotlinx's sealed-class serializer with
`@JsonClassDiscriminator`; the JSON is the same, but the serializer only reads and writes JSON
(`BlocksJson` or another `Json`), not other kotlinx formats. Unions only parameters use, unions with
a boolean discriminator or a bare value arm, and a union embedded in another arm stay closed.

**Breaking in source.** An exhaustive `when` over an open union needs an `is Unknown` (or `else`)
branch.
