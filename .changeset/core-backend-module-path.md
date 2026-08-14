---
"@aws-blocks/core": minor
---

feat(core): expose `backendModulePath`; let the shared role be assumed by AgentCore

Two additions that support the Agent BB running its loop on a Bedrock AgentCore Runtime:

- `BlocksStack` / `BlocksBackend` now expose `backendModulePath` (the app's `backendCDKPath`) so
  Building Blocks that co-bundle the app backend at synth time can discover it via
  `globalThis.CURRENT_BLOCKS_STACK.backendModulePath`. Used to co-bundle the backend + the agent
  `serve()` harness into the runtime's code asset.
- The shared execution role (`BlocksRole`) now also trusts `bedrock-agentcore.amazonaws.com`, so an
  AgentCore Runtime can run **as** the shared role — the same role the Lambda handler already assumes
  (`role: executionRole` in `setupBlocksInfra`) — and inherit every Building Block's grants. The
  AgentCore trust is scoped to this account/region via `aws:SourceAccount` + `aws:SourceArn`
  conditions (AWS's recommended AgentCore Runtime trust policy), so only AgentCore runtimes in this
  account can assume it — not an account-wide confused-deputy surface. The `lambda` trust is
  unchanged (standard, unconditioned).
