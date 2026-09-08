# @aws-blocks/bb-lambda-compute

## 0.3.0

### Minor Changes

- f00adb0: `LambdaCompute`: default the function to **arm64 (AWS Graviton)**.
  
  The compute's Lambda now defaults to `Architecture.ARM_64` instead of CDK's `x86_64` default. arm64 Lambda is ~20% cheaper per GB-second than x86_64 at equivalent performance. Because `LambdaCompute` is the default compute for every `@aws-blocks/blocks` app, the shared handler runs on Graviton out of the box.
  
  The framework's own Building Blocks are pure-JavaScript esbuild bundles with no architecture-specific native code, so the switch is transparent for them. A backend `entry` bundle is the customer's own handler plus whatever they import, though — so an app that bundles an **x86-only native dependency** into its backend should be aware of the default. There is no per-app override yet; a customer-facing way to pin the architecture (`architecture` on `LambdaComputeProps` is present but internal for now) will be exposed alongside the public compute-configuration surface.
  
  > **Behavior change on next deploy:** the handler function's architecture is `arm64` (an in-place update on an existing function).

### Patch Changes

- f00adb0: feat(core): resolve `Scope.compute`; the default compute owns the handler + gateway
  
  Add a `Scope.compute` getter that resolves the compute a block runs on: the
  nearest `_compute` assigned on the block or an ancestor scope, else the owning
  stack/backend's default compute.
  
  The default is a `LambdaCompute` that now **owns** the Lambda function + API
  Gateway. `setupBlocksInfra` no longer creates them; `BlocksStack` /
  `BlocksBackend` expose `handler` / `gateway` / `apiUrl` as getters that delegate
  to the default compute. The compute is created in `create()` before the backend
  module is imported, so a block reading `this.compute` in its constructor
  resolves to it. `_compute` is internal (no public option yet).
  
  Core no longer imports a concrete compute: `create()` requires a
  `defaultComputeFactory` on its props (`CoreBlocksStackProps` /
  `CoreBlocksBackendProps` — the public `BlocksStackProps` / `BlocksBackendProps`
  plus that factory) and calls it to build the default. The umbrella
  `@aws-blocks/blocks` supplies `LambdaCompute` by spreading the factory onto the
  props in a thin `create()` wrapper, so apps built on `@aws-blocks/blocks` are
  unaffected — their call site is unchanged.
  
  **Breaking (direct `@aws-blocks/core` consumers only):** core no longer provides
  a built-in default compute. `BlocksStack.create()` / `BlocksBackend.create()`
  now require a `defaultComputeFactory` field on the props (typed
  `CoreBlocksStackProps` / `CoreBlocksBackendProps`); props without it no longer
  type-check (and it throws at synth if forced). This break is inherent to moving
  the Lambda + API Gateway out of core — it is not specific to how the factory is
  passed. Migrate by either:
  
  - using `@aws-blocks/blocks` (`import { BlocksStack } from '@aws-blocks/blocks/cdk'`),
    which injects a Lambda default for you — the recommended path; or
  - supplying your own factory on the props:
    `BlocksStack.create(scope, id, { ...props, defaultComputeFactory: (root) => new LambdaCompute(root, 'DefaultCompute') })`,
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
- f00adb0: feat(core): add `allowedOrigins` to `BlocksDefaults`
  
  `BlocksDefaults` gains an `allowedOrigins` field — CORS origin patterns (matched
  against the request `Origin` header) the compute's API accepts. `LambdaCompute`
  now reads `this.defaults.allowedOrigins` to populate `CORS_ALLOWED_ORIGINS`
  (comma-joined, as the runtime parses it) instead of reading the `sandboxMode`
  CDK context. The `sandbox` preset allows localhost (so a local dev frontend can
  reach a deployed API); `production` allows none.
  
  **Breaking (direct `BlocksDefaults` literal authors only):** `allowedOrigins` is
  required. Building the object from `BlocksPresets.sandbox` / `BlocksPresets.production`
  (or a spread of one) is unaffected — the presets supply it. Only a hand-written
  `BlocksDefaults` literal must add the field.
- Updated dependencies [5798492]
- Updated dependencies [f00adb0]
- Updated dependencies [f00adb0]
- Updated dependencies [08ab129]
- Updated dependencies [9d4ccea]
- Updated dependencies [5bfae0a]
- Updated dependencies [0ac3879]
- Updated dependencies [e4dac4a]
  - @aws-blocks/core@0.3.0

## 0.2.1

### Patch Changes

- 448a47c: fix(bb-lambda-compute): add package metadata, prebuild, and pin dependency ranges
  
  Bring `@aws-blocks/bb-lambda-compute`'s package.json in line with its siblings:
  
  - add the `repository` / `homepage` / `bugs` blocks. Without `repository.url`,
    provenance publishing fails with `E422 … "repository.url" is ""` because npm
    cannot match the package against the sigstore attestation's source repo;
  - add the `prebuild` version-generation script (`generate-version.mjs`);
  - pin `@aws-blocks/core` to `^0.2.0` instead of `*`, matching every other
    package.
  
  Also pin the umbrella `@aws-blocks/blocks`'s dependency on
  `@aws-blocks/bb-lambda-compute` to `^0.2.0` instead of `*`, now that the package
  publishes a real version.

## 0.2.0

### Minor Changes

- 5262062: feat: extract `LambdaCompute` into `@aws-blocks/bb-lambda-compute`
  
  The abstract `Compute` base stays in core as a framework primitive; the concrete
  `LambdaCompute` (a `NodejsFunction` fronted by its own API Gateway, assuming the
  shared execution role) moves into a new package, `@aws-blocks/bb-lambda-compute`.
  
  The package is CDK-only and its sole export is internal — customers cannot
  instantiate a compute yet. Nothing in the default path constructs it, so this is
  additive and non-breaking.

### Patch Changes

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
