---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

fix(core): reject malformed native declarations instead of dropping them

An `aws-blocks` key that is present but not an object dropped every declaration
inside it; it is now `"aws-blocks" must be an object (declared by <block>)`. A
`null` key is an error rather than an absence, and an absent key still skips. An
unrecognized field on a binding with a usable `id` is rejected rather than
silently stripped, both generic-arity errors now name the binding and the
declaring block, and a registration, platform entry or package entry carrying a
non-enumerable field is rejected too.

Behavior change (0.x minor = breaking channel): generation now exits 1 where it
wrote a spec before, for a `null` or non-object `aws-blocks` key and for an
unrecognized binding field. Remove the offending key or field.
