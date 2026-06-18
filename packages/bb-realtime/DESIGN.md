# Realtime — Design

Design document for Realtime. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-realtime`
**Type:** Client-facing
**AWS Services:** API Gateway WebSocket, DynamoDB, SSM Parameter Store

## API Surface

```typescript
const Realtime: {
	new <T extends NamespaceDefs>(scope: ScopeParent, id: string, options: RealtimeOptions<T>): Scope & RealtimeServer<T>;
	namespace<M>(schema: StandardSchemaV1<M>): NamespaceConfig<M>;
};

interface RealtimeOptions<T extends NamespaceDefs> {
	namespaces: T;
	/** Optional logger for internal BB diagnostics. Defaults to error-level logging. */
	logger?: ChildLogger;
}

interface RealtimeServer<T extends NamespaceDefs> {
	publish<K extends keyof T>(namespace: K, channel: string, data: InferMessage<T[K]>): Promise<void>;
	subscribe<K extends keyof T>(namespace: K, channel: string, handler: (message: InferMessage<T[K]>) => void): () => void;
	getChannel<K extends keyof T>(namespace: K, channel: string): Promise<RealtimeChannel<InferMessage<T[K]>>>;
}

interface RealtimeChannel<T> {
	subscribe(handler: (message: T) => void): RealtimeSubscription;
	subscribe(options: SubscribeOptions<T>): RealtimeSubscription;
	/** @internal */ toJSON(): RealtimeChannelDescriptor;
}

interface SubscribeOptions<T> {
	onMessage: (message: T) => void;
	onDisconnect?: (reason: DisconnectReason) => void;
}

type DisconnectReason = 'timeout' | 'error' | 'unknown';

interface RealtimeSubscription {
	unsubscribe(): void;
	established: Promise<void>;
	connection?: WebSocket;
}
```

### Design Decisions

**Options object for extensibility:** Constructor takes `RealtimeOptions<T>` with a `namespaces` key. Allows additional options (auth integration, history, TTL) to be added without breaking the signature.

**Methods instead of dynamic properties:** `rt.publish('cursors', ...)` instead of `rt.cursors.publish()`. Eliminates collisions with `Scope` members.

**No `publish()` on `RealtimeChannel`:** Channel handles are subscribe-only. Publishing goes through `rt.publish()` from API methods. Authorization stays in user code.

**`getChannel()` returns `Promise<RealtimeChannel>`:** The token secret is fetched from SSM asynchronously on cold start. Making `getChannel()` async ensures the secret is available before minting tokens. `await` on the mock's synchronous return is a no-op.

**No `unsubscribe_success` acknowledgment:** The server does not send a confirmation when a client unsubscribes. Unlike `subscribe`, which needs `established` for auth confirmation, unsubscribe is fire-and-forget — the client has already stopped listening. Adding an ack would cost a PostToConnection call per unsubscribe for zero functional benefit.

**`RealtimeSubscription` object:** Returns `unsubscribe()`, `established` (Promise), and `connection` (WebSocket). The `established` promise resolves on `subscribe_success` and rejects on auth failure.

## Type Safety Pattern

`Realtime` uses a typed constructor signature (`new <T>(...): Scope & RealtimeServer<T>`). The `RealtimeServer<T>` interface uses `<K extends keyof T>` so that namespace names are type-checked as string literals and data types are inferred from the corresponding schema.

## Connection Architecture

### Multiplexed WebSocket

Both mock and AWS middlewares pool WebSocket connections by endpoint URL. Multiple channel subscriptions are multiplexed over a single connection:

```
Client                          Server (API GW / Mock WS)
  │                                │
  ├─── WebSocket connect ─────────►│  (one connection per endpoint)
  │                                │
  ├─── subscribe(channel-A, token)►│  ◄── subscribe_success
  ├─── subscribe(channel-B, token)►│  ◄── subscribe_success
  ├─── subscribe(channel-C, BAD)──►│  ◄── error (channel-C only)
  │                                │
  │◄── message(channel-A, data) ───│  (routed by channel name)
  │◄── message(channel-B, data) ───│
  │                                │
  ├─── ping ──────────────────────►│  (every ~9 min, keeps connection alive)
  │                                │
  ├─── unsubscribe(channel-A) ────►│
  │                                │
