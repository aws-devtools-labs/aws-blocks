---
"@aws-blocks/core": minor
---

feat(core): expose `backendModulePath`

`BlocksStack` / `BlocksBackend` now expose `backendModulePath` (the app's `backendCDKPath`) so
Building Blocks that co-bundle the app backend at synth time can discover it via
`globalThis.CURRENT_BLOCKS_STACK.backendModulePath`. Used to co-bundle the backend + the agent
`serve()` harness into the AgentCore Runtime's code asset.

The shared execution role (`BlocksRole`) stays BB-agnostic: it is created with a
`CompositePrincipal` so a Building Block whose compute runs **as** the shared role can add its own
trust principal from its own CDK construct (e.g. the Agent BB adds `bedrock-agentcore`), rather than
core trusting a specific compute by default.
