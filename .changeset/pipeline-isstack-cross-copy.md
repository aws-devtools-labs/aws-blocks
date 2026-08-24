---
"@aws-blocks/pipeline": patch
---

Fix `Pipeline.create()` failing with "stage '<name>' contains no stacks" when the
consumer app resolves a different `aws-cdk-lib` copy than `@aws-blocks/pipeline`
(monorepo, linked-package, or `file:` installs — e.g. an Amplify self-hosting app).

`validateStageStacks` detected a stage's stacks with `instanceof cdk.Stack`, which
returns `false` across module copies — so a `stageFactory` that *did* create a
`Stack` was misdetected as empty and synth aborted. It now uses
`cdk.Stack.isStack()`, which matches on a shared `Symbol.for` marker and is
cross-copy-safe.
