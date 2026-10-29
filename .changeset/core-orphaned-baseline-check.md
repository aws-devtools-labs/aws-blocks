---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
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

This is a minor release because it defines a new file format that apps commit to
their repositories. Each baseline file carries a top-level `version` (currently
`1`; a file without one is read as `1`), and every later release keeps reading
every earlier version. A baseline with a higher version than this release knows
fails synth with a message to upgrade `@aws-blocks/core`; one whose `version` is
not a whole number from 1 fails synth as invalid. Neither is ever rewritten or
deleted. Commit these files with your
app; they are written and updated by the Building Block that owns them.
