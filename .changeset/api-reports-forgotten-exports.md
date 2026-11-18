---
'@aws-blocks/bb-agent': patch
'@aws-blocks/bb-data': patch
'@aws-blocks/bb-realtime': patch
'@aws-blocks/core': patch
---

Export types that public signatures already use

- **Exported types (type-only, additive).** `@aws-blocks/bb-agent` now exports `AgentBase` (the base class of `Agent`, as a type), `ConversationManagerConfig`, `MessageMetadata`, `GuardrailsConfig` and `InferenceConfig`; `@aws-blocks/bb-data` exports `WhereClause` (the type of `QueryOpts.where`) and `Operator` (its per-field operators); `@aws-blocks/bb-realtime` exports `InferMessage`; `@aws-blocks/core` exports `ApiNamespaceConstructor` (the type of `ApiNamespace`) and `AsyncAPI` (the type of an `ApiNamespace` instance). These already appeared in the packages' public signatures but could not be named by apps.
- **No type changes.** `registerSdkIdentifiers` and `getAllSdkIdentifiers` in `@aws-blocks/core` spell their identifier record as `Record<string, string>` instead of a private alias of the same type.
