---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

`blocks-generate-spec`: stop cross-assigning schemas between namespaces that share a method name.

The TypeScript type extractor keyed method schemas by the bare method name, so when two `ApiNamespace`s each exposed an operation with the same name (e.g. `widgets.create` and `subscriptions.create`), one namespace's parameter/result schemas silently overwrote the other's in the generated OpenRPC document — producing incorrect client types. Method schemas are now keyed by the namespace-qualified name (`namespace.method`), matching how the spec routes operations; the consumer falls back to the bare name for methods the extractor couldn't attribute to a namespace, so no previously-working case regresses.
