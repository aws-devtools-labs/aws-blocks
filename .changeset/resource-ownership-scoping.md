---
'@aws-blocks/core': minor
'@aws-blocks/bb-agent': minor
'@aws-blocks/bb-cron-job': minor
'@aws-blocks/bb-distributed-table': minor
'@aws-blocks/bb-realtime': minor
"@aws-blocks/blocks": patch
---

Scope shared Blocks synth state to the owning backend root (`BlocksStack`/`BlocksBackend`) instead of the enclosing `cdk.Stack`, so two `BlocksBackend`s in one stack — and multiple stacks in one synth — stay independent.

- **Registries** (config, compute, dashboard, tracer, VPC requirements) now key on the backend root, resolved by walking the construct tree (`getBlocksRoot`), not on `cdk.Stack.of(scope)`.
- **Shared-infra Building Blocks** now provision and dedup their per-backend resources under the backend root: the realtime WebSocket API, the cron scheduler role, the distributed-table GSI provider, and the agent AgentCore runtime grants. Previously a second backend in the same stack could attach to the first's shared infra — most seriously, the agent's Bedrock grants could land on the wrong backend's execution role.
- **RawRoute** registrations are tagged with their owning backend root; `Hosting` now adds CloudFront behaviors only for routes owned by the backend its distribution fronts, instead of every route in the process-global registry. The per-owner tag also scopes duplicate-route detection, so two backends may register the same method+path.
- The config bucket is parented under the resolved backend root rather than read from an ambient process-global, removing a construction-order hazard.
- **The app-setting secret bulk-init (`BlocksSecretsBulk`) deliberately stays stack-scoped.** Its logical ID must remain stable: it manages SecureString SSM parameters whose values live outside CloudFormation, so a logical-ID change would force a create-then-delete replacement that silently deletes those secrets on upgrade. Keeping it a direct stack child preserves the existing logical ID, and its deploy-time IAM is scoped (lazily) to only the parameters that register with it. (Documented stack-scoped exception, alongside the API Gateway account resource.)

**Compatibility.** Single-`BlocksStack` apps (the common case) are byte-identical — no resource replacement. Apps that embed a `BlocksBackend` inside a customer `cdk.Stack` and use realtime, cron, or distributed-table GSIs will see those specific resources re-parent from the stack to the backend construct, which CloudFormation treats as a replacement on upgrade; none of them carry persistent data (the realtime WebSocket URL changes, the connections table is unaffected). Secret AppSettings are **not** affected, because the bulk-init resource stays stack-scoped.
