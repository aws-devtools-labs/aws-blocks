---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): find the `ApiNamespace` handler by position when generating the native-client spec

The OpenRPC spec generator took the **last** `new ApiNamespace(...)` argument as
the handler. Given an argument after the handler (an options object), it read
that instead: the namespace's methods came out with `unknown` types in the
Swift, Kotlin and Dart bindings, and methods tagged `@blocksSkipCodegen` leaked
into the spec. It now uses the handler argument itself, whatever follows it.
