---
"@aws-blocks/bb-agent": major
"@aws-blocks/bb-auth-cognito": minor
"@aws-blocks/core": minor
---

Migrate the Agent BB's streaming runtime to Bedrock AgentCore Runtime and remove the Lambda + SQS + AppSync/Realtime side-channel entirely. The Strands agent loop now streams over Server-Sent Events everywhere: AgentCore Runtime on AWS, and a local dev-server SSE route in mock/dev.

**bb-agent (breaking):**
- New primary API `streamSSE(message, options)` — an async generator of stream chunks that both transports drive. Shared `streamAgent()` core owns the Strands loop + DynamoDB history persistence (including HITL approval records), transport-agnostic.
- `stream()`/`resume()` are kept as **`@deprecated` compatibility wrappers** over `streamSSE()`. Their result is now an async-iterable with a `complete()` helper.
- **Breaking:** the Realtime channel surface is removed — `getChannel()`, and the `channel`/`channelId` fields on the stream result, no longer exist (they were Realtime concepts). `resume()` drops its leading `channelId` argument. Migrate to `streamSSE()`.
- `index.cdk.ts` provisions an AgentCore `Runtime` via `AgentRuntimeArtifact.fromCodeAsset()` (Node 22 CodeZip, no Docker) and synth-time co-bundles the app backend with the runtime entrypoint (`agentcore-bundle.ts`); no longer provisions Realtime or AsyncJob.
- `agentcore-entry.ts` hosts the developer's real Agent on the `bedrock-agentcore` `BedrockAgentCoreApp` harness (`/invocations` + `/ping` + SSE); `dev-stream.ts` serves the equivalent SSE route locally.
- `useChat` consumes a single `streamChunks` SSE transport (drops the Realtime subscribe/channel model).
- Bumps `@strands-agents/sdk` to ^1.7.0 and adds `bedrock-agentcore`.

**bb-agent — browser-direct WebSocket streaming (the client-facing win):** on AWS the browser now streams DIRECTLY from the AgentCore Runtime over a WebSocket, bypassing Lambda — so a turn is no longer bounded by the API-Gateway ~30s cap and long-running / streaming agents work for real. `getStreamEndpoint()` returns `{ runtimeArn, wsUrl, sessionId }`; a new client transport `createAgentCoreWsTransport()` (exported from `./client`) opens the socket (JWT passed via the `Sec-WebSocket-Protocol` subprotocol, since browsers can't set WS headers) and feeds `useChat`'s existing `streamChunks` seam. `agentcore-entry.ts` serves a `/ws` handler alongside `/invocations`, driving the same `streamSSE()` loop. The Agent BB stays auth-agnostic: the caller supplies `userId` from its authenticated backend session (AgentCore's JWT authorizer validates the token at the gateway but does not forward it to the container, so the runtime can't re-derive identity itself). Verified end-to-end on AWS, including a >35s turn streaming to completion over the socket.

**bb-auth-cognito (minor):** new `getAgentCoreToken(context)` returns the current session's Cognito **access token** — the JWT an AgentCore Runtime JWT-authorizer accepts for a browser-direct WebSocket (the authorizer validates the `client_id` claim, which the access token carries and the ID token does not). Apps pair it with `Agent.getStreamEndpoint()` to hand the browser everything it needs to open the socket.

**core (minor):** the local dev-server exposes a generic dev route-handler hook (`__BLOCKS_DEV_ROUTE_HANDLERS__`) so a dev attachment can own an HTTP path (e.g. an SSE stream) that the buffered RPC/RawRoute layer can't express. `BlocksStack` now exposes `backendModulePath` for runtime-hosting constructs that co-bundle the backend.

HITL interrupt→approve→resume, streaming, and conversation-history persistence are preserved and verified end-to-end on real AWS AgentCore.
