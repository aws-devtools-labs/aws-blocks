---
"@aws-blocks/bb-agent": minor
---

feat(bb-agent): make model config optional, default to BedrockModels.BALANCED

The `model` field in AgentConfig is now optional. When omitted, the agent
defaults to `BedrockModels.BALANCED` (Claude Sonnet 4.6) for deployment
and the canned provider for local development.
