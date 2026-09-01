# Agent — Design

Design document for the Agent Building Block. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-agent`
**Type:** Composite (uses DistributedTable, Realtime, AsyncJob, FileBucket internally)
**AWS Services:** Bedrock, DynamoDB, S3, SQS, AppSync Events
**Agent Framework:** [Strands Agents SDK](https://strandsagents.com/)

## Architecture

The Agent BB is a composite Building Block — it creates and manages 4 internal BBs:

| Internal BB | Purpose | Created when |
|-------------|---------|-------------|
| **FileBucket** | Session persistence (Strands SessionManager) | Always |
| **DistributedTable** | Frontend message history | `inferenceOnly: false` |
| **Realtime** | Streaming chunks to caller | Always |
| **AsyncJob** | Async agent execution (avoids 29s API Gateway timeout) | Always |

```
stream() → AsyncJob.submit() → returns { channelId } immediately
                ↓
         AsyncJob consumer
                ↓
         runAgent() → Strands agent loop → publishes chunks to Realtime
                                         → persists messages to DistributedTable
                                         → SessionManager saves state to FileBucket
```

## Session Persistence

Two storage backends, same FileBucket BB:
- **AWS:** Strands' native `S3Storage` → FileBucket-provisioned S3 bucket
- **Local:** Custom `FileBucketSnapshotStorage` → FileBucket mock (mirrors S3Storage key layout exactly)

## Runaway-protection caps

`AgentConfig.maxLlmCalls` / `maxToolIterations` (default 20, `false` disables) bound runaway cost. They're enforced in `runAgent` by counting Strands' `BeforeModelCallEvent` / `BeforeToolCallEvent` hooks and calling `agent.cancel()` once a cap is exceeded; cancellation ends the stream normally (`stopReason: 'cancelled'`), which `runAgent` surfaces as an `error` chunk and then skips the final persist + `done`.

**Scope is the whole logical turn, including across HITL resumes.** The counters are stored in the Strands agent's `appState` (keys `__bbAgentModelCallCount` / `__bbAgentToolCallCount`), which the `SessionManager` persists with the session snapshot — the same mechanism the `trusted:<tool>` flags use. A turn that pauses on an interrupt and continues via `resume()` therefore keeps counting on its existing budget. Locals in `runAgent` would reset on every resume, letting an auto-approving or trusted-tool resume loop re-enter itself indefinitely — exactly the runaway these caps exist to stop.

**The reset is lazy, and it has to be.** The `SessionManager` restores the snapshot's `appState` *during* `stream()`, i.e. after `runAgent` has already set up its hooks — so zeroing the counters up front is silently overwritten by the previous turn's values and the budget leaks from turn to turn (a second message on the same conversation would start at the first turn's count and trip immediately). Instead, a fresh turn mints a `turnId` and the first cap hook to fire notices the stored `__bbAgentCapTurnId` is stale, zeroes the counters, and claims the turn; a resume mints no id, so it continues on the restored counts. Strands has no per-turn identifier to reuse here — `invocationState` is a caller-supplied bag, and a per-invocation id would change on every `resume()`, which is the opposite of what's needed.

A tool call cancelled by the tool cap still gets an `AfterToolCallEvent` (Strands reports the cancellation as the call's result), so the `tool-call` row already written to the message table keeps its `tool-result` partner — no dangling `tool_use` is left for the next turn to replay. `runAgent` additionally writes an `assistant` row carrying the stop reason in `metadata.error`, so a reloaded conversation explains why it ended.

## Infrastructure (CDK)

The CDK class mirrors the runtime's BB creation:
- **Bedrock IAM:** `InvokeModel` + `InvokeModelWithResponseStream` on all foundation models and inference profiles
- **FileBucket:** `${id}-sessions` — session snapshot storage
- **DistributedTable:** `${id}-messages` — conversation history (only when `inferenceOnly: false`)
- **Realtime:** `${id}-rt` — streaming namespace `chunks`
- **AsyncJob:** `${id}-job` — job payload: `{ message, conversationId?, channelId }`
  - Event source uses `batchSize: 1` / `maxBatchingWindowSeconds: 0`: the caller is blocked on the job starting, so the Agent opts out of AsyncJob's batching defaults (10 / 5s) rather than add up to 5s of latency to an interactive turn.

> **Note:** Internal Building Blocks are created on the parent scope (not `this`) to ensure correct nested-scope resolution on AWS.

## Model Providers

All providers are Strands model implementations, mapped from Blocks's `ModelConfig` via `model-factory.ts`:

| Provider | Strands Class | Use Case |
|----------|--------------|----------|
| `canned` | `CannedProvider` (custom) | Local dev — keyword-based responses with tool call support |
| `bedrock` | `BedrockModel` | AWS — Amazon Bedrock models |
| `openai-api` | `OpenAIModel` | Any OpenAI-compatible endpoint (OpenAI, Ollama, vLLM) |

## CannedProvider

Custom Strands model provider for local development. No network, no API keys, no costs.

- Returns instant keyword-based responses (e.g., prompt contains "weather" → weather response, otherwise a default canned response)
- Streams word by word, matching the same `ModelStreamEvent` protocol as Bedrock/OpenAI
- Triggers tool calls when the prompt mentions a tool name — splits camelCase names into words (e.g., "weather" matches `getWeather`) and emits Strands `toolUse` events
- After Strands executes the tool and sends the result back, returns a fixed acknowledgment (`"I called the tool and got a result."`)
- Token usage reports zeros (no real model call)
