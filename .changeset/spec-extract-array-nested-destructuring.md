---
"@aws-blocks/core": patch
---

fix(core): spec extraction attributes array/tuple & nested-destructured factory namespaces

`extractMethodTypes` (the generate-spec type extractor) attributed a
factory-returned `ApiNamespace` to its namespace only for a top-level identifier
or a shallow object binding pattern. Array/tuple patterns (`const [ns] = factory()`)
and nested destructuring (`const { a: { b } } = factory()`) fell through to the
bare method key — fail-soft via the #498 fallback when there was no collision, but
a factory returning a tuple of namespaces that share a method name (e.g.
`const [a, b] = factory()` where both expose `create`) could hit the #445
cross-assignment class again.

The second-pass indirect resolver now walks binding patterns recursively (object,
array/tuple, and any nesting), attributing every leaf identifier to the namespace
it binds via the checker's resolved type — so those shapes key qualified
(`ns.method`) like a directly-constructed namespace. Follow-up to #522 (#552).
