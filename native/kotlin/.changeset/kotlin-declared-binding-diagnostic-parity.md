---
"aws-blocks-kotlin": minor
---

Report a declared binding codegen cannot apply

**`NativeTransferableBinding` gains a required `id`, appended last.** The type is public and
published, in `com.aws.blocks.kotlin:codegen`, so this is a source-breaking addition for a
consumer that constructs it. `component1()` and the existing positional slots are unchanged, so a
positional caller fails to compile for the missing argument rather than rebinding silently; pass
`id` by name alongside the other arguments. `NativeCatalogs` gains `declaredBindings`, which is
defaulted.

A binding whose `kind` schema 1 does not define now reports `AWSBLOCKS-NATIVE-004`; it was skipped
in silence.

**A binding entry of an undefined `kind` with no `tag` is now a spec error.** A `transferable`
entry already failed; one of any other kind was skipped in silence, so a tag typo'd alongside a
kind typo generated nothing and said nothing.

Every native-catalog diagnostic, and the operation name in `AWSBLOCKS-NATIVE-001`, `-002` and the arity error, now escapes the spec-supplied values it names, so a newline in one cannot split it
across log lines or emit a line that reads as a second diagnostic. `forDiagnostic` moves beside
`CodegenException` and becomes `internal`, because the parser's errors need it too — including the
`x-blocks-native-packages.packages.<identity>` path, which carried the identity raw into six of
them.
