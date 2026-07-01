---
"@aws-blocks/bb-agentcore-memory": minor
"@aws-blocks/bb-agentcore-gateway": minor
"@aws-blocks/bb-agentcore-identity": minor
---

feat(agentcore): add AgentCore Memory, Gateway, and Identity Building Blocks

Three new Building Blocks that bring Amazon Bedrock AgentCore capabilities into the
AWS Blocks model — the same code runs locally (no AWS account) and on real AgentCore
in production, via the standard four-export contract (mock / aws-runtime / cdk / browser).

- **`@aws-blocks/bb-agentcore-memory`** — short-term events + long-term semantic memory
  (semantic / summary / user-preference strategies, namespaces). Mock simulates the data
  model in-process (lexical retrieval); CDK provisions `AWS::BedrockAgentCore::Memory`.
- **`@aws-blocks/bb-agentcore-gateway`** — expose functions as MCP tools
  (`tools/list` / `tools/call`). Mock dispatches in-process; CDK provisions
  `AWS::BedrockAgentCore::Gateway` + a Lambda `GatewayTarget`.
- **`@aws-blocks/bb-agentcore-identity`** — workload identity + outbound credential
  providers (API key / OAuth2). Mock simulates a token vault; CDK provisions
  `AWS::BedrockAgentCore::WorkloadIdentity` + credential providers.

All three deploy as real AWS resources and round-trip against the live AgentCore APIs.
