---
"@aws-blocks/core": patch
---

Spec generation now bounds a binding's `export` at 64 characters, rejecting a longer one by path and naming the block that declared it, instead of interpolating it into generated source and diagnostics in the customer's app, where that block is no longer visible. The Kotlin parser rejects the same length when it reads the catalogs, so an export spec generation accepts is one Kotlin codegen will not reject later.

Only the `export` field gained this bound; a package's other fields are unaffected, and an export of 64 characters or fewer that already passed still passes.
