# Agent — Design

Design document for the Agent Building Block. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-agent`
**Type:** Composite (uses AgentCore Runtime, DistributedTable ×2, FileBucket internally)
**AWS Services:** Bedrock (incl. AgentCore Runtime), DynamoDB, S3
**Agent Framework:** [Strands Agents SDK](https://strandsagents.com/)

## Architecture

The Agent BB is a composite Building Block. The agent loop runs on an **AgentCore Runtime** (replacing the former Lambda + SQS/AsyncJob + AppSync/Realtime streaming side-channel); conversation history + session state use DynamoDB and S3:

| Internal resource | Purpose | Created when |
|-------------------|---------|-------------|
| **AgentCore Runtime** | Hosts + runs the Strands agent loop; streams to the client | Always (deployed) |
| **FileBucket** (S3) | Session persistence (Strands `S3SessionManager`) | Always |
| **DistributedTable ×2** (DynamoDB) | Conversations table + messages table | `inferenceOnly: false` |

```
streamSSE(message, { conversationId, userId })  ── runs the Strands agent loop and
                                                    yields chunks as they are produced
        │
        ├─ AWS (browser): the runtime streams over a WebSocket (/ws) directly to the browser
        │                 (browsers can't open the /invocations SSE endpoint cross-origin — no CORS)
        ├─ AWS (non-browser / RPC): the runtime's /invocations (HTTP + SSE)
        └─ Local dev: the dev-server SSE route (dev-stream.ts)
        │
        ├─ persists user / tool-call / tool-result / interrupt / assistant messages → DistributedTable
        └─ Strands SessionManager saves agent state → S3 (for HITL resume)
```

The old `stream()` → `AsyncJob.submit()` → Realtime-channel model is gone; `stream()`/`resume()` remain only as `@deprecated` wrappers over `streamSSE()`. See the "Streaming: layer / parity notes" section below for transport details and the browser WebSocket path.

## Session Persistence

Two storage backends, same FileBucket BB:
- **AWS:** Strands' native `S3Storage` → FileBucket-provisioned S3 bucket
- **Local:** Custom `FileBucketSnapshotStorage` → FileBucket mock (mirrors S3Storage key layout exactly)

## Infrastructure (CDK)

The CDK class mirrors the runtime's BB creation:
- **Bedrock IAM:** `InvokeModel` + `InvokeModelWithResponseStream` on all foundation models and inference profiles
- **FileBucket:** `${id}-sn` — session snapshot storage
- **DistributedTable ×2:** `${id}-convos` + `${id}-messages` — conversation + message history (only when `inferenceOnly: false`)
- **AgentCore `Runtime`:** hosts the agent loop, co-bundled at synth time from the app backend (`agentcore-bundle.ts`). Replaces the former Lambda + SQS (AsyncJob) + AppSync/Realtime streaming side-channel, which are no longer provisioned.

> **Note:** Internal Building Blocks are created on the parent scope (not `this`) to ensure correct nested-scope resolution on AWS.

## Streaming: layer / parity notes

- **`getStreamEndpoint()` is AWS-only by design.** It returns the deployed AgentCore Runtime endpoint the browser streams to; the base/mock implementation throws a clear error. This is an intentional parity choice, not a silent gap: locally there is no runtime to connect to, so streaming goes through the dev-server SSE route registered via `registerDevAttachment('@aws-blocks/bb-agent/dev-stream')`. The method exists on every layer (defined on `AgentBase`) so it type-checks everywhere; only the deployed runtime returns a real endpoint.
- **Server-verified identity on JWT runtimes.** When a JWT authorizer is configured, the CDK sets `requestHeaderConfiguration: { allowlistedHeaders: ['Authorization'] }` so AgentCore forwards the gateway-validated caller token to the container. The handlers derive `userId` from the token's `sub` claim (`userIdFromContext`) and fall back to the client-supplied `userId` only when no token is forwarded (IAM runtimes, or a path without header forwarding). This gives an unforgeable identity on the JWT path. On IAM runtimes there is no caller JWT, so the body `userId` is used and invocation must be gated by the runtime's IAM authorizer. **Do not expose an IAM runtime to untrusted callers.**

### Canonical persistence identity (`sub`) — cross-transport consistency

Conversation history is partitioned by `userId`. The value used for that key **must be consistent across every transport that reaches the same agent**, or one user's history fragments across two partition keys and `listConversations(...)` won't surface all of it.

- **Canonical key = the token `sub` (`userSub`).** Per the Cognito identity model, `userSub` (the `sub` claim, a pool-assigned UUID) is the stable cross-store join key; `username` is for display/admin lookups only and can change. The JWT/WebSocket path already keys by `sub` (via `userIdFromContext`).
- **Known inconsistency to resolve with the OIDC work.** A reference/RPC path that keys by `CognitoUser.userId` (which equals the *username* for Cognito, not `sub`) is on a different key than the WebSocket path. In the current reference app this cannot collide — the RPC agent is a separate instance fronted by AuthBasic (an IAM runtime with no `sub`), while the Cognito agent is WebSocket-only — so no single agent mixes the two keys today.
- **Follow-up:** before an agent is offered over **both** transports under Cognito/OIDC, standardize all persistence on `sub`/`userSub` (align the RPC path + add a cross-transport parity check). This is deferred to and tracked with the **OIDC support work**, which raises the same "which claim is the canonical id" question for non-Cognito providers.

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
