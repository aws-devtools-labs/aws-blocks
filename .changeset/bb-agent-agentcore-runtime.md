---
"@aws-blocks/bb-agent": minor
---

feat(bb-agent): run the streaming loop on AgentCore Runtime (keeping Realtime)

The Strands agent loop now runs on a **Bedrock AgentCore Runtime** (sessions up to 8h, warm,
managed) instead of an AsyncJob-triggered Lambda — lifting the 15-minute per-turn ceiling — while
**keeping the Realtime BB** as the streaming transport, so chunks reach the browser exactly as
before. `stream()`/`resume()` call `InvokeAgentRuntime`, which starts the turn as a background
async task and returns immediately (the microVM stays alive via `HealthyBusy` while the loop runs
and publishes chunks to Realtime as the shared Blocks execution role). Locally the loop still runs
in-process against the mock Realtime.

- **No client-facing API change:** `stream()`/`resume()`/`getChannel()`, the `chunks` Realtime
  channel, and the `useChat` subscribe contract are unchanged.
- New `runtime` config flag (currently `'agentcore'`, the default) records the runtime as an
  explicit seam for future in-process/container options.
- AgentCore provisioning is self-contained in `AgentCoreRuntime` (co-bundle + `Runtime` via
  `fromCodeAsset`, plus the handler's `InvokeAgentRuntime` permission) so it can later fold into a
  per-BB compute abstraction. The loop runs **as the shared Blocks execution role** (the same role
  the Lambda handler runs as), so it inherits every Building Block's grants (including Realtime
  publish and other BBs an agent's tools touch). `AgentCoreRuntime` adds to that shared role only
  what's AgentCore-specific: the `bedrock-agentcore` assume-role trust (scoped by
  `aws:SourceAccount`/`aws:SourceArn`), Bedrock model access, and the handler's `InvokeAgentRuntime`
  permission — so core stays BB-agnostic and a Realtime-only app never trusts AgentCore.
- **Removed** the internal AsyncJob (and the `@aws-blocks/bb-async-job` dependency); bumped
  `@strands-agents/sdk` to `^1.7.0` and added `bedrock-agentcore` + `@aws-sdk/client-bedrock-agentcore`.

Deployment note: this changes the deployed infra shape (adds an AgentCore Runtime, removes the
agent's SQS queue). Uses `@aws-blocks/bb-realtime`'s new `publishCallbackUrl()` for the endpoint to
inject into the container.
