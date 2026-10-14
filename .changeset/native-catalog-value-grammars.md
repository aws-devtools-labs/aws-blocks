---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

A native package's Dart `name` and `library` and a binding's `export` are now
validated against the grammar each generator interpolates them into, instead of
only being checked for a non-blank string. A value such as `My-Package`,
`lib/x.dart` or `device link` used to pass spec generation and then break
codegen in the customer's app, where the block that declared it is no longer
visible. Swift and Android fields are unaffected.

`@aws-blocks/blocks` gets the same bump because it re-exports `@aws-blocks/core/scripts`.
