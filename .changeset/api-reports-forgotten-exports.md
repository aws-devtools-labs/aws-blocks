---
'@aws-cdk-blocks/bb-agent': patch
'@aws-cdk-blocks/bb-realtime': patch
'@aws-cdk-blocks/core': patch
---

Export types that public signatures already use

- **Exported types (type-only, additive).** `@aws-cdk-blocks/bb-agent` now exports `AgentBase` (the base class of `Agent`, as a type), `ConversationManagerConfig`, `MessageMetadata`, `GuardrailsConfig` and `InferenceConfig`; `@aws-cdk-blocks/bb-data` exports `WhereClause` (the type of `QueryOpts.where`) and `Operator` (its per-field operators); `@aws-cdk-blocks/bb-realtime` exports `InferMessage`; `@aws-cdk-blocks/core` exports `ApiNamespaceConstructor` (the type of `ApiNamespace`) and `AsyncAPI` (the type of an `ApiNamespace` instance). These already appeared in the packages' public signatures but could not be named by apps.
- **No type changes.** `registerSdkIdentifiers` and `getAllSdkIdentifiers` in `@aws-cdk-blocks/core` spell their identifier record as `Record<string, string>` instead of a private alias of the same type.
