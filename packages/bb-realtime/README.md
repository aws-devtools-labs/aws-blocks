# @aws-blocks/bb-realtime

Real-time pub/sub messaging backed by API Gateway WebSocket + DynamoDB.

**When to use:** Push data from the server to connected clients in real time — chat messages, live notifications, dashboard updates, collaborative state sync.

**When NOT to use:** If you need request-response APIs, use `ApiNamespace`. If you need durable message queuing with guaranteed delivery, use `AsyncJob`.

**Scaling envelope:** Best suited for channels with tens to low-thousands of concurrent subscribers. Publish latency scales linearly with subscriber count (~100ms for 1,000 subscribers). For channels with 10K+ subscribers, use explicit fan-out patterns (e.g., sharded `AsyncJob`). For 100K+ broadcast audiences, consider a dedicated WebSocket fleet.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick Start

```typescript
import { Realtime } from '@aws-blocks/bb-realtime';
import { z } from 'zod';

const rt = new Realtime(scope, 'collab', {
  namespaces: {
    cursors: Realtime.namespace(z.object({ userId: z.string(), x: z.number(), y: z.number() })),
    chat: Realtime.namespace(z.object({ sender: z.string(), text: z.string() })),
  },
});
```

## API

### Namespaces

Define typed namespaces using `Realtime.namespace(schema)`. The schema provides both the TypeScript type (inferred) and runtime validation on publish.

The `Realtime` instance exposes three methods, all keyed by namespace name (type-checked with full autocomplete):

| Method | Returns | Description |
|--------|---------|-------------|
| `rt.publish(namespace, channel, data)` | `Promise<void>` | Broadcast data to all subscribers (best-effort). Validates against schema. |
| `rt.getChannel(namespace, channel)` | `Promise<RealtimeChannel<T>>` | Get a channel handle (async — `await` it). Return from API methods for client hydration. |
| `rt.subscribe(namespace, channel, handler)` | `() => void` | Server-side subscribe. Returns unsubscribe function. |

**Runtime only.** These methods (`publish`, `subscribe`, `getChannel`) run at request time — call them inside an `ApiNamespace` method, `RawRoute` handler, job handler, or a runtime script, **not** at the top level of your `aws-blocks/index.ts`. Top-level code runs during CDK synth, where the block resolves to its infrastructure construct (no data methods), so a top-level call throws `rt.<method> is not a function` (throws `TypeError` at runtime if called during CDK synth). To publish seed data, do it from inside a handler or a separate runtime script. Constructing the block at module scope is fine; only method calls must move into handlers.

### Channel Handle

`getChannel()` returns a `Promise<RealtimeChannel<T>>` — `await` it to get a subscribe-only handle that serializes via `toJSON()` for client transfer:

| Method | Returns | Description |
|--------|---------|-------------|
| `subscribe(handler)` | `RealtimeSubscription` | Listen for messages (simple form). |
| `subscribe({ onMessage, onDisconnect? })` | `RealtimeSubscription` | Listen for messages with disconnect handling. |
| `toJSON()` | `RealtimeChannelDescriptor` | Transferable serialization (called automatically by JSON.stringify). |

Channel handles do **not** have a `publish()` method. Publishing always goes through `rt.publish()` (server-side) so that authorization logic stays in your code.

### RealtimeSubscription

Returned by `subscribe()` on a channel handle:

| Property | Type | Description |
|----------|------|-------------|
| `unsubscribe()` | `() => void` | Stop receiving messages. |
| `established` | `Promise<void>` | Resolves when the server confirms the subscription. Rejects on auth failure (e.g., invalid token). |
| `connection` | `WebSocket \| undefined` | The underlying WebSocket. Present on client-side subscriptions. Multiple channels on the same endpoint share a single connection. |

Always `await sub.established` before relying on the subscription — this ensures the WebSocket handshake and server-side authorization have completed.

## Usage Patterns

### Server-Side Publish via API

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async sendMessage(roomId: string, text: string) {
    const user = await auth.requireAuth(context);
    await rt.publish('chat', roomId, { sender: user.id, text });
    return { sent: true };
  },
}));
```

### Returning a Channel Handle (Authorization Gate)

The recommended pattern for client subscriptions. Authorization happens in your API method — the channel handle is only returned if the user is allowed:

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async joinRoom(roomId: string) {
    const user = await auth.requireAuth(context);
    if (!canAccessRoom(user, roomId)) throw new Error('Forbidden');
    return rt.getChannel('chat', roomId);
  },
}));
```

Client side:
```typescript
const channel = await api.joinRoom('room-1');
const sub = channel.subscribe((msg) => {
  console.log(msg.sender, msg.text); // fully typed
});
await sub.established; // wait for server confirmation
```