```

A failed subscribe rejects only that subscription's `established` promise — other subscriptions on the same connection are unaffected.

### Two-Tier Auth

- **Connect token:** Scoped to the Realtime instance (2-hour TTL). Passed as query string parameter on WebSocket connect. Gates who can open a connection.
- **Channel token:** Scoped to a specific channel (1-hour TTL). Sent in the subscribe message. Gates who can subscribe to a channel.

Both are HMAC-SHA256 signed with the same shared secret. The connect token's channel field is the instance prefix (e.g., `collab`), so `validateChannelToken`'s `startsWith` check accepts any channel under that prefix.

### Mock Middleware

- Connection pool keyed by `wsUrl` (e.g., `ws://localhost:3001/realtime`)
- Subscribe: `{ action: 'subscribe', channel, token }`
- Response: `{ type: 'subscribe_success', channel }` or `{ type: 'error', channel, message }`
- Data: `{ type: 'message', channel, payload }`

### AWS Middleware

- Connection pool keyed by `wsUrl` (API Gateway WebSocket stage URL)
- Connect: `wss://{wsUrl}?token={connectToken}`
- Subscribe: `{ action: 'subscribe', channel, token }`
- Response: `{ type: 'subscribe_success', channel }` or `{ type: 'error', channel, message }`
- Data: `{ type: 'message', channel, data }`
- Keep-alive: `{ action: 'ping' }` every ~9 minutes

### Server-Side Subscribe

Server-side `subscribe()` opens a real WebSocket connection to the API Gateway endpoint, using the same connect token and channel token mechanism as client subscriptions. This means server-side subscribers receive messages published by any Lambda invocation, not just the current one. `publish()` also emits to a local EventEmitter for zero-latency delivery to same-invocation subscribers.

## Infrastructure (CDK)

### Shared Per Stack

All `Realtime` instances in a stack share infrastructure. The first constructor creates it; subsequent ones reuse it via a Symbol-keyed property on the stack.

| Resource | Type | Purpose |
|----------|------|---------|
| Connections Table | DynamoDB Table | Channel→connection mapping with TTL |
| WebSocket API | API Gateway WebSocketApi | Client WebSocket endpoint |
| WebSocket Stage | WebSocketStage (`rt`, auto-deploy) | Deployment stage |

All three WebSocket routes ($connect, $disconnect, $default) point at the existing Blocks handler Lambda — wired via `WebSocketLambdaIntegration` at CDK synth time, with the runtime handler registered through `registerLambdaEventHandler('blocks.websocket', ...)`. No separate Lambdas are created.

### Per Instance

| Resource | Type | Purpose |
|----------|------|---------|
| Token Secret | AppSetting (secret: true) | HMAC signing key, auto-generated |

### DynamoDB Connections Table

```
PK:  connectionId  (String)
SK:  channel       (String)    — "__connection__" for sentinel, channel path for subscriptions
GSI: channel-index (PK=channel, SK=connectionId)
TTL: expiresAt     (Number)
```

- **Sentinel record** (`SK: "__connection__"`): Created at $connect, carries `lastTtlSweep` timestamp.
- **Channel records**: Created on subscribe, one per (connectionId, channel) pair.
- **TTL**: Sentinel = 2.5 hours, channel records = 1 hour.

### TTL Refresh (Sweep-Based)

On every keep-alive ping (~9 min):
1. Update sentinel TTL (1 DynamoDB write)
2. If `lastTtlSweep` > 30 min ago: batch-refresh all channel record TTLs, update `lastTtlSweep`
3. If recent: done (1 write total)

This keeps cost at O(1) per ping for the common case, with periodic O(N) sweeps.

### Publish Fan-Out

`publish()` queries the GSI by channel, then calls `postToConnection` for each connectionId in parallel. 410 GoneException triggers cleanup of all records for that connectionId.

**Concurrency model:** All `postToConnection` calls are issued via `Promise.all` — no application-level batching or semaphore. Concurrency is governed by the AWS SDK's HTTP agent, which defaults to `maxSockets: 50` per origin. This means at most 50 requests are in-flight simultaneously; the rest queue at the HTTP layer.

**Latency math (same-region Lambda → API Gateway management endpoint):**

