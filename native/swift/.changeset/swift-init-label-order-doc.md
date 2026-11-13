---
"aws-blocks-swift": patch
---

Document that initializer labels are sorted by name

The README said a generated struct's `public init` takes its properties in declaration order. It takes them sorted by name (`SignIn(password:username:)`), as every release has, and keeps doing so so that existing code compiles. Dart and Kotlin keep declaration order.