### Server-Side Subscribe

The server can subscribe to channels too — useful for aggregation, logging, or triggering side effects:

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async monitorRoom(roomId: string) {
    const ch = await rt.getChannel('chat', roomId);
    const sub = ch.subscribe((msg) => {
      console.log(`[${roomId}] ${msg.sender}: ${msg.text}`);
    });
    await sub.established;
    return { monitoring: true };
  },
}));
```

On AWS, server-side subscribe uses a real WebSocket connection, so it receives messages regardless of which Lambda invocation published them. Locally, it uses an in-process EventEmitter.

### Multiple Subscriptions Share a Connection

When a client subscribes to multiple channels, they share a single WebSocket connection:

```typescript
const ch1 = await api.joinRoom('room-1');
const ch2 = await api.joinRoom('room-2');

const sub1 = ch1.subscribe(handler1);
const sub2 = ch2.subscribe(handler2);

await sub1.established;
await sub2.established;

// sub1.connection === sub2.connection (same WebSocket)
```

Messages are routed to the correct handler — room-1 messages only go to `handler1`, room-2 only to `handler2`.

### Handling Auth Failures

If a channel's token is invalid or expired, `established` rejects:

```typescript
const sub = channel.subscribe(handler);
try {
  await sub.established;
} catch (err) {
  if (err.name === 'ConnectionFailedException') {
    // token was rejected — re-fetch the channel from the API
  }
}
```

A failed subscribe does **not** kill other subscriptions on the same connection.

### Handling Disconnects

API Gateway has a 2-hour max connection duration. Use the options form of `subscribe()` to handle unexpected disconnects:

```typescript
const sub = channel.subscribe({
  onMessage: (msg) => { console.log(msg); },
  onDisconnect: (reason) => {
    // reason: 'client' | 'timeout' | 'error' | 'unknown'
    if (reason === 'client') return; // we called unsubscribe()
    // Re-fetch channel (new tokens), re-subscribe, backfill missed messages
  },
});
```

`onDisconnect` fires for all disconnects, including user-initiated `unsubscribe()` (with reason `'client'`).

## Schema Validation

Every `publish()` validates against the schema at runtime:

```typescript
import { isBlocksError } from '@aws-blocks/core';
import { RealtimeErrors } from '@aws-blocks/bb-realtime';

try {
  await rt.publish('chat', 'room-1', { sender: 123 }); // wrong type
} catch (e: unknown) {
  if (isBlocksError(e, RealtimeErrors.ValidationFailed)) {
    // data failed schema validation
  }
}
```

## Error Constants

```typescript
import { RealtimeErrors } from '@aws-blocks/bb-realtime';

