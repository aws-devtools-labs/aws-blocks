# Agent — Design

Design document for the Agent Building Block. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-agent`
**Type:** Composite (uses DistributedTable, Realtime, FileBucket internally) + an AgentCore Runtime
**AWS Services:** Bedrock AgentCore Runtime, Bedrock, DynamoDB, S3, API Gateway (WebSocket)
**Agent Framework:** [Strands Agents SDK](https://strandsagents.com/)

## Architecture

The streaming agent loop runs on a **Bedrock AgentCore Runtime** (sessions up to 8h, warm,
managed) — not the shared Blocks request handler — and streams chunks to the browser over the
**Realtime** BB. The Agent BB composes these internal BBs plus the runtime:

| Internal BB / resource | Purpose | Created when |
|-------------|---------|-------------|
| **FileBucket** | Session persistence (Strands SessionManager) | Always |
| **DistributedTable** | Frontend message history | `inferenceOnly: false` |
| **Realtime** | Streaming chunks to caller | Always |
| **AgentCore Runtime** | Hosts the streaming loop (co-bundled backend + `serve()`) | Always (AWS) |

```
stream()/resume() → InvokeAgentRuntime (returns immediately)
                ↓
     AgentCore Runtime container (agentcore-entry.ts): starts the turn as a BACKGROUND
     async task and returns an ack immediately
                ↓
         runAgent() → Strands agent loop → publishes chunks to Realtime (as the shared execution role)
                                         → persists messages to DistributedTable
                                         → SessionManager saves state to FileBucket
