---
"@aws-blocks/core": minor
"@aws-blocks/bb-kv-store": patch
---

Add stack-wide infrastructure `defaults` chosen once at the app entry point, replacing the per-block `sandboxMode` logic and the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin dance for removal-policy and deletion-protection.

`@aws-blocks/core/cdk` now exports `BlocksDefaults`, the `BlocksPresets.sandbox` / `BlocksPresets.production` starting points, and `registerStackBlocksDefaults`/`getStackBlocksDefaults`. `BlocksStack.create` / `BlocksBackend.create` take a required `defaults` prop; start from a preset and override individual fields with a spread. Building Blocks read the resolved values via `scope.defaults`, and a per-block option always wins (`option ?? scope.defaults.field`). bb-kv-store is the first adopter: its DynamoDB table now takes its removal policy and deletion protection from `defaults`.

**Breaking:** `BlocksStack.create` / `BlocksBackend.create` now require a `defaults` field — pass `BlocksPresets.sandbox` or `BlocksPresets.production` (typically `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`). The previously-shipped experimental `hardening` prop and its `resolve*` helpers are removed; log-retention, API throttling, access-logging and point-in-time-recovery move into `defaults` in follow-up, per-feature changes.