RealtimeErrors.ValidationFailed  // data failed schema validation on publish
RealtimeErrors.PublishFailed     // Publish fan-out failed (AWS only)
RealtimeErrors.ConnectionFailed  // WebSocket connection or subscribe rejected
```

## Best Practices

- **Await `established`** before publishing or relying on a subscription — don't race the WebSocket handshake.
- **Subscribe before you publish.** Realtime is fire-and-forget with no message buffering (local dev and AWS alike): a subscriber only receives messages published *after* its subscription registers (await `sub.established`). If a server-side publisher (e.g. an AsyncJob or Agent stream) may fire before the client subscribes, the client must subscribe first, then trigger the publisher, and backfill any earlier messages from a durable source (DB/history).
- **Publish through the API**, not the channel handle — keeps authorization logic in one place.
- **Use channels for dynamic scoping** — `room-123`, `user-456`, `game-abc`. One namespace, many channels.
- **Keep payloads small** — large messages increase latency and cost. Max 32 KB per published message (including wire envelope).
- **One `Realtime` instance per domain** — use multiple namespaces within it for different message types (cursors, chat, presence).
- **Unsubscribe when done** — especially in components that mount/unmount. Leaked subscriptions hold the WebSocket open.
- **Delivery is best-effort** — `publish()` sends to all connected subscribers in parallel. If delivery to an individual connection fails, the failure is logged and the rest continue. Stale connections are cleaned up automatically. This is similar to UDP: fire-and-forget per connection.
- **Large fan-out** — `publish()` awaits delivery to all subscribers before returning. For channels with tens of subscribers, this adds negligible latency. For larger audiences, offload to `AsyncJob` so the API response isn't blocked:

  ```typescript
  const broadcast = new AsyncJob(scope, 'broadcast', {
    schema: z.object({ channel: z.string(), data: cursorSchema }),
    handler: async ({ channel, data }) => { await rt.publish('cursors', channel, data); },
  });

  // In your API method:
  await broadcast.submit({ channel: roomId, data: cursor }); // returns immediately
  ```

- **Broadcast scale (10K+ subscribers)** — a single Lambda invocation hitting `postToConnection` for every subscriber will hit API Gateway TPS limits (~10K default). For this scale, shard the fan-out across multiple AsyncJob invocations, each responsible for a slice of subscribers. This bridges the gap while you evaluate a dedicated WebSocket fleet for true broadcast workloads.
- **Test auth flows in sandbox** — use `npm run test:e2e:sandbox` to validate the full deployed auth flow end-to-end.

## Scaling & Cost (AWS, US East)

Cost scales linearly with messages delivered. The API Gateway message fee dominates.

### Per-Publish Cost (to N subscribers)

| Operation | Cost |
|-----------|------|
| DynamoDB: query GSI for subscriber list | ~$0.0000001 (negligible) |
| API Gateway: deliver message × N | N × $0.000001 |
| **Total per publish** | **≈ N × $0.000001** |

The publish call itself is a Lambda invocation, not a WebSocket message — no API Gateway charge for the inbound side. DynamoDB lookup is <0.01% of cost.

| Subscribers | Cost per publish | Cost per 1M publishes |
|-------------|------------------|-----------------------|
| 1 | $0.000001 | $1.00 |
| 10 | $0.00001 | $10.00 |
| 100 | $0.0001 | $100.00 |

### Connection Cost

| Component | Rate |
|-----------|------|
| Connection-minutes | $0.25 per million |
| Keep-alive pings (~7/hr) | ~$0.000005/hr (DynamoDB reads + writes) |
| **Per connection-hour** | **~$0.00002** |

1,000 connections online 24/7 ≈ $18/month. 10,000 connections × 8 hrs/day ≈ $48/month.

### Publish Latency

`publish()` delivers messages in parallel, limited by the SDK's HTTP connection pool (50 concurrent sockets by default). Each `postToConnection` takes ~5-10ms with TCP keep-alive within the same region.

| Subscribers | Estimated publish latency |
|---|---|
| 10 | ~5-10ms (single wave) |
| 50 | ~5-10ms (single wave) |
| 200 | ~20-40ms |
| 500 | ~50-100ms |
| 1,000 | ~100-200ms |

The AWS SDK retries throttled requests automatically (3 retries with exponential backoff).

### Limits

| Limit | Value | Enforced | Notes |
|---|---|---|---|
| Channel path (full) | 1024 bytes | Yes — both local and AWS | DynamoDB sort key limit. Includes `{fullId}/{namespace}/` prefix. |
| Message size (published) | 32 KB | Yes — both local and AWS | API Gateway WebSocket frame limit. Includes wire envelope. |
| Max connection duration | 2 hours | No — API Gateway hard limit | Use `onDisconnect` to handle |
| Idle timeout | 10 minutes | No — API Gateway hard limit | Client middleware sends keep-alive pings |
| Account-level API TPS | 10,000/sec | No — API Gateway hard limit | Shared across all API Gateway usage; raisable |
| New connections | 500/sec | No — API Gateway hard limit | Per account per region; raisable |

## Local Development

In local dev (`npm run dev`), Realtime uses an in-process EventEmitter with a WebSocket bridge to browser clients. The local WebSocket server sends `subscribe_success` on valid subscribes and `error` on invalid tokens. Schema validation runs identically to AWS.

Messages are ephemeral — no persistence across restarts.

## Channel Names

Channel names are scoped by the Realtime instance and namespace: `{fullId}/{namespace}/{channel}`. The `channel` argument you pass to `publish()`, `subscribe()`, and `getChannel()` is the user-facing portion.

**Recommended limits:**
- Keep channel names under **256 characters**. The full channel path (including instance ID and namespace) is stored as a DynamoDB sort key and included in every WebSocket message.
- Use short, descriptive identifiers: `room-123`, `user-456`, `game-abc`.
- Avoid embedding large payloads or UUIDs longer than necessary in channel names.

**Hard limits:**
- The full channel path (including `{fullId}/{namespace}/` prefix) must fit within a DynamoDB sort key (1024 bytes). This is enforced at runtime in both local dev and AWS — exceeding it throws `ValidationFailedException`.
- Published messages (including the wire envelope with channel path) must fit within a single API Gateway WebSocket frame (32 KB). This is also enforced at runtime in both environments.
- There is no enforced character limit on the user-facing channel name, but excessively long names increase DynamoDB item sizes (affecting read/write costs) and WebSocket message sizes (affecting delivery latency and billing, since messages are metered in 32 KB increments).

The previous AppSync Events implementation had a 5-segment × 50-character channel name limit. That restriction no longer applies.



## See Also

- [USE-CASES.md](./USE-CASES.md) — Common use cases, scaling patterns, and industry examples
