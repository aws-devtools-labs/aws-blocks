---
"@aws-blocks/core": minor
"@aws-blocks/bb-lambda-compute": patch
"@aws-blocks/blocks": patch
---

feat(core): resolve `Scope.compute`; the default compute owns the handler + gateway

Add a `Scope.compute` getter that resolves the compute a block runs on: the
nearest `_compute` assigned on the block or an ancestor scope, else the owning
stack/backend's default compute.

The default is a `LambdaCompute` that now **owns** the Lambda function + API
Gateway. `setupBlocksInfra` no longer creates them; `BlocksStack` /
`BlocksBackend` expose `handler` / `gateway` / `apiUrl` as getters that delegate
to the default compute. The compute is created in `create()` before the backend
module is imported, so a block reading `this.compute` in its constructor
resolves to it. `_compute` is internal (no public option yet).

Core no longer imports a concrete compute: `create()` takes a
`defaultComputeFactory` as a required argument and calls it to build the
default. The umbrella `@aws-blocks/blocks` supplies `LambdaCompute` through a
thin `create()` wrapper, so apps built on `@aws-blocks/blocks` are unaffected —
their call site is unchanged.

**Breaking (direct `@aws-blocks/core` consumers only):** core no longer provides
a built-in default compute. `BlocksStack.create()` / `BlocksBackend.create()`
now require a fourth `defaultComputeFactory` argument; a bare three-argument call
no longer type-checks (and throws at synth if forced). This break is inherent to
moving the Lambda + API Gateway out of core — it is not specific to how the
factory is passed. Migrate by either:

- using `@aws-blocks/blocks` (`import { BlocksStack } from '@aws-blocks/blocks/cdk'`),
  which injects a Lambda default for you — the recommended path; or
- supplying your own factory:
  `BlocksStack.create(scope, id, props, (root) => new LambdaCompute(root, 'DefaultCompute'))`,
  which requires depending on `@aws-blocks/bb-lambda-compute` and the internal
  `@aws-blocks/core/cdk/internal` types.

**Resource replacement on redeploy:** because the Lambda function and API
Gateway now live under the default compute's construct path
(`.../DefaultCompute/...`), their CloudFormation logical IDs change, so a
redeploy **replaces** the function + API Gateway and the API URL changes. These
are internal resources, not a customer-facing contract. Any consumer with an
already-deployed stack — in particular an Amplify Gen2 frontend wired to the
current API Gateway URL (this repo carries a Gen2 nested-stack regression test,
so Gen2 integration is real) — should confirm they can absorb a URL change
before upgrading.
