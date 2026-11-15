---
"aws-blocks-swift": minor
---

Custom sign-up attributes are now sent correctly

Custom sign-up attributes are now sent correctly. The `signUp` action of an `Auth` block's `createApi()` is a schema with both `properties` and `additionalProperties` (TypeScript `T & Record<string, V>`), and its generated struct collects the extra keys in `attributes`. When such a struct was declared inside an operation (`Api.SignUp.Input`) or as a union variant (`AuthApi.SetAuthState.SignUp`), it was sent with its `attributes` nested under an `"attributes"` key, so `.signUp(AuthApi.SetAuthState.SignUp(password: …, username: …, attributes: ["email": …]))` didn't set the user's `email`: the server received one attribute named `attributes` holding an object instead. In the other direction, a response's extra keys weren't read into `attributes`. These structs also had no `public init`, so code outside the generated module couldn't construct them.

Each entry of `attributes` is now its own key, next to the struct's properties, in both directions, wherever the struct is declared, as it already was for your named models. Every such struct has a `public init(…, attributes: [String: V] = [:])`. A key that names one of the struct's properties, or the union's discriminator (`action`), is never read into `attributes`, and an `attributes` entry with such a name isn't sent, so the typed property wins. Named models now skip such an entry too; before, it overwrote the property on the wire.
