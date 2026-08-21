# @aws-blocks/pipeline

## 0.1.2

### Patch Changes

- 947a1bd: Fix `Pipeline.create()` failing with "stage '<name>' contains no stacks" when the
  consumer app resolves a different `aws-cdk-lib` copy than `@aws-blocks/pipeline`
  (monorepo, linked-package, or `file:` installs — e.g. an Amplify self-hosting app).
  
  `validateStageStacks` detected a stage's stacks with `instanceof cdk.Stack`, which
  returns `false` across module copies — so a `stageFactory` that *did* create a
  `Stack` was misdetected as empty and synth aborted. It now uses
  `cdk.Stack.isStack()`, which matches on a shared `Symbol.for` marker and is
  cross-copy-safe.

## 0.1.1

### Patch Changes

- e98bab4: feat(pipeline): extract Pipeline construct into @aws-blocks/pipeline package, add partialBuildSpec for CodeBuild runtime control

  `@aws-blocks/core` receives a minor bump (not patch): it gains a new runtime dependency on `@aws-blocks/pipeline` and adds new public re-exports from its CDK entrypoint (`__PIPELINE_STAGE_SCOPE__`, `Pipeline`, `DeployStage`, and the pipeline configuration types). New backwards-compatible public surface is a minor change per semver.
