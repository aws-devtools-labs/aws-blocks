---
"@aws-blocks/bb-agent": patch
"@aws-blocks/blocks": patch
---

fix(bb-agent): authenticate the openai-api provider to Bedrock Mantle with the agent's AWS credentials

An `openai-api` model whose `endpoint` is a Bedrock Mantle URL (`https://bedrock-mantle.<region>.api.aws/...`) and has no `apiKey` now authenticates with short-term Bedrock API keys minted from the AWS credentials the agent runs with, refreshed automatically. The deployed runtime role is granted the `bedrock-mantle` permissions it needs. `OPENAI_API_KEY` is not used for Mantle endpoints, and an explicit `apiKey` still takes precedence.
