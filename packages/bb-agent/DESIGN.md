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

The container gets `BB_AGENT_ID`, `BLOCKS_STACK_NAME`, and `BLOCKS_RT_CALLBACK_URL` injected as
environment variables. `BB_AGENT_ID` + `BLOCKS_STACK_NAME` let the co-bundled backend re-derive its
resource names in-process (session bucket, conversation/message tables) via the SDK-identifier
registry — the same derivation the handler uses — so those names aren't injected. Only
`BLOCKS_RT_CALLBACK_URL` (from `Realtime.publishCallbackUrl()`) must be passed, since the API Gateway
Management endpoint isn't otherwise discoverable off the handler.

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
- Triggers tool calls when the prompt mentions a tool name — splits camelCase names into words (e.g., "weather" matches `getWeather`) and emits Strands `toolUse` events
- After Strands executes the tool and sends the result back, returns a fixed acknowledgment (`"I called the tool and got a result."`)
- Token usage reports zeros (no real model call)
