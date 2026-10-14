---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

A native package's Dart `name` and `library` are now validated against the
grammar the Dart generator interpolates them into, and a binding's `export`
against the one every generator upper-camel-cases, instead of both only being
checked for a non-blank string. A Dart `name` of `blocks_runtime` is rejected
because every generated client already imports that library. A value such as
`My-Package`, `lib/x.dart` or `device link` used to pass spec generation and then
break codegen in the customer's app, where the block that declared it is no
longer visible. Swift and Android fields are unaffected.

`@aws-blocks/blocks` gets the same bump because it re-exports `@aws-blocks/core/scripts`.
