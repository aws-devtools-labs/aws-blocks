---
"aws-blocks-swift": minor
---

A union's string, number, boolean, array and map alternatives now keep their value

When a union mixed objects with other values, such as TypeScript's `string | { text: string }`, the generated enum gave each non-object alternative a case with no payload. Decoding `"abc"` produced `.query_Variant0`, which held no string and encoded back as `{}`. The first such case also matched any JSON value, so a number or boolean decoded silently as well. The value was lost in both directions.

Each such case now carries its value, decoded and encoded as the bare JSON value: `case query_Variant0(String)`. A `number` alternative carries a `Double`, an `integer` an `Int`, a `boolean` a `Bool`, an array of strings a `[String]`, and a map a `[String: Int]` (or whatever the element type is). When an array's elements are objects, their struct is generated next to the union, like a variant's struct (`[Objs_Variant0]`). A JSON value that matches no alternative now throws a `DecodingError`. A `null` alternative still makes the union optional (`Query?`), and an empty object alternative is still a case with no payload.

A union with a discriminator field (`{ kind: "a", … } | { kind: "b" } | string`) and a non-object alternative used to generate a client that didn't compile (`switch must be exhaustive`). It now compiles, and the value round-trips.

Two unions that differ only in such an alternative (`string | { x }` and `number | { x }`) are no longer merged into one type.

Case names are unchanged. If your code matches or constructs one of these cases, add the value: `case .query_Variant0(let text)`, `.query_Variant0("abc")`.
