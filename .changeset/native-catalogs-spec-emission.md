---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

`blocks.spec.json` can now carry two top-level OpenRPC extensions,
`x-blocks-native-packages` and `x-blocks-native-bindings`, so native codegen can
resolve a transferable tag to a package export instead of a hard-coded switch.
`generateSpec` and `writeSpec` take a new trailing `SpecGenerationOptions`
carrying the declarations, and invalid metadata throws `NativeCatalogError`
before any file is written. Nothing populates the declarations yet, so a
generated spec is unchanged.

`@aws-blocks/blocks` gets the same bump because it re-exports `@aws-blocks/core/scripts`.
