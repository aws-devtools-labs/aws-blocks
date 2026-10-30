---
"aws-blocks-swift": minor
---

Validate a declared binding the way the other generators already do

**A result whose `x-blocks-type-args` count disagrees with its binding's `genericArity` is now a
generation error.** An arity-one binding whose result carried no type argument generated
`Module.Type<BlocksRuntime.JSONValue>` and a `JSONValue` decoder, handing the customer's
`Type<T>` a placeholder payload; an arity-zero binding whose result carried one, and an
arity-one result carrying two, silently dropped the extra argument. Dart and Kotlin refuse all
three.

**`genericArity` is now required.** An absent value resolved to zero, so a binding meant to be
generic generated as non-generic. Dart and Kotlin, and spec generation, already require it.

**Every catalog check but the ABI allowlist now runs whatever the binding's `kind`.** Package existence, the empty-tag check, tag uniqueness, the `genericArity` presence and range guards and the `export` type-name guard all move above the kind gate, matching the single enforcement point in `validate-native-catalogs.ts`. Only the ABI allowlist stays `transferable`-specific. A binding of an undefined
kind returned before the package-existence and tag-uniqueness checks, so one naming an undeclared
package, or re-binding a tag another binding already took, generated with only
`AWSBLOCKS-NATIVE-004`. Both are generation errors now, as they are on Dart and Kotlin.

Every diagnostic now escapes the spec-supplied values it names, so a newline in one cannot split it
across log lines or emit a line that reads as a second diagnostic. That covers the
`AWSBLOCKS-NATIVE-003`, `-004`, `-005` and `-006` warnings and every `invalidNativeCatalog` error,
which named a binding's `id`, `tag`, `package`, `abi` or `export`, and a package's key or Swift
module, raw. They share the escape the `-001` path already applied, which moves to
`escapedForDiagnostic` with byte-identical output.

`AWSBLOCKS-NATIVE-003` no longer reports a declared package whose only binding is not a
`transferable` one, although that binding names it; Dart and Kotlin already treat it as referenced.

No public Swift API changes: `DeclaredTransferableBinding`, `declaredResultTypeName` and
`declaredTypeName` are all internal to `BlocksCodegen`.
