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

## Client streaming API (compute-agnostic)

The **client-facing** streaming surface is deliberately independent of *where*
the agent loop runs. The runtime shows up at exactly one seam — the **transport**
— so the same client code works over Lambda + Realtime today and other runtimes
later. (The backend methods below are *not* part of this abstraction — they are
the current Realtime runtime's implementation, which a different runtime would
replace, not reuse.)

```
  CLIENT (browser) — compute-agnostic          BACKEND (Agent BB) — current runtime
  createChat({ transport, api })               stream() → submit job → { channelId }
    └─ sendMessage(msg)                         getChannel() → Realtime channel handle
         fuses subscribe + run                  resume() → submit resume job
         (no subscribe-before-send race)        runAgent() (private) → publishes chunks
  transport = the ONE runtime-specific piece
```

- `ChatTransport` (`transport.ts`) has two primitives: `run(turn)` (produce) and
  `subscribe(channelId)` (consume, an `AsyncIterable` with an `established`
  promise). `createChat`'s easy default fuses them; the flexible cases (fan-out,
  observer-only, decoupled produce/consume) drop to the primitives. This
  interface is the seam a future runtime implements — the app above it is
  unchanged.
- `realtimeTransport(io)` is the Lambda + Realtime implementation of that seam. It
  bridges the callback-based Realtime channel (`subscribe(handler)` +
  `established`) into the `AsyncIterable` `ChunkStream` via a small
  single-consumer push queue (`ChunkQueue`), and maps `run` onto the app's
  `stream`/`resume` RPCs (which submit the AsyncJob). A new runtime supplies a
  different transport here; nothing else on the client changes.

The server methods (`stream()`/`getChannel()`/`resume()` and the private
`runAgent()`) are the Realtime path itself and remain the app's backend contract.
Only the `useChat` client hook is deprecated — superseded by `createChat`.

## Session Persistence

Two storage backends, same FileBucket BB:
- **AWS:** Strands' native `S3Storage` → FileBucket-provisioned S3 bucket
- **Local:** Custom `FileBucketSnapshotStorage` → FileBucket mock (mirrors S3Storage key layout exactly)

## Infrastructure (CDK)

The CDK class mirrors the runtime's BB creation:
- **Bedrock IAM:** `InvokeModel` + `InvokeModelWithResponseStream` on all foundation models and inference profiles
- **FileBucket:** `${id}-sessions` — session snapshot storage
- **DistributedTable:** `${id}-messages` — conversation history (only when `inferenceOnly: false`)
- **Realtime:** `${id}-rt` — streaming namespace `chunks`
- **AsyncJob:** `${id}-job` — job payload: `{ message, conversationId?, channelId }`

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