```

The RPC handler (`stream`/`resume`) only kicks off the turn; it does not hold the connection —
running the loop as a background task lets `InvokeAgentRuntime` return in seconds. The microVM then
stays alive on AgentCore's own terms: AgentCore polls the container's health endpoint, and the SDK
reports `HealthyBusy` while a background task is in flight, so AgentCore keeps the runtime running
(up to the 8h max session) and returns it to `Healthy` — eligible for reclaim — once the task
completes. The browser subscribes to the Realtime channel by `channelId` and receives chunks as the
loop runs, so a turn is bounded by the AgentCore session (8h), not by the request handler's
per-invocation limit or API Gateway's ~29s cap.

**Compute model.** All AgentCore provisioning is kept self-contained in `AgentCoreRuntime`
(`agentcore-runtime.cdk.ts`) — the co-bundle, the `Runtime`, the shared role's AgentCore trust +
grants, the container env, and the handler's invoke permission — so it can later fold into a per-BB
compute abstraction (should one land) without touching call sites.

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

The CDK class provisions:
- **FileBucket:** `${id}-sn` — session snapshot storage
- **DistributedTable:** `${id}-convos` / `${id}-messages` — conversation metadata + history (only when `inferenceOnly: false`)
- **Realtime:** `${id}-rt` — streaming namespace `chunks`
- **AgentCore Runtime** (`${id}-runtime`, via `AgentCoreRuntime`) — the co-bundled backend + `serve()`
  harness. It runs **as the shared Blocks execution role** (`Scope.executionRole` / `BlocksRole`) —
  the same role the Lambda handler runs as — so it **inherits every Building Block's grants**, including
  **Realtime publish** (`execute-api:ManageConnections` + the connections table, granted to the handler
  by the `${id}-rt` Realtime child), other BBs an agent's *tools* touch (KVStore, tables, etc.), and
  this agent's own session bucket (S3) and conversation/message tables (DynamoDB). `AgentCoreRuntime`
  adds to that shared role only what's AgentCore-specific and not already carried:
  - **Trust:** the `bedrock-agentcore.amazonaws.com` assume-role statement, so the runtime can assume
    the shared role. Scoped by `aws:SourceAccount` + `aws:SourceArn` (AWS's recommended AgentCore trust
    policy). Added here — not in core — so a Realtime-only app never trusts AgentCore.
  - **Bedrock:** `InvokeModel` + `InvokeModelWithResponseStream` on all foundation models and inference profiles
- **Handler grant:** the shared role is granted `bedrock-agentcore:InvokeAgentRuntime` (wildcard runtime
  ARN, to avoid a role↔runtime dependency cycle) so the RPC handler can start the loop.

The container gets four environment variables: `BB_AGENT_ID`, `BLOCKS_STACK_NAME`, and the config
location `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY`. `BB_AGENT_ID` + `BLOCKS_STACK_NAME` let the
co-bundled backend re-derive its resource names in-process (session bucket, conversation/message
tables) via the SDK-identifier registry — the same derivation the handler uses — so those names aren't
injected. `BLOCKS_CONFIG_BUCKET`/`BLOCKS_CONFIG_KEY` point the container at the shared config blob
(from core's `getConfigLocation()`); `loadConfigToProcessEnv()` loads the **same full app config the
handler does**, which is how the loop gets `BLOCKS_RT_CALLBACK_URL` (registered by the Realtime BB) and
every other `registerConfig()` value a tool's Building Block may read. IAM to read the blob is inherited
from the shared execution role.

> **Note:** The runtime (`agent.ts`) and CDK (`index.cdk.ts`) layers both create the internal BBs on the Agent scope (`this`) with the **same child ids** (`sn`, `convos`, `messages`, `rt`). Same id → same `fullId` → same derived physical name, so the deployed loop resolves the exact resources CDK provisioned.

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
- Triggers tool calls when the prompt mentions a tool name (or a `cannedTriggers` keyword) — splits camelCase names into words (e.g., "weather" matches `getWeather`) and emits Strands `toolUse` events. Matching is on word boundaries, not substrings, so "category" does not fire `getCat`.
- Derives tool input from, in order of preference: the tool's `cannedExamples`, the schema `default` (from Zod `.default()`), the first `enum` value (for enum fields), then a generic placeholder by type (`'sample'` / `1` / `true` / `[]`)
- After Strands executes the tool and sends the result back, returns a fixed acknowledgment (`"I called the tool and got a result."`)
- Token usage reports zeros (no real model call)


## useChat Reconnect Recovery

`useChat` subscribes to the agent's Realtime chunks channel once per conversation and relies on
the transport's transparent reconnect (bb-realtime). Because WebSocket pub/sub is not durable,
the hook treats the **persisted conversation as the source of truth** and recovers around the gap:

- **Subscribe adapter must forward verbatim.** `useChat` calls the consumer's `subscribe` with a
  `ChatSubscribeOptions` *object* (`onMessage`/`onReconnect`/`onDisconnect`), and the
  adapter must pass that argument straight to `channel.subscribe(...)`. Both middlewares branch on
  `typeof arg === 'function'` first, so a callable-with-props hybrid would silently drop the extra
  callbacks and disable reconnect recovery.
- **On reconnect (`handleReconnect`)** the hook re-reads `getConversation` (recovers a final
  assistant message if the turn completed during the gap) and `getPendingInterrupts` (recovers a
  missed interrupt). Two guards protect the eventually-consistent DynamoDB read: `stillSameInFlightTurn`
  (ignore a read that resolves after a live terminal chunk already resolved the turn) and
  `extendsStream` (refuse to overwrite the live bubble with a prior-turn row). A re-sync failure is
  surfaced through `reportError` so the once-per-turn `onError` contract holds.
- **Bounded failsafe (`RECONNECT_FAILSAFE_MS = 660_000`, ~11 min).** A last-resort timer cleared/re-armed
  by every received chunk, so it fires only after *complete silence* — never during a long tool-call
  gap or a slow post-reconnect stream. It must exceed the API Gateway 10-min idle timeout + reconnect
  budget, otherwise a normal idle→disconnect→reconnect cycle would trip a spurious 'Timed out'. It is
  the backstop, not the primary recovery (which is the `done` chunk / DB re-sync). It is armed on
  reconnect AND on a terminal `onDisconnect('error')` while loading — the give-up / all-stale-token
  paths (past the transport's ~2h connect-token ceiling) surface `onDisconnect('error')` but NOT
  `onReconnect`, so wiring the failsafe to that reason too is what guarantees the spinner clears even
  when no channel comes back.
- **Send-path failsafe.** `sendMessage`/`respondToInterrupt` wrap the RPC in try/catch → `handleSendFailure`,
  which resets `loading`, drops the empty assistant placeholder, and reports the error once. A 504 may
  still have started the turn server-side. The send is treated as failed: `handleSendFailure` nulls the
  turn identity (`assistantId`) and clears `loading`, so the reconnect re-sync guard (`stillSameInFlightTurn`)
  will NOT auto-adopt that started turn's persisted text into the in-flight bubble. The started turn's
  result is still persisted and is recovered the next time the app opens the conversation
  (`loadConversation`) — not automatically on the reconnect that follows the failed send.
- **onInterrupt may re-fire on reconnect** for a still-pending interrupt (both `loadConversation` and
  `handleReconnect` surface pending interrupts). Handlers should key/dedupe by interrupt id.
