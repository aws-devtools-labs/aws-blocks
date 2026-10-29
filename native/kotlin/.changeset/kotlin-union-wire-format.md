---
"aws-blocks-kotlin": minor
---

Fix unions without a discriminator, boolean discriminators, and the `Auth` `confirmSignIn` action

A Kotlin client couldn't read or send a union (`anyOf` / `oneOf`) unless every arm was an object with a string discriminator. The generated sealed class used kotlinx.serialization's default format, `{"type": "variant1", …}`, which isn't what the server sends or expects. For `anyOf [string, {text}]`, decoding `"abc"` or `{"text":"t"}` threw, and the string arm was a `data object` that couldn't hold the string at all.

Now each value is its arm's bare JSON value, in both directions. A string, number, boolean, array, map, date-time or transferable arm is a subclass that holds its value: `Search.Query.Variant1("abc")` (it was `Search.Query.Variant1`, with no value) is sent as `"abc"`. A `const` arm stays a `data object` and is written as its literal, with its JSON type. An object arm is its plain object. A value decodes to the first arm, in spec order, whose JSON shape it has, and a value that matches no arm throws a `SerializationException` that names the union.

A boolean discriminator (`isUpdated: true`) is now written when encoding (it was left out) and must be a JSON boolean when decoding (the string `"true"` was accepted). A numeric discriminator is written as a number.

The `confirmSignIn` action of an `Auth` block's `createApi()`, and any other arm that has its own properties plus a nested `oneOf`, is sent as one flat object: `ConfirmSignIn(session, challenge = Challenge.Code(code))` sends `{"action":"confirmSignIn","session":…,"challenge":"code","code":…}`. It was sent with the challenge nested (`"challenge": {"challenge": "code", …}`), which the server rejected.

Each affected sealed class now has a generated `<Name>Serializer` object. Code that matched or constructed a union's value arm needs its value (`is Variant1 -> it.value`).
