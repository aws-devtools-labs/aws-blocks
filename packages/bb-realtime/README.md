# @aws-cdk-blocks/bb-realtime

Real-time pub/sub messaging backed by API Gateway WebSocket + DynamoDB.

**When to use:** Push data from the server to connected clients in real time — chat messages, live notifications, dashboard updates, collaborative state sync.

**When NOT to use:** If you need request-response APIs, use `ApiNamespace`. If you need durable message queuing with guaranteed delivery, use `AsyncJob`.

**Scaling envelope:** Best suited for channels with tens to low-thousands of concurrent subscribers. Publish latency scales linearly with subscriber count (about 100–200 ms for 1,000 subscribers). For channels with 10K+ subscribers, use explicit fan-out patterns (e.g., sharded `AsyncJob`). For a broadcast audience of 100K+, consider a dedicated WebSocket fleet.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick start

```typescript
import { Realtime } from '@aws-cdk-blocks/bb-realtime';
import { z } from 'zod';

const rt = new Realtime(scope, 'collab', {
  namespaces: {
    cursors: Realtime.namespace(z.object({ userId: z.string(), x: z.number(), y: z.number() })),
    chat: Realtime.namespace(z.object({ sender: z.string(), text: z.string() })),
  },
});
```

## API

`new Realtime(scope, id, options)`. The methods take a namespace name, type-checked against the `namespaces` option:

| Method | Returns | Description |
|--------|---------|-------------|
| `rt.publish(namespace, channel, data)` | `Promise<void>` | Broadcast data to all subscribers (best-effort). Validates against schema. |
| `rt.getChannel(namespace, channel, { scope?, principal? })` | `Promise<RealtimeChannel<T>>` | Returns a subscribe-only channel handle to return from an API method. `scope` is `'subtree'` (default) or `'exact'`: see [Sub-channels and access](#sub-channels-and-access). `principal` is the user id the handle belongs to: see [Binding a handle to a user](#binding-a-handle-to-a-user). |
| `rt.revokeAccess(principal)` | `Promise<void>` | Revokes the principal's existing handles. For delivery and notification timing, see [Binding a handle to a user](#binding-a-handle-to-a-user). |
| `rt.subscribe(namespace, channel, handler)` | `() => void` | Server-side subscribe. Returns unsubscribe function. |

**Runtime only.** Call `publish`, `subscribe`, `getChannel` and `revokeAccess` inside an `ApiNamespace` method, `RawRoute` handler, job handler, or a runtime script, **not** at the top level of your `cdk-blocks/index.ts`.

- Top-level code runs during CDK synth, where a call throws an `Error` reading `Realtime.<method>() cannot be called during CDK synth. Data methods run at request time — …`.
- Constructing the block at module scope is fine.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `namespaces` | `Record<string, NamespaceConfig>` | (required) | Namespace name to `Realtime.namespace(schema)`. The schema (any StandardSchemaV1: Zod, Valibot, etc.) gives the message type and validates `data` on every `publish()`. |
| `logger` | `ChildLogger` | — | Accepted, but does not redirect delivery warnings. The AWS runtime writes those warnings to the console. |

### Channel handle

`RealtimeChannel<T>`, the subscribe-only handle `getChannel()` resolves to. It serializes via `toJSON()` for client transfer:

| Method | Returns | Description |
|--------|---------|-------------|
| `subscribe(handler)` | `RealtimeSubscription` | Listen for messages (simple form). |
| `subscribe({ onMessage, onDisconnect?, onReconnect?, refresh? })` | `RealtimeSubscription` | Listen for messages with disconnect + reconnect handling (and optional token re-minting on reconnect via `refresh`). |
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

## Channel names

Channel names are scoped by the Realtime instance and namespace: `{fullId}/{namespace}/{channel}`. The `channel` argument you pass to `publish()`, `subscribe()`, and `getChannel()` is the user-facing portion.

- `/` separates segments (`tenants/acme/billing`). There is no limit on the number of segments or on segment length.
- `publish()`, `subscribe()` and `getChannel()` throw `ValidationFailedException` for a channel name that is empty, starts or ends with `/`, contains an empty segment (`a//b`), or has a `.` or `..` segment.
- They throw the same error for a `channel` that isn't a string (`undefined`, `null`, an object). A number is accepted and validated as its string form.
- Any other characters are allowed.
- The full channel path (including the `{fullId}/{namespace}/` prefix) must fit in 1024 bytes. A longer path throws `ValidationFailedException`, in local dev and on AWS.
- The full path is stored with every subscription and sent in every message, and API Gateway meters messages in 32 KB increments. Use short identifiers: `room-123`, `user-456`, `game-abc`.

### Sub-channels and access

The token inside a channel handle decides which channels a client can subscribe to with it:

| `getChannel()` call | Token authorizes |
|---------------------|------------------|
| `rt.getChannel('events', 'tenants/acme')` (default, `scope: 'subtree'`) | `tenants/acme` **and every channel under it**: `tenants/acme/billing`, `tenants/acme/x/y`, … |
| `rt.getChannel('events', 'tenants/acme', { scope: 'exact' })` | `tenants/acme` only |

So giving a client a handle for a channel is an access decision for that channel's whole subtree. The match is by `/`-separated segment, not by string prefix: a handle for `tenants/acme` never opens `tenants/acme-corp`.

**The pitfall:** the default is wrong for nested names that belong to different principals. Say each tenant gets `tenants/<tenantId>` and each user gets `tenants/<tenantId>/users/<userId>`. With the default scope, a tenant-wide handle given to any member of `acme` also lets that member subscribe to every user's channel under `tenants/acme/users/`. To prevent it:

- Use `{ scope: 'exact' }` for the tenant-wide handle, or keep per-principal channels out of each other's subtrees (for example `tenant-users/<tenantId>/<userId>` beside `tenants/<tenantId>`).
- Keep user-supplied ids from adding segments: `encodeURIComponent(id)` encodes `/`.

```typescript
async getTenantFeed(tenantId: string) {
  const user = await auth.requireAuth(context);
  if (!isMember(user, tenantId)) throw new Error('Forbidden');
  return rt.getChannel('events', `tenants/${encodeURIComponent(tenantId)}`, { scope: 'exact' });
},
```

Use the default `'subtree'` only when a client that may read a channel may read everything under it.

### Binding a handle to a user

A handle's tokens are bearer credentials: whoever holds them can subscribe until they expire. Pass `principal` (the signed-in user's id, at most 256 characters) so the tokens are tied to that user:

