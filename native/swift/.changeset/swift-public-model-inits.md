---
"aws-blocks-swift": minor
---

Generated types now have a `public init`, so you can construct them from another module

The generated Swift client declared its types as `public struct`, but most of them had no `public` initializer. Swift's built-in memberwise initializer is `internal`, so code outside the module holding the generated client couldn't create one. If you kept the generated client in its own Swift package or module, you couldn't build a `CreateTodo.Input` to pass to an API method, or a model for a test or a SwiftUI preview. Only types with a spec default or a validation constraint had a public initializer.

Every generated struct now has a `public init`: your named types, the types nested inside them, the payloads of union cases, and the inline parameter and result types of each operation. Its parameters are the properties in the order they're declared, with the same labels as before, so existing calls compile unchanged. Optional and nullable properties now default to `nil`, so you can leave them out: `Note(id: "n1", title: "Hello")`. Encoding and decoding are unchanged.

A property named `self` keeps its label, `Holder(self: …)`, and is now assigned correctly. Before, the parameter hid the instance, so a struct with such a property didn't compile once it had an initializer.
