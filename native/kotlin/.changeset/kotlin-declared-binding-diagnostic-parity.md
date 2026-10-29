---
"aws-blocks-kotlin": minor
---

Report a declared binding codegen cannot apply

**Breaking for a caller that constructs `NativeTransferableBinding` positionally.** `id` is its
first parameter now, so `component1()` returns the id rather than the tag and `copy()`'s positional
signature shifts — a positional caller rebinds silently rather than failing to compile. A named
caller must add `id`. `NativeCatalogs` gains `declaredBindings`, which is defaulted.

A binding whose `kind` schema 1 does not define now reports `AWSBLOCKS-NATIVE-004`; it was skipped
in silence.

**A binding entry of an undefined `kind` is now checked like any other.** Its `tag`, `abi` and
`export` must be present and its `genericArity` an integer in range, matching the single
enforcement point in `validate-native-catalogs.ts`; only the ABI allowlist stays
`transferable`-specific. A `transferable` entry already failed these; one of any other kind was
skipped in silence, so a field typo'd alongside a kind typo generated nothing and said nothing.

Every native-catalog diagnostic, and the operation name in `AWSBLOCKS-NATIVE-001`, `-002` and the arity error, now escapes the spec-supplied values it names, so a newline in one cannot split it
across log lines or emit a line that reads as a second diagnostic. `forDiagnostic` moves beside
`CodegenException` and becomes `internal`, because the parser's errors need it too — including the
`x-blocks-native-packages.packages.<identity>` path, which carried the identity raw into six of
them.
