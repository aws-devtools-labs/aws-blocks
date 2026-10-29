---
"aws-blocks-kotlin": patch
---

Accept `.` in a binding export, and refuse two exports that claim one type

The `x-blocks-native-bindings` export grammar now accepts `.` alongside `-` and `_`, the set
Dart already accepted; an export failing it, or over 64 characters, is rejected by name. Two
bindings whose differing exports resolve to one Kotlin type in one package are now a
`CodegenException` naming the export that claimed the type first; two tags declaring one
export still generate.