```typescript
return rt.getChannel('chat', roomId, { principal: user.userSub });
```

What `principal` does:

- The id is signed into the handle's connect token and channel token. The server accepts a channel token only on a connection opened with a connect token for the same user, so a channel token cannot be used on a connection opened for another user or for no user.
- The handle as a whole (both tokens) is still a bearer credential until it expires or `revokeAccess()` is called. Whoever holds it can open a connection and subscribe, and the same handle can be used on several sockets. Treat it like a session token.
- A handle without a `principal` works for any holder and cannot be revoked.
- A connection belongs to one user. The client keeps one socket per Realtime endpoint and user, so handles for different users (or a user's handle and an unbound one) on one page each use their own socket, and signing in as someone else on the same page needs no reload.

When access ends:

- On AWS, publish checks channel-token expiry before delivery. The local WebSocket server checks expiry on a keep-alive ping, not on publish.
- The deployed client sends a keep-alive ping about every 9 minutes. The server re-checks open subscriptions on each ping. An ended subscription reports `onDisconnect('error')`, except an expired one on a channel subscribed with `refresh`, which renews in place (see [Outliving the token TTLs with `refresh`](#outliving-the-token-ttls-with-refresh)).
- During an in-place renewal, messages published between the server ending the subscription and the renewal completing (one API round trip, about once an hour per channel) are not delivered to that channel.
- Pass `refresh` for subscriptions that should outlive the 1-hour channel token.

`revokeAccess()`:

- `await rt.revokeAccess(user.userSub)` ends a user's access, for example on sign-out, a role change or a removed account.
- Handles minted for that user before the call are refused on connect and subscribe right away. A handle minted in the same second as the call counts as older.
- On AWS, publish checks revocation using an eventually consistent read. An already-open subscription can still receive a message just after revocation; the client learns that access ended when a keep-alive ping observes it. The local dev server ends affected subscriptions immediately.
- AWS stores each user's revocation record in the existing connections table with a TTL of 2 hours and 5 minutes, long enough for all previously issued tokens to expire.
- A handle minted after the call works, so also make your `refresh` endpoint refuse that user.

### Rate limits

API Gateway throttles the WebSocket stage in messages per second (the stack-wide `throttling` default), shared by all connections on the stage. It has no per-connection limit, and Realtime does not add one, so a single connection can use up to the stage rate. Keep client-sent frames to what the client library sends (subscribe, unsubscribe, ping).

## Errors

```typescript
import { isBlocksError, RealtimeErrors } from 'aws-cdk-blocks';

try {
  await rt.publish('chat', 'room-1', { sender: 123 }); // wrong type
} catch (e: unknown) {
  if (isBlocksError(e, RealtimeErrors.ValidationFailed)) {
    // data failed schema validation
  }
}
```

| Constant | `error.name` | Thrown when |
|----------|--------------|-------------|
| `RealtimeErrors.ValidationFailed` | `ValidationFailedException` | `publish()`: `data` fails the namespace schema, or the message exceeds 128 KiB. `publish()`, `subscribe()`, `getChannel()`: an invalid channel name or a channel path over 1024 bytes. `getChannel()`: a `scope` other than `'exact'` or `'subtree'`, or an invalid `principal`. `revokeAccess()`: a missing or invalid `principal`. |
| `RealtimeErrors.ConnectionFailed` | `ConnectionFailedException` | The server refuses a subscribe, or the deployed client exhausts its connection retries while `sub.established` is pending. `getChannel()` also throws it on AWS when the token signing secret is unavailable. |
| `RealtimeErrors.PublishFailed` | `PublishFailedException` | AWS only: the WebSocket callback URL or the connections table is not available to the running code. A failed delivery to one connection is logged, not thrown. |
| `RealtimeErrors.UnsupportedCompute` | `UnsupportedComputeException` | Synth time: the backend's default compute is not Lambda. |

A namespace name that is not in `namespaces` throws an error named `InvalidNamespace`.

## Delivery guarantees

- **Subscribe before you publish.** Realtime has no message buffering (local dev and AWS alike): a subscriber only receives messages published *after* its subscription registers (await `sub.established`).
- If a server-side publisher (e.g. an AsyncJob or Agent stream) may fire before the client subscribes, the client must subscribe first, then trigger the publisher, and backfill any earlier messages from a durable source (DB/history).
- **Delivery is best-effort.** `publish()` sends to all connected subscribers in parallel. If delivery to an individual connection fails, the failure is logged and the rest continue. Stale connections are cleaned up automatically.
- **`publish()` awaits delivery to all subscribers before returning.** For channels with tens of subscribers, this adds negligible latency. For larger audiences, publish from an `AsyncJob` so the API response isn't blocked.
- **Above 10K subscribers** a single Lambda invocation hits API Gateway TPS limits (~10K default): shard the fan-out across several `AsyncJob` invocations. [USE-CASES.md](./USE-CASES.md) shows both patterns.
- **Message size:** at most 128 KiB (131,072 bytes) per published message, including the wire envelope.

## Disconnects and reconnects

API Gateway closes a WebSocket after 2 hours, or after 10 minutes idle, so a long-lived subscription is dropped and re-established over its lifetime. On an unexpected drop the client reconnects with exponential backoff and resubscribes every active channel with its stored token. A keep-alive ping about every 9 minutes avoids the idle timeout.

Use the options form of `subscribe()` to observe the lifecycle:

```typescript
const sub = channel.subscribe({
  onMessage: (msg) => { console.log(msg); },
  onDisconnect: (reason) => {
    // reason: 'client' | 'timeout' | 'error' | 'unknown'
    // Fires on EVERY drop (not just the first). Filter out 'client' (your own unsubscribe()).
    if (reason === 'client') return;
  },
  onReconnect: () => {
    // Fires once after the transport has reconnected AND the server has re-confirmed
    // the resubscribe (after the corresponding onDisconnect). Backfill any messages
    // missed during the gap here — WebSocket pub/sub is not durable, so re-read your
    // authoritative store (e.g. the conversation/record) rather than trusting the channel.
  },
});
```

If the stored channel token has expired or the user's access was revoked, the server can reject the resubscribe and the client reports `onDisconnect('error')`. A reconnect can also fail before resubscription: without `refresh`, the client reuses its stored connect token, which expires after 2 hours. After five failed reconnect attempts, the client gives up and reports a final `onDisconnect('error')`.
Without a `refresh` callback, re-fetch the channel from your API and subscribe again if the user still has access.

### Outliving the token TTLs with `refresh`

To keep a subscription alive past the token TTLs **without** hand-rolling re-subscription, pass
a `refresh` callback:

```typescript
const sub = channel.subscribe({
  onMessage: (msg) => { console.log(msg); },
  // Called before EACH reconnect to re-mint a fresh descriptor (new connect + channel
  // token), so the subscription outlives the channel (~1h) / connect (~2h) token TTLs.
  // Return the RAW descriptor (the wire object with `__blocks`/token fields), e.g. your
  // server's `channel.toJSON()` with `__blocks` stripped, then re-add the discriminant.
  refresh: async () => ({ ...(await fetchFreshDescriptor()), __blocks: 'realtime/channel' }),
});
```

- `refresh: () => Promise<RealtimeChannelDescriptor>` runs before the socket is reopened on each reconnect, once for each channel on the connection.
- A `refresh` that rejects or takes longer than 15 seconds falls back to the stored token if another channel refreshed successfully. If none did, the client retries with backoff and fires `onDisconnect('error')` for each failed attempt (up to five). Only the deployed client fires a final `'error'` when it gives up.
- The server method behind `refresh` re-issues a channel token, so it must apply the same authorization as the method that issued the original channel.
- `refresh` also renews a live subscription in place. The server re-checks open subscriptions on every keep-alive ping and ends one whose channel token has expired; a channel with `refresh` then calls it and subscribes again on the same socket, with no `onDisconnect` and no `onReconnect`.
- A channel without `refresh`, or whose `refresh` fails, gets `onDisconnect('error')`.
- A subscription ended because access was revoked is not renewed.

## Examples

### Server-side publish via API

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async sendMessage(roomId: string, text: string) {
    const user = await auth.requireAuth(context);
    if (!await canWriteRoom(user, roomId)) throw new Error('Forbidden');
    await rt.publish('chat', roomId, { sender: user.userSub, text });
    return { sent: true };
  },
}));
```

### Returning a channel handle (authorization gate)

Authorization happens in your API method — the channel handle is only returned if the user is allowed:

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async joinRoom(roomId: string) {
    const user = await auth.requireAuth(context);
    if (!await canAccessRoom(user, roomId)) throw new Error('Forbidden');
    return rt.getChannel('chat', roomId, { scope: 'exact', principal: user.userSub });
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

### Server-side subscribe

In a trusted server-side worker, subscribe for the duration of the work and close the subscription before the worker exits:

```typescript
async function monitorRoom(roomId: string) {
  const ch = await rt.getChannel('chat', roomId);
  const sub = ch.subscribe((msg) => console.log(`[${roomId}] ${msg.sender}: ${msg.text}`));
  try {
    await sub.established;
    await runRoomWorker(roomId);
  } finally {
    sub.unsubscribe();
  }
}
```

On AWS, server-side subscribe uses a real WebSocket connection, so it receives messages regardless of which Lambda invocation published them. Locally, it uses an in-process EventEmitter.

### Handling auth failures

If a channel's token is invalid, expired, bound to a different user, or revoked, `established` rejects:

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

## Best practices

- **Use channels for dynamic scoping** — `room-123`, `user-456`, `game-abc`. One namespace, many channels.
- **Unsubscribe when done** — especially in components that mount/unmount. Leaked subscriptions hold the WebSocket open.

## Scaling and cost (AWS)

Cost scales linearly with messages delivered. The API Gateway message fee dominates. Prices are for US East.

### Per-Publish Cost (to N subscribers)

| Operation | Cost |
|-----------|------|
| DynamoDB: query GSI for subscriber list | ~$0.0000001 (negligible) |
| API Gateway: deliver message × N | N × $0.000001 |
| **Total per publish** | **≈ N × $0.000001** |

The publish call itself is a Lambda invocation, not a WebSocket message — no API Gateway charge for the inbound side.

### Connection Cost

| Component | Rate |
|-----------|------|
| Connection-minutes | $0.25 per million |
| Keep-alive pings (~7/hr) | ~$0.000005/hr (DynamoDB reads + writes) |
| **Per connection-hour** | **~$0.00002** |

1,000 connections online 24/7 ≈ $18/month. 10,000 connections × 8 hrs/day ≈ $48/month.

### Publish Latency

`publish()` delivers messages in parallel, limited by the SDK's HTTP connection pool (50 concurrent sockets by default). Each `postToConnection` takes ~5-10ms with TCP keep-alive within the same region: about 100-200ms per 1,000 subscribers.

The AWS SDK retries throttled requests automatically (3 retries with exponential backoff).

### Limits

| Limit | Value | Enforced | Notes |
|---|---|---|---|
| Channel path (full) | 1024 bytes | Yes — both local and AWS | DynamoDB sort key limit. Includes `{fullId}/{namespace}/` prefix. |
| Message size (published) | 128 KiB (131,072 bytes) | Yes — both local and AWS | API Gateway WebSocket *logical message* limit (frames are reassembled; the 32 KB quota is a per-frame limit, not a per-message one). Includes wire envelope. |
| Max connection duration | 2 hours | No — API Gateway hard limit | Transparent reconnect; use `refresh` to outlive it |
| Idle timeout | 10 minutes | No — API Gateway hard limit | Client middleware sends keep-alive pings |
| Account-level API TPS | 10,000/sec | No — API Gateway hard limit | Shared across all API Gateway usage; raisable |
| New connections | 500/sec | No — API Gateway hard limit | Per account per region; raisable |

## Local development

In local dev (`npm run dev`), Realtime uses an in-process EventEmitter with a WebSocket bridge to browser clients. Schema validation runs identically to AWS, and a subscribe with an invalid token is rejected.

The local client does not send periodic keep-alive pings, so a live subscription does not automatically renew when its token expires. If the local server is unreachable, `established` can remain pending after the retry limit.

Messages are ephemeral — no persistence across restarts.

## See also

- [USE-CASES.md](./USE-CASES.md) — Common use cases, scaling patterns, and industry examples
