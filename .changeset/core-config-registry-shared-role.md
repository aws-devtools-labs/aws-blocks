---
"@aws-blocks/core": patch
---

refactor(core): retarget the config registry to the shared role and every compute

`finalizeConfigRegistry` no longer takes a single handler function. It now takes
the owning construct plus the shared execution role and the stack's computes
(`finalizeConfigRegistry(root, executionRole, computes)`) and:

- grants `s3:GetObject` on the config object **once to the shared execution
  role** instead of to one function's role, so every compute that assumes the
  role can read it; and
- stamps `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY` on **every compute** via
  `compute.setEnv(...)` rather than on a single hardcoded handler.

Adds a per-stack compute registry (`registerCompute` / `getComputes`): computes
self-register on their owning stack in the `Compute` base constructor (state
keyed on the stack, resolved via `cdk.Stack.of()`, like the config registry), so
a multi-stack synth keeps each stack's computes isolated. `BlocksStack.computes`
/ `BlocksBackend.computes` read from it.

Behavior-preserving for the default single-compute app: the same config object
is written to S3, the same two coordinates reach the runtime, and the same
`s3:GetObject` permission is available — now via the shared role. Internal
refactor; no public API or runtime-config-loading change.
