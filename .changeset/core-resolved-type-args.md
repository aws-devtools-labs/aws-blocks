---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): keep x-blocks-type-args when a method is typed from a resolved type

A method typed from a resolved `ts.Type` rather than the backend entry's AST lost its
`x-blocks-type-args`, because `detectTransferable` was called without the syntactic
return-type node that gates type-argument emission. An arity-1 transferable reached that
way failed spec generation with `found 0` type args.

The node is now read from the method's own declaration: an interface method, a class
method, a function-typed property on either, and a handler-literal property typed through
the `AsyncAPI<T>` mapped type. A return type with no written annotation still emits
nothing, which is correct.

Entries come from the resolved type arguments rather than the written ones, so a
transferable with a defaulted trailing type parameter emits one entry per resolved
argument. On these paths nothing was emitted before, making that over-emission newly
reachable; it is rejected at build time where the tag carries a declared binding, but a
built-in tag cannot be bound by a block and so gets no arity check. A return type that
reaches the transferable through a type alias still drops its type arguments.
