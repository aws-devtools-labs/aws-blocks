---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): reject malformed native declarations instead of dropping them

An `aws-blocks` key that is present but not an object had every declaration inside it dropped
without a word; it is now `"aws-blocks" must be an object (declared by <block>)`. A key written as
`null` is an error rather than an absence; an absent key still skips. An unrecognized field on a
binding whose `id` is usable is rejected instead of being silently stripped by the catalog, and both generic-arity
errors now name the binding and the declaring block.
