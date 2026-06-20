# @aws-blocks/bb-event-bus

Server-to-server publish/subscribe event bus backed by Amazon EventBridge.

Publish a typed event once and the bus fans it out to every subscriber — decoupling the code that produces an event from the (possibly many) reactions to it.

## Quick Reference

**Common Operations → API**

| What you want | How |
|---------------|-----|
| Subscribe a handler | `bus.on('order.placed', async (detail, ctx) => { ... })` |
| Subscribe to every event | `bus.on('*', async (detail, ctx) => { ... })` |
| Publish an event | `await bus.publish('order.placed', { id })` |
| Validate delivered events | `bus.on('order.placed', handler, { schema })` |
| Make events type-safe | `new EventBus<MyEventMap>(scope, 'events')` |

**Keywords:** events, pub/sub, publish, subscribe, fan-out, EventBridge, event-driven, decouple, message bus, domain events

## Quick Start

```typescript
import { Scope } from '@aws-blocks/core';
import { EventBus } from '@aws-blocks/bb-event-bus';

const scope = new Scope('my-app');

const bus = new EventBus(scope, 'events');

// One event, many independent reactions:
bus.on('order.placed', async (detail: { id: string }) => {
  await chargeCard(detail.id);
});
bus.on('order.placed', async (detail: { id: string }) => {
  await sendReceipt(detail.id);
});

// Producer doesn't know or care who listens:
await bus.publish('order.placed', { id: 'o_123' });
```

## When to Use

- **Decouple producers from consumers.** A producer emits `user.signed-up`; an
  arbitrary set of features (welcome email, analytics, provisioning) react
  without the producer importing any of them.
- **Fan-out.** One event needs to trigger several independent side effects.
- **Event-driven architecture.** Model your domain as a stream of past-tense
  facts (`invoice.paid`, `file.uploaded`) that other parts of the system observe.

## When NOT to Use

- **Single-consumer work queue** with retries and a dead-letter queue → use
  [`AsyncJob`](../bb-async-job).
- **Scheduled / recurring work** → use [`CronJob`](../bb-cron-job).
- **Pushing messages to connected browser clients** → use
  [`Realtime`](../bb-realtime). (A common pattern: a subscriber on the bus calls
  `realtime.publish(...)` to forward an event to the UI.)

## API

### `new EventBus<TEvents>(scope, id, options?)`

| Option | Type | Description |
|--------|------|-------------|
| `logger` | `ChildLogger` | Optional logger for internal operations. |

`TEvents` is an optional [event map](#type-safety) for end-to-end type safety.

### `bus.on(type, handler, options?)`

Subscribe `handler` to `type`. Pass `'*'` to receive every event on the bus.
Returns `this`, so calls chain. The handler receives `(detail, context)`:

| Context field | Description |
|---------------|-------------|
| `eventId` | Unique id for the delivered event. |
| `type` | The published event type. |
| `source` | The publishing bus's fully-qualified id. |
| `publishedAt` | ISO 8601 publish timestamp. |

`options.schema` — an optional [Standard Schema](https://standardschema.dev)
(Zod, Valibot, ArkType, …) validating each delivered detail before the handler
runs. On failure the event is dropped and the error logged.

### `bus.publish(type, detail)`

Publish an event. Resolves to `{ eventId }` once the bus accepts it — delivery
to subscribers is asynchronous. `type` must be a non-empty string and cannot be
the reserved `'*'`.

## Type Safety

Pass an event map to type both `publish` and `on`:

```typescript
interface ShopEvents {
  'order.placed': { id: string; total: number };
  'order.shipped': { id: string; carrier: string };
}

const bus = new EventBus<ShopEvents>(scope, 'shop');

await bus.publish('order.placed', { id: 'o_1', total: 42 }); // ✅
await bus.publish('order.placed', { id: 'o_1' });            // ✗ missing `total`
bus.on('order.shipped', async (detail) => detail.carrier);   // detail is typed
```

## Error Constants

```typescript
import { EventBusErrors } from '@aws-blocks/bb-event-bus';
```

| Constant | When |
|----------|------|
| `EventBusErrors.InvalidEventType` | Published type is empty or `'*'`. |
| `EventBusErrors.PayloadTooLarge` | Serialized detail exceeds 256 KB. |
| `EventBusErrors.ValidationFailed` | A subscription's schema rejects a detail. |
| `EventBusErrors.MissingBusConfig` | Bus name env var is absent (AWS, pre-deploy). |
| `EventBusErrors.PublishFailed` | EventBridge rejected the event (AWS). |

## Examples

### Forwarding a domain event to the browser via Realtime

```typescript
const bus = new EventBus(scope, 'events');
const realtime = new Realtime(scope, 'live');

bus.on('order.shipped', async (detail: { id: string }) => {
  await realtime.publish(`orders/${detail.id}`, { status: 'shipped' });
});
```

### Triggering background work from an event

```typescript
const bus = new EventBus(scope, 'events');
const thumbnails = new AsyncJob(scope, 'thumbnails', {
  handler: async (payload: { key: string }) => generateThumbnail(payload.key),
});

bus.on('file.uploaded', async (detail: { key: string }) => {
  await thumbnails.submit({ key: detail.key });
});
```

### Validating delivered events

```typescript
import { z } from 'zod';

const OrderPlaced = z.object({ id: z.string(), total: z.number().positive() });

bus.on('order.placed', async (detail) => {
  // detail is validated before we get here
}, { schema: OrderPlaced });
```

## Best Practices

- Name events as **past-tense facts** (`user.signed-up`), not commands.
- Keep details **small** (< 256 KB) — pass an id and let subscribers fetch the rest.
- Make subscribers **idempotent**; EventBridge may redeliver an event.
- Treat subscribers as **independent** — one throwing does not affect the others.

## Local Development

`npm run dev` uses an in-process implementation: `publish()` dispatches to every
matching `on()` handler on a microtask, so behavior matches AWS without an AWS
account. Inspect counters via `bus._stats` (`published`, `delivered`, `failed`,
`subscriptions`).

## AWS Deployment

Each `EventBus` provisions a dedicated Amazon EventBridge custom bus. Every
`on()` subscription becomes an EventBridge rule that targets the shared Blocks
Lambda; a rule input transformer tags the event with a deterministic
subscription id so the runtime routes it to the right handler. `publish()` calls
EventBridge `PutEvents`. The application Lambda is granted `events:PutEvents` on
the bus automatically.

## Key Distinction from AsyncJob

| | `EventBus` | `AsyncJob` |
|---|---|---|
| Topology | 1 event → **N** subscribers (fan-out) | 1 message → **1** handler |
| Backing | EventBridge | SQS + Lambda |
| Retries / DLQ | EventBridge retry policy | Built-in retries + dead-letter queue |
| Use for | Reacting to domain events | Offloading a unit of work |
