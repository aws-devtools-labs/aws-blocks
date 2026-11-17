---
"aws-blocks-kotlin": minor
---

Accept `.` in a binding export, and refuse two bindings that claim one type

A binding export may now join segments with `.` as well as `-` and `_`, the set spec generation
and Dart already accepted; an export failing the grammar is rejected by name, one over 64
characters by its length alone. Two bindings that resolve to one Kotlin type in one
`kotlinPackage` are now a `CodegenException` naming the export that claimed the type first,
unless both claim it with the same export, declaring package and `genericArity` — a second
arity for one export, or a second declaring package, now collides. Kotlin carried no type-name
claim guard before this change, so a spec this rule now rejects generated without error
previously — but only where the colliding exports were already grammar-valid; one that collides
on a `.` segment the old grammar refused was already rejected, by that grammar.
