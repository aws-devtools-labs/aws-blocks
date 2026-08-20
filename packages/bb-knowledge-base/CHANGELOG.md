# @aws-blocks/bb-knowledge-base

## 0.2.1

### Patch Changes

- 7b4c62d: Add infrastructure `defaults` chosen once at the app entry point, replacing the per-block `sandboxMode` logic and the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin dance for removal-policy and deletion-protection.
  
  `@aws-blocks/core/cdk` now exports `BlocksDefaults` and the `BlocksPresets.sandbox` / `BlocksPresets.production` starting points. `BlocksStack.create` / `BlocksBackend.create` take a required `defaults` prop; start from a preset and override individual fields with a spread. `defaults` is anchored on the owning `BlocksStack`/`BlocksBackend` (resolved by walking up the construct tree, like `handler`/`executionRole`), so multiple backends in one stack each keep their own posture. Building Blocks read the resolved values via `scope.defaults`, and a per-block option always wins (`option ?? scope.defaults.field`).
  
  Adopted across the stateful Building Blocks: `bb-kv-store`, `bb-data`, `bb-distributed-data`, `bb-distributed-table`, and `bb-knowledge-base` now take their removal policy and deletion protection from `defaults` instead of reading the `sandboxMode` context themselves. (`bb-distributed-table` reads `defaults` directly for now; a richer per-block `protection` override lands with #282.)
  
  The `create-blocks-app` scaffolding templates are updated to pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production` (replacing the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin), so newly-generated apps satisfy the required prop.
  
  **Breaking:** `BlocksStack.create` / `BlocksBackend.create` now require a `defaults` field — pass `BlocksPresets.sandbox` or `BlocksPresets.production` (typically `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`). The previously-shipped experimental `hardening` prop and its `resolve*` helpers are removed; log-retention, API throttling, access-logging and point-in-time-recovery move into `defaults` in follow-up, per-feature changes.
- edbf1aa: fix(bb-knowledge-base): disable `installLatestAwsSdk` on the ingestion custom resource
  
  The `StartIngestion` `AwsCustomResource` left `installLatestAwsSdk` at its default
  (`true`), so the provider Lambda ran an `npm install` of the AWS SDK on every
  invocation before it could call the API. That costs roughly 15-30s of extra cold
  start and raises the shared provider Lambda to 512MB of memory, though that
  reduction is only realized once every `AwsCustomResource` in the stack opts out —
  the provider is a stack-level singleton and its `memorySize` is resolved once at
  synth. The per-resource cold-start saving applies regardless.
  
  Nothing needed it. The resource calls `BedrockAgent.startIngestionJob`, a stable
  API already bundled in the Lambda runtime's AWS SDK v3, so the bundled client is
  sufficient and the install is pure overhead. Setting `installLatestAwsSdk: false`
  also silences CDK's `installLatestAwsSdkNotSpecified` synth-time warning for this
  construct.
  
  The tradeoff being accepted: the provider now uses whichever SDK v3 the Lambda
  runtime bundles at deploy time rather than installing the newest one. That is safe
  here because `startIngestionJob` is a foundational Bedrock Agent operation present
  since the client's initial release, not a recent addition.
  
  Internal construct wiring only — no public API change. The synthesized
  `Custom::AWS` resource now renders `InstallLatestAwsSdk: false`.
  
  Upgrade note: because `InstallLatestAwsSdk` renders as a property on the
  `Custom::AWS` resource while the `physicalResourceId` stays stable, the first
  deploy after upgrading is a CloudFormation *Update* and fires `onUpdate` — so one
  `startIngestionJob` kicks off. This is harmless (ingestion is idempotent and
  fire-and-forget), but expect to see an ingestion start right after upgrading.
- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-logger@0.1.4

## 0.2.0

### Minor Changes

- b6fb281: Add `isSynced()` / `waitUntilSynced()` ingestion-sync API to KnowledgeBase.

  Bedrock ingestion runs asynchronously after deploy, so during the initial pre-sync window `retrieve()` returns an empty array even for queries that would later match — making "empty" ambiguous between "not yet synced with your latest data" and "synced, no match". The new methods resolve that ambiguity (mirroring Bedrock's own "Sync" / "sync with your latest data" terminology):

  - `isSynced(): Promise<boolean>` — `true` once the data source's most recent ingestion job is `COMPLETE`; `false` while it is not yet synced with your latest data. This reports data _freshness_, not availability — `retrieve()` is always callable and serves the prior synced snapshot during a re-ingestion. Both local-folder and imported `s3://` sources register a BB-managed data source, so both are tracked (the "no managed data source → synced" shortcut applies only to deployments predating this API, which have no data source id injected). Throws a typed `IngestionFailedException` (including `failureReasons`) if the latest job failed.
  - `waitUntilSynced(options?: { timeoutMs?: number; pollIntervalMs?: number; maxConsecutiveTransientErrors?: number; signal?: AbortSignal }): Promise<void>` — polls until synced (defaults: `timeoutMs` 300000, `pollIntervalMs` 5000, `maxConsecutiveTransientErrors` 3), throwing a typed `KnowledgeBaseTimeoutException` on timeout or propagating `IngestionFailedException` on a failed job. Up to `maxConsecutiveTransientErrors` _consecutive_ transient control-plane errors are tolerated (the counter resets on a clean poll); terminal errors short-circuit immediately. Transient covers both throttling / transient network failures **and** a _not-yet-visible_ knowledge base — during the post-deploy window the control plane can briefly return `ResourceNotFoundException` (the freshly-created KB/data source hasn't propagated yet), which is ridden out rather than treated as terminal; a _missing-KB config_ error (`KB_ID` unset) stays terminal. The poll interval carries ±20% jitter (only the delay between polls varies, never the poll count or the deadline) so many KBs don't poll in lockstep. Pass an optional `signal` (`AbortSignal`) to cancel the wait — checked before each poll and during the inter-poll delay — which rejects with the signal's abort reason (default: a `DOMException` named `'AbortError'`).

  Purely additive — `retrieve()` and all existing signatures are unchanged. The local mock reports synced immediately (no async ingestion window in local dev).

  The umbrella `@aws-blocks/blocks` package now also re-exports the new `WaitUntilSyncedOptions` type (alongside the existing `KnowledgeBase` re-exports) from both its runtime and CDK entry points, so consumers importing from `@aws-blocks/blocks` can reference it directly.

### Patch Changes

- b6fb281: fix(bb-knowledge-base): apply the data bucket's removal policy to the S3 Vectors resources on teardown

  On a `removalPolicy: 'destroy'` (or sandbox) teardown, the data `s3.Bucket` was force-deleted and auto-emptied, but the S3 Vectors store — the `CfnVectorBucket` + `CfnIndex` L1 resources — relied solely on its default CloudFormation `DeletionPolicy` and leaked. Those resources now mirror the data bucket: `DeletionPolicy: Delete` (via `applyRemovalPolicy(RemovalPolicy.DESTROY)`) when `destroy` is requested, and `RemovalPolicy.RETAIN` otherwise, so the vector bucket and index are dropped alongside the data bucket on a clean teardown.

  Purely additive — no exported types, signatures, or error constants changed.

## 0.1.3

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- f24d3c3: fix(bb-knowledge-base): path guard bypass, cache staleness, filter truncation, error classification, load recovery, unicode tokenization, and chunking config

  **Behavioral note — error classification.** Bedrock `ValidationException`s that are not filter-related are now surfaced as `KnowledgeBaseValidationError` instead of `InvalidFilterException`. Filter-related validation errors (e.g. an unknown metadata filter key) continue to map to `InvalidFilterException`. Consumers that catch `InvalidFilterException` to handle generic query-validation failures should audit their catch blocks and add handling for `KnowledgeBaseValidationError` where appropriate. No exported types, signatures, or error constants changed.

- Updated dependencies [ba3bf7b]
  - @aws-blocks/bb-logger@0.1.2

## 0.1.2

### Patch Changes

- 18880ff: Minor test improvements
- Updated dependencies [18880ff]
  - @aws-blocks/core@0.1.2

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
