# Agent — Design

Design document for the Agent Building Block. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-agent`
**Type:** Composite (uses DistributedTable, Realtime, FileBucket internally) + an AgentCore Runtime
**AWS Services:** Bedrock AgentCore Runtime, Bedrock, DynamoDB, S3, API Gateway (WebSocket)
**Agent Framework:** [Strands Agents SDK](https://strandsagents.com/)

## Architecture

The streaming agent loop runs on a **Bedrock AgentCore Runtime** (sessions up to 8h, warm,
managed) — not the shared handler Lambda — and streams chunks to the browser over the **Realtime**
BB, exactly as it would on Lambda. The Agent BB composes these internal BBs plus the runtime:

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
     async task (ping = HealthyBusy keeps the microVM alive up to 8h) and returns an ack
                ↓
         runAgent() → Strands agent loop → publishes chunks to Realtime (under the runtime role)
                                         → persists messages to DistributedTable
                                         → SessionManager saves state to FileBucket
```

The RPC handler (`stream`/`resume`) only kicks off the turn; it does not hold the connection. The
browser subscribes to the Realtime channel by `channelId` and receives chunks as the loop runs —
so a turn is bounded by the AgentCore session (8h), not by Lambda's 15-min / API Gateway's ~29s cap.

**`runtime` config flag.** `runtime` records where the loop runs (currently `'agentcore'`, the only
value and the default) — an explicit seam a future in-process/container option plugs into. Locally
(mock) the loop runs in-process and the flag is ignored.

**Compute model.** All AgentCore provisioning is kept self-contained in `AgentCoreRuntime`
(`agentcore-runtime.cdk.ts`) — the co-bundle, the `Runtime`, its dedicated execution role and grants,
the container env, and the handler's invoke permission — so it can later fold into a per-BB compute
abstraction (should one land) without touching call sites.

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
  other BBs an agent's *tools* touch (KVStore, tables, etc.) and this agent's own session bucket (S3)
  and conversation/message tables (DynamoDB). `AgentCoreRuntime` only adds what the shared role
  doesn't already carry:
  - **Bedrock:** `InvokeModel` + `InvokeModelWithResponseStream` on all foundation models and inference profiles
  - **Realtime publish** (via `Realtime.grantPublish`): `execute-api:ManageConnections` + connections-table query
- **Handler grant:** the shared role is granted `bedrock-agentcore:InvokeAgentRuntime` (wildcard runtime
  ARN, to avoid a role↔runtime dependency cycle) so the RPC handler can start the loop.

For the runtime to assume the shared role, `BlocksRole` trusts `bedrock-agentcore.amazonaws.com` (a
core change). The container gets `BLOCKS_RT_CALLBACK_URL` (from `grantPublish`), `BB_AGENT_ID`,
`BLOCKS_STACK_NAME`, and the session bucket name injected as environment variables (the Lambda's S3
config bundle and the in-process SDK-identifier registry don't reach a non-handler process).

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
