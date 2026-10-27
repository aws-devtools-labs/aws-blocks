---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): keep x-blocks-type-args when a method is typed from a resolved type

A method typed from a resolved `ts.Type` rather than the backend entry's AST lost its
`x-blocks-type-args`, because `detectTransferable` was called without the syntactic
return-type node that gates type-argument emission. An arity-1 transferable reached that
way failed spec generation with `found 0` type args.

The node is now read from the method's own declaration, covering an interface or class
method and a function-typed or handler-literal property. Entries are emitted only where
the customer wrote every type argument: a partial list would pass the arity check with
the wrong types in it.