| Subscribers | In-flight waves (50 sockets) | Estimated latency |
|---|---|---|
| 10 | 1 | ~5-10ms |
| 50 | 1 | ~5-10ms |
| 200 | 4 | ~20-40ms |
| 500 | 10 | ~50-100ms |
| 1,000 | 20 | ~100-200ms |

Each `postToConnection` takes ~5-10ms with TCP keep-alive. The SDK retries transient errors (throttling, 5xx) with exponential backoff automatically (3 retries by default).

**Why no customer-facing concurrency knob:** The HTTP agent's `maxSockets` is an internal default that works for the typical case (< 1000 subscribers). Customers who exceed this are in AsyncJob/sharding territory. If we need to raise the default, it's a non-breaking internal change.

**API Gateway limits:** `postToConnection` shares the account-level API Gateway TPS quota (~10K default, raisable). A single Lambda with 50 concurrent sockets is well within this. Multiple Lambdas publishing simultaneously could approach the limit — this is another reason to shard large fan-outs.

**References:**
- [API Gateway WebSocket quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html) — official limits (32 KB frame, 2hr connection, 500 new conn/sec, 10K TPS account-level)
- [SO: postToConnection 429 throttling](https://stackoverflow.com/questions/61159703) — confirms account-level throttle applies to management API calls

### Environment Variables

| Variable | Value |
|----------|-------|
| `BLOCKS_RT_WS_URL` | `wss://api-id.execute-api.region.amazonaws.com/rt` |
| `BLOCKS_RT_CALLBACK_URL` | `https://api-id.execute-api.region.amazonaws.com/rt` |
| `BLOCKS_SSM_PARAM_TOKEN_SECRET` | SSM parameter name (set by AppSetting) |

The connections table is provisioned by the nested `DistributedTable`, which manages its own table-name configuration — Realtime does not set a separate table-name environment variable.

### Channel Path Mapping

```
Realtime instance fullId: "my-app-collab"
Namespace name:           "chat"
Channel:                  "room-123"

Channel path:             my-app-collab/chat/room-123
```

## Mock Implementation

- In-process `EventEmitter` per channel path — `publish()` emits immediately.
- Dev server runs a WebSocket server at `/realtime` for browser clients.
- Token validation mirrors AWS behavior (HMAC check, expiry, channel scope).
- Schema validation runs on every `publish()`.
- No persistence — channels are ephemeral.

## Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| WS message uses `payload` field (mock) vs `data` (AWS) | Native mobile clients see different wire format | Abstracted by SDK middlewares; document for native implementors |
| Mock skips connect-time token auth (`?token=` query param) | A client can still *open* a WS locally, but can no longer *subscribe* without a valid channel token (enforced at subscribe time) | Recommend sandbox testing for connect-time auth-sensitive flows |
| No connection duration limit locally | Mock WS stays open indefinitely | Document the 2-hour AWS limit in README |
| Single-process only | No cross-process pub/sub | Local dev is single-process |
| No message ordering guarantees | In-process delivery is synchronous (ordered); AWS may deliver out of order | Ordering is inherently non-deterministic |
| ~~No size/length enforcement locally~~ | ~~Silent failures in AWS~~ | **Fixed** — channel path (1024B) and publish size (32KB) are now enforced in both environments |

## Serialization

### Mock Descriptor (toJSON)
```json
{ "__blocks": "realtime/channel", "channel": "my-app-collab/chat/room-123", "wsUrl": "ws://localhost:3001/realtime", "token": "..." }
```

### AWS Descriptor (toJSON)
```json
{ "__blocks": "realtime/channel", "channel": "my-app-collab/chat/room-123", "wsUrl": "wss://...", "connectToken": "...", "token": "..." }
```

## Connection Lifecycle & Reconnect

### The Problem

API Gateway WebSocket has a hard 2-hour max connection duration. When the connection drops — whether from the 2-hour limit, a network interruption, or a server-side error — the client needs to:

1. Know the connection was lost (and whether it was intentional)
2. Re-establish the WebSocket connection
3. Re-subscribe to channels (which requires fresh tokens)
4. Backfill any messages missed during the gap

### Approach

The `subscribe()` method accepts an options form with an `onDisconnect` callback:

```typescript
channel.subscribe({
  onMessage: (msg) => { ... },
  onDisconnect: (reason) => {
    // reason: 'timeout' | 'error' | 'unknown'
    // Re-fetch channel handle (new tokens), re-subscribe, backfill
  },
});
```

**Disconnect reasons:**
- `client` — the client called `unsubscribe()`
- `timeout` — API Gateway closed the connection (2-hour limit or idle timeout, WebSocket close code 1001)
- `error` — WebSocket error or abnormal closure (close code 1006)
- `unknown` — connection closed with any other close code

`onDisconnect` fires for all disconnects including user-initiated ones, following the Socket.IO / Ably convention. Consumers filter by reason if they only care about unexpected drops.

**Backfill responsibility:** The Realtime BB does not provide message history. Backfill is the application's responsibility — typically by re-querying the data source. This is intentional: message history requires persistence and ordering guarantees that belong in the application layer, not the pub/sub transport.

## Channel Name Limits

The previous AppSync Events implementation enforced a 5-segment × 50-character channel name limit. With the move to API Gateway WebSocket + DynamoDB, that restriction no longer applies.

### Enforced Limits

Both the mock (local dev) and AWS runtimes enforce these limits at `publish()`, `subscribe()`, and `getChannel()` time, throwing `ValidationFailedException` with a descriptive message:

| Limit | Value | Source | Validated at |
|---|---|---|---|
| Channel path (full) | 1024 bytes UTF-8 | DynamoDB sort key maximum | `publish`, `subscribe`, `getChannel` |
| Published message size | 32,768 bytes | API Gateway WebSocket frame maximum | `publish` |

**Channel path** is the fully-qualified string `{fullId}/{namespace}/{channel}` stored as the DynamoDB sort key. The validation uses `Buffer.byteLength(fullChannel, 'utf8')` so multi-byte characters (emoji, CJK, etc.) are counted correctly.

**Published message size** is the serialized wire envelope: `JSON.stringify({ type: 'message', channel: fullChannel, data })`. This includes the channel path and the user's data payload. The 32 KB limit is the maximum single WebSocket frame that API Gateway will accept without closing the connection (code 1009).

### Why Enforce in Both Environments

Enforcing in the mock runtime ensures developers discover limit violations during local development rather than encountering silent failures after deploying to AWS. The error messages include the actual byte count and the limit, making it clear what needs to change.

### Budget Calculation

The user's available budget for the `channel` argument depends on the prefix:

```
available = 1024 - byteLength(fullId) - byteLength(namespace) - 2 separators
```

For a typical setup (`fullId` = `my-app-collab`, namespace = `cursors`):
- Prefix: `my-app-collab/cursors/` = 20 bytes
- Available for channel: 1004 bytes (1004 ASCII characters, or fewer for multi-byte)

For publish size, the overhead is the JSON envelope wrapping the data:
- Envelope: `{"type":"message","channel":"<fullChannel>","data":}` ≈ 40 + channel path length
- Available for serialized data: ~32,700 bytes for typical channel paths

### Binding Constraints

The full channel path (`{fullId}/{namespace}/{channel}`) is stored as a DynamoDB sort key and included in every WebSocket message. The relevant limits:

| Constraint | Limit | Impact |
|---|---|---|
| DynamoDB sort key | 1024 bytes | **Enforced** — hard limit on full channel path length |
| API Gateway frame | 32 KB | **Enforced** — hard limit on published message size |
| DynamoDB partition key (GSI) | 2048 bytes | Not enforced — channel path hits SK limit first |
| DynamoDB item size | 400 KB | Not a concern — items are ~200 bytes |
| API Gateway billing | 32 KB increments | Long channel names marginally increase cost |

### Why We Recommend 256 Characters

A 256-character user channel name, combined with a typical prefix (`myapp-rt/cursors/` = ~18 chars), stays well under the 1024-byte sort key limit while leaving room for future metadata. At 256 chars, the channel name adds ~0.8% to a 32 KB message — negligible for billing.

Longer names are technically possible but offer no benefit. They increase DynamoDB read/write unit consumption (items are billed in 4 KB read / 1 KB write increments) and make WebSocket messages larger for no functional gain.

### Why AppSync Had 5×50

AppSync Events used a hierarchical channel namespace (`/segment1/segment2/.../segment5`) with each segment limited to 50 characters. This was likely driven by AppSync's internal routing and subscription filtering architecture, not a fundamental WebSocket or DynamoDB constraint. Since we handle routing ourselves via DynamoDB GSI queries, we don't inherit that limitation.
