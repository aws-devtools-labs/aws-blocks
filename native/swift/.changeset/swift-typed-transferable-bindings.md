---
"aws-blocks-swift": minor
---

feat(swift): emit typed transferable results for declared native bindings

Codegen now reads the top-level `x-blocks-native-packages` and
`x-blocks-native-bindings` catalogs from the spec. A method result whose
`x-blocks-transferable` tag matches a binding with a `swift` package entry
returns that package's type — directly, or as an optional when the result is
nullable — importing the declared module and calling its
`fromBlocksDescriptor` factory. Two tags may share one export; two exports
cannot share a type name. `BlocksRuntime` references in a file that imports a
declared module are module-qualified, since a declared package may export a
name the runtime also exports, and each such file imports `BlocksRuntime`. The
new public `validateTransferableDescriptor` checks the tag before the factory
runs.

Built-in tags keep their hard-coded path, and a direct result whose tag has no
applicable binding still returns `UnknownTransferable`. A result bound to a
package the app does not depend on fails to compile, naming the declared
module; add the package and link its product to the target, or list its
`x-blocks-native-packages` key under `optOutNativePackages` in
`blocks.codegen.json` beside the spec. An opt-out that matches no declared
package warns and generates, since the opt-out is build configuration rather
than spec metadata. A catalog the generator cannot act on warns and is skipped:
a declared package no binding references, a `kind` schema 1 does not define, or
a binding on a built-in tag.
