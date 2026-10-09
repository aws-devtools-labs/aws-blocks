---
"aws-blocks-kotlin": patch
---

Fix custom attributes on sign-up, and every other model with additional properties

Custom attributes on sign-up are now sent correctly. A generated class for a schema with both `properties` and `additionalProperties` (TypeScript `T & Record<string, V>`), such as the `signUp` action of an `Auth` block's `createApi()`, collects the extra keys in its `attributes` map. That map was sent nested under an `"attributes"` key, so `AuthApi.SetAuthState.Input.SignUp(username, password, attributes = mapOf("email" to …))` didn't set the user's `email`: the server received one attribute named `attributes` holding an object instead. In the other direction, extra keys in a response were dropped, so `attributes` was always empty.

Each entry of `attributes` is now its own key, next to the class's properties, in both directions. A key that names one of the class's properties, or the union discriminator (`action`), is never read into `attributes`, and an `attributes` entry with such a name isn't sent, so the typed property wins. The generated classes' constructors and properties are unchanged; each one now has its own serializer.
