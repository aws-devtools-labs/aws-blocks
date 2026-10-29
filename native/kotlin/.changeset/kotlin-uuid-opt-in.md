---
"aws-blocks-kotlin": patch
---

Fix generated clients that use a `format: uuid` field or parameter not compiling

A `format: uuid` value is a `kotlin.uuid.Uuid`, which requires opting in to `ExperimentalUuidApi`. The generated files used it without opting in, so any client generated from a spec with a uuid failed to compile with "This declaration needs opt-in". Each generated file that uses `Uuid` now carries `@file:OptIn(ExperimentalUuidApi::class)`. Your own code that calls a generated method or reads a generated property with a `Uuid` in its signature still needs to opt in, as it would for any `kotlin.uuid` API: add `@OptIn(ExperimentalUuidApi::class)` to it, or opt in module-wide with `kotlin { compilerOptions { optIn.add("kotlin.uuid.ExperimentalUuidApi") } }` in your `build.gradle.kts`.
