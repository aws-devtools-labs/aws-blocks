---
"@aws-blocks/bb-agent": patch
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/blocks": patch
---

fix: export types missing from the `cdk` and `aws-runtime` entry points

Some types exported by a Building Block's default entry point were missing from its `cdk` (and, for `bb-auth-oidc`,
`aws-runtime`) entry, so backend code importing them failed to type-check under that condition — for example,
`import type { TransactionOptions } from '@aws-blocks/bb-distributed-data'`. The entries now also export:

- `@aws-blocks/bb-agent` (`cdk`): `AgentTurnPayload`, `AgentConfig`, `AgentResult`, `AgentStreamChunk`,
  `AgentStreamResult`, `ToolDefinition`, `AgentTool`, `ToolFactory`, `ToolsConfig`, `ToolHandlerArgs`,
  `DefaultToolContext`, `InterruptResponse`, `ToolCallRecord`, `ModelConfig`, `StreamOptions`, `Message`,
  `Conversation`, `JSONValue`, `TokenUsage`
- `@aws-blocks/bb-auth-oidc` (`cdk`, `aws-runtime`): `OIDCClient`
- `@aws-blocks/bb-data` (`cdk`): `PgClientEngineConfig`, `RLSContext`, `SubnetSelection`, `TableSchema`,
  `TableMetaEntry`, `CrudOptions`, `CrudMethods`, `QueryOpts`, `TableTypeMeta`, `CrudAuthResult`
- `@aws-blocks/bb-distributed-data` (`cdk`): `TransactionOptions`
- `@aws-blocks/bb-distributed-table` (`cdk`): `PartitionKeyCondition`, `SortKeyCondition`, `KeyCondition`
- `@aws-blocks/bb-file-bucket` (`cdk`): `FileDownloadClient`, `FileUploadClient`, `FileVersionInfo`,
  `FileDownloadDescriptor`, `FileUploadDescriptor`, `VersionedGetOptions`, `VersionedDeleteOptions`,
  `VersionedGetUrlOptions`, `GetOptionsFor`, `DeleteOptionsFor`, `GetUrlOptionsFor`
- `@aws-blocks/bb-kv-store` (`cdk`): `ScanOptions`
- `@aws-blocks/bb-realtime` (`cdk`): `RealtimeChannelDescriptor`, `SubscribeOptions`, `DisconnectReason`
- `@aws-blocks/blocks` (`cdk`): `AuthActionInput`, `AgentTool`, `DefaultToolContext`, `ToolFactory`,
  `ToolHandlerArgs`, `ToolsConfig`, the `AuthCognito` admin types (`AdminAction`, `AdminActionGate`,
  `AdminCreateInit`, `AdminDisabled`, `AdminGetterOf`, `AdminGrants`, `AdminOptions`, `AdminSurface`, `AdminUser`,
  `AdminUserFilter`, `CodeDeliveryFn`, `GroupAdmin`, `LifecycleAdmin`, `SetPasswordOptions`), `DisconnectReason`,
  `RealtimeChannel`, `RealtimeSubscription`, `SubscribeOptions`

`@aws-blocks/blocks`: the conditional-export parity test now also compares type-only exports across the default,
`aws-runtime`, and `cdk` entry points, so a missing type fails CI.
