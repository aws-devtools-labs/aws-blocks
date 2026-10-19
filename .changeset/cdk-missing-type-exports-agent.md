---
"@aws-blocks/bb-agent": patch
---

fix: export types missing from the `cdk` entry point

Some types exported by the default entry point of `@aws-blocks/bb-agent` were missing from its `cdk` entry, so backend
code importing them failed to type-check under that condition — for example,
`import type { AgentConfig } from '@aws-blocks/bb-agent'`.

The `cdk` entry now exports `AgentTurnPayload`, `AgentConfig`, `AgentResult`, `AgentStreamChunk`, `AgentStreamResult`,
`ToolDefinition`, `AgentTool`, `ToolFactory`, `ToolsConfig`, `ToolHandlerArgs`, `DefaultToolContext`,
`InterruptResponse`, `ToolCallRecord`, `ModelConfig`, `StreamOptions`, `Message`, `Conversation`, `JSONValue`,
`TokenUsage`.
