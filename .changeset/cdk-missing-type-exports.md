---
"@aws-blocks/blocks": patch
---

fix: export types missing from the `cdk` entry point

Some types exported by the default entry point of `@aws-blocks/blocks` were missing from its `cdk` entry, so backend
code importing them failed to type-check under that condition — for example,
`import type { SubscribeOptions } from '@aws-blocks/blocks'`.

The `cdk` entry now exports `AuthActionInput`, `AgentTool`, `DefaultToolContext`, `ToolFactory`, `ToolHandlerArgs`,
`ToolsConfig`, the `AuthCognito` admin types (`AdminAction`, `AdminActionGate`, `AdminCreateInit`, `AdminDisabled`,
`AdminGetterOf`, `AdminGrants`, `AdminOptions`, `AdminSurface`, `AdminUser`, `AdminUserFilter`, `CodeDeliveryFn`,
`GroupAdmin`, `LifecycleAdmin`, `SetPasswordOptions`), `DisconnectReason`, `RealtimeChannel`, `RealtimeSubscription`,
`SubscribeOptions`.
