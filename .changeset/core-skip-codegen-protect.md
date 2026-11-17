---
'@aws-blocks/core': patch
---

The OpenRPC spec generator now honours `@blocksSkipCodegen` on methods of an `auth.protect()` namespace, in its `public` and `methods` handlers alike, as it already did for `new ApiNamespace(…)`. Before, a tagged method there, such as the `auth` template's local-only `getLastCode`, still reached the spec and so the generated Swift, Kotlin and Dart clients. The TypeScript client can call it as before.
