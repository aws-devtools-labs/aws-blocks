---
'@aws-blocks/core': minor
'@aws-blocks/bb-agent': minor
'@aws-blocks/bb-cron-job': minor
'@aws-blocks/bb-realtime': minor
"@aws-blocks/blocks": patch
---

Scope shared Blocks synth state to the owning backend root (`BlocksStack`/`BlocksBackend`) instead of the enclosing `cdk.Stack`, so two `BlocksBackend`s in one stack — and multiple stacks in one synth — stay independent.

- **Registries** (config, compute, dashboard, tracer, VPC requirements) now key on the backend root, resolved by walking the construct tree (`getBlocksRoot`), not on `cdk.Stack.of(scope)`.
- **Shared-infra Building Blocks** now provision and dedup their per-backend resources under the backend root: the realtime WebSocket API, the cron scheduler role, and the agent AgentCore runtime grants. Previously a second backend in the same stack could attach to the first's shared infra — most seriously, the agent's Bedrock grants could land on the wrong backend's execution role.
- **RawRoute** registrations are tagged with their owning backend root; `Hosting` now adds CloudFront behaviors only for routes owned by the backend its distribution fronts, instead of every route in the process-global registry. The per-owner tag also scopes duplicate-route detection, so two backends may register the same method+path.
- **`Hosting` now registers its origin config against the backend it fronts.** `BLOCKS_PUBLIC_ORIGIN` and `CORS_HOSTING_ORIGINS` are written to the backend named by `props.api`, matching the route-behavior owner — not to `this`, which (when two backends share a stack) resolved via the ambient pointer to the last-created backend and left the fronted backend without its origin config.
- The config bucket is parented under the resolved backend root rather than read from an ambient process-global, removing a construction-order hazard.
- **Stack-scoped exceptions — these deliberately keep a stable logical ID.** The app-setting secret bulk-init (`BlocksSecretsBulk`) and the distributed-table GSI manager provider (`BlocksGsiProvider`) stay direct stack children. Both are referenced by existing resources through immutable fields (a SecureString's physical name; a custom resource's `ServiceToken`), so a logical-ID change would force a replacement that CloudFormation either rejects (`ServiceToken` is immutable → failed upgrade) or that silently deletes the SecureString. Keeping them stack-scoped preserves the logical ID; their deploy-time IAM is still scoped (lazily) to only the parameters/tables that register. (Joins the API Gateway account resource as a documented stack-scoped exception.)

**Compatibility.** Single-`BlocksStack` apps (the common case) are byte-identical — no resource replacement. Apps that embed a `BlocksBackend` inside a customer `cdk.Stack` and use **realtime** or **cron** will see those resources re-parent from the stack to the backend construct, which CloudFormation treats as a replacement on upgrade; neither carries persistent data. For realtime specifically, the WebSocket API URL changes and its stack output key changes from `RealtimeWsUrl` to `BlocksRealtimeWsUrl<hash>` — scripts that read that output by name must update. Secret AppSettings and GSI-backed tables are **not** affected (their shared resources stay stack-scoped).
