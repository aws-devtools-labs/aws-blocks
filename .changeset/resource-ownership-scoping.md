---
'@aws-blocks/core': minor
'@aws-blocks/bb-agent': minor
'@aws-blocks/bb-app-setting': minor
'@aws-blocks/bb-auth-oidc': minor
'@aws-blocks/bb-cron-job': minor
'@aws-blocks/bb-distributed-table': minor
'@aws-blocks/bb-realtime': minor
"@aws-blocks/blocks": patch
---

Scope all shared Blocks synth state to the owning backend root (`BlocksStack`/`BlocksBackend`) instead of the enclosing `cdk.Stack`, so two `BlocksBackend`s in one stack — and multiple stacks in one synth — stay fully independent.

- **Registries** (config, compute, dashboard, tracer, VPC requirements) now key on the backend root, resolved by walking the construct tree (`getBlocksRoot`), not on `cdk.Stack.of(scope)`.
- **Shared-infra Building Blocks** now provision and dedup their per-backend resources under the backend root: the realtime WebSocket API, the cron scheduler role, the distributed-table GSI provider, the app-setting secret bulk-init, and the agent AgentCore runtime grants. Previously a second backend in the same stack could attach to the first's shared infra — most seriously, the agent's Bedrock grants could land on the wrong backend's execution role.
- **RawRoute** registrations are tagged with their owning backend root; `Hosting` now adds CloudFront behaviors only for routes owned by the backend its distribution fronts, instead of every route in the process-global registry. The per-owner tag also scopes duplicate-route detection, so two backends may register the same method+path.
- The config bucket is parented under the resolved backend root rather than read from an ambient process-global, removing a construction-order hazard.
- `bb-auth-oidc` now locates the shared bb-app-setting secret bulk-init resource via `getBlocksRoot(this)` instead of `cdk.Stack.of(this)`, matching where that resource is now parented. Without this, an embedded `BlocksBackend` using OIDC auth with a `secret: true` `AppSetting` would silently drop the dependency edge that guarantees the SecureString is written before OIDC IdP registration reads it.

**Single-`BlocksStack` apps (the common case) are byte-identical — no resource replacement.** Apps that embed a `BlocksBackend` inside a customer `cdk.Stack` and use any of the shared-infra Building Blocks above will see those specific resources re-parent from the stack to the backend construct, which CloudFormation treats as a replacement on upgrade.
