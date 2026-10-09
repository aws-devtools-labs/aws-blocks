---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

feat(core): refuse to synth when a renamed or removed Building Block would take a stateful resource with it

Some Building Blocks commit a baseline file per instance under
`aws-blocks/baselines/<stack>/` to refuse destructive changes at synth. When
such a block was renamed or removed, nothing read its baseline any more, so
CloudFormation could delete the resource it guarded with no warning.

Every `BlocksStack` and `BlocksBackend` now checks its own baseline directory
at synth, even when no instance of the block is left: a baseline that records a
stateful resource and that no block in the stack claims fails synth, naming the
block and what CloudFormation would delete. Restore the block's old id, or
re-baseline deliberately with the block's re-baseline variable set to that
block's id (which deletes the stale file). Apps without baseline files are
unaffected.
