---
"aws-blocks-kotlin": patch
---

Generated clients now compile when a schema has an inline-object property

If one of your API's types has a property whose type is an inline object (for example `payload: { label: string }`) and not a named type, the generated Kotlin client referenced a nested class such as `Holder.Payload` but usually didn't generate it, so the client failed to compile. Such properties now generate as nested `@Serializable` data classes of their type (`Holder.Payload`). This includes objects nested inside objects (`Holder.Payload.Meta`), optional and nullable properties, lists and maps of inline objects, and enums declared inside them. Two types that each have a property of the same name get separate classes.
