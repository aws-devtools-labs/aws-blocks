---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): follow a factory-returned, destructured `ApiNamespace` when extracting spec schemas (#444)

`blocks-generate-spec` lost the TypeScript parameter/result schemas for an
`ApiNamespace` that was constructed inside a factory, returned as a property,
destructured, and then exported (e.g. `const { api } = new Factory().build()`).
The extractor's indirect pass only handled a simple identifier binding
(`const api = …`), so a destructured binding fell through and the method's
schema was attributed to a bare, unqualified key — which, under a method-name
collision with another namespace, cross-assigned or degraded to
`{ "type": "unknown" }` (the same class of bug as #445, via the factory path).

The indirect pass now also handles **object binding patterns**: for each
destructured binding it resolves the property's type off the initializer and
extracts the methods keyed by the local (exported) namespace name — so a
factory-returned namespace keys qualified (`api.method`) exactly like a
directly-constructed one, and same-named methods across namespaces no longer
collide. Renamed bindings (`const { foo: bar } = …`) read the correct property.
