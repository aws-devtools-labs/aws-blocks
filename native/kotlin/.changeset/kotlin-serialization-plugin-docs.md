---
"aws-blocks-kotlin": patch
---

Document the kotlinx.serialization plugin the Gradle plugin requires

Codegen emits `@Serializable` types, so a module without
`org.jetbrains.kotlin.plugin.serialization` fails to build, and the quick start left it out. The
README's `plugins {}` block and the plugin's usage example now apply it with the project's Kotlin
version.
