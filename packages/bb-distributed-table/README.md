# DistributedTable

Structured data storage backed by DynamoDB with secondary indexes and rich query capabilities.

**When to use:** You need to query by multiple fields, use composite keys, or perform sort-key-based range queries. Good for entities with relationships, time-series data, and access patterns that require multiple indexes.

**When NOT to use:** If you only need single-key lookups, use `KVStore`. If you need full SQL (joins, aggregations), use `Database`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## API

```typescript
const table = new DistributedTable(scope, id, options)
```

> **Type inference (important):** Do **not** pass a single explicit type argument like `new DistributedTable<MyType>(...)`. Doing so pins only `T` and lets the key/index generics fall back to their broad defaults, which breaks key-type inference — `get()` and `query({ where })` will then demand *every* field of the type instead of just the key fields. Either let all generics infer (`new DistributedTable(scope, id, { schema, key, indexes })` with no explicit `<...>`), or pass all three generics. Note that `as const` alone does **not** fix it.

| Method | Returns | Description |
|--------|---------|-------------|
| `get(key)` | `Promise<T \| null>` | Retrieve a single item by primary key. |
| `put(item, options?)` | `Promise<void>` | Store an item. Overwrites unless conditions are set. |
| `delete(key, options?)` | `Promise<void>` | Remove an item by primary key. |
| `query(options)` | `AsyncIterable<T>` | Query items by index or primary key. |
| `scan(options?)` | `AsyncIterable<T>` | Enumerate all items. Expensive on large datasets. |
| `getBatch(keys)` | `Promise<(T \| null)[]>` | Retrieve multiple items by key. |
| `putBatch(items)` | `Promise<void>` | Store multiple items. |
| `deleteBatch(keys)` | `Promise<void>` | Remove multiple items by key. |
| `DistributedTable.fromExisting(tableName)` | `ExternalTableRef` | Wrap a pre-existing DynamoDB table. |

**Runtime only.** Data methods (`get`, `put`, `delete`, `query`, `scan`, `getBatch`, `putBatch`, `deleteBatch`) run at request time — call them inside an `ApiNamespace` method, `RawRoute` handler, job handler, or a runtime script, **not** at the top level of your `aws-blocks/index.ts`. Top-level code runs during CDK synth, where the block resolves to its infrastructure construct (no data methods), so a top-level call throws `table.<method> is not a function` (throws `TypeError` at runtime if called during CDK synth). To seed data, do it from inside a handler or a separate runtime script. Constructing the block at module scope is fine; only method calls must move into handlers.

> **Collecting `scan()` results:** like `query()`, `scan()` returns an `AsyncIterable` — collect with `await Array.fromAsync(table.scan())` or iterate with `for await`. Prefer `query()` over `scan()` (scans read every item).

### Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `schema` | `StandardSchemaV1` | Yes | Runtime validation schema (Zod, Valibot, ArkType, etc.). Type `T` is inferred from the schema. |
| `key` | `TableKeyConfig<T>` | Yes | Primary key configuration: `{ partitionKey, sortKey? }`. Field names must exist in the schema. |
| `indexes` | `Record<string, TableKeyConfig<T>>` | No | Global secondary index definitions. |
| `ttl` | `keyof T & string` | No | Enable DynamoDB TTL on the specified attribute. The field should contain a Unix epoch timestamp in seconds. |
| `table` | `ExternalTableRef` | No | Wrap an existing DynamoDB table instead of creating one. |
| `logger` | `ChildLogger` | No | Optional logger for internal operations. When omitted, a default Logger at error level is created. |

### Key Object Pattern

All methods that accept a key (`get`, `delete`, `getBatch`, `deleteBatch`) take a key object with the partition key field (and sort key field if defined). The key type is computed from your schema and key configuration — TypeScript enforces exactly the right fields:

```typescript
// Table with partition key + sort key
const orders = new DistributedTable(scope, 'orders', {
  schema: orderSchema,
  key: { partitionKey: 'userId', sortKey: 'orderId' },
});

// Key object requires both fields
await orders.get({ userId: 'alice', orderId: '001' });

// Table with partition key only
const settings = new DistributedTable(scope, 'settings', {
  schema: settingsSchema,
  key: { partitionKey: 'settingId' },
});

// Key object requires only the partition key
await settings.get({ settingId: 'theme' });
```

### Query

`query()` takes a single options object. Specify `index` to query a GSI, or omit it to query the primary key. The `where` clause is type-safe — field names and condition types are computed from the index (or primary key) definition.

```typescript
// Query a GSI
for await (const order of orders.query({
  index: 'byStatus',
  where: { status: { equals: 'pending' } },
  limit: 10,
  order: 'desc',
})) {
  console.log(order);
}

// Query the primary key (omit index)
for await (const order of orders.query({
  where: { userId: { equals: 'alice' }, orderId: { beginsWith: '2024-' } },
})) {
  console.log(order);
}
```

> **Tip:** When collecting all results into an array, use `Array.fromAsync()` instead of a manual loop:
> ```typescript
> const pending = await Array.fromAsync(orders.query({
>   index: 'byStatus',
>   where: { status: { equals: 'pending' } },
> }));
> ```

**Query options:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `index` | `keyof Indexes` | No | GSI to query. Omit to query the primary key. |
| `where` | `KeyCondition<T, K>` | Yes | Key conditions. Partition key requires `{ equals }`. Sort key supports `equals`, `greaterThan`, `lessThan`, `between`, `beginsWith`, etc. |
| `limit` | `number` | No | Maximum number of items to return. |
| `order` | `'asc' \| 'desc'` | No | Sort direction on the sort key. Defaults to `'asc'`. |

### Conditional Operations

Both `put` and `delete` accept optional conditions:

```typescript
// Only write if key doesn't exist (idempotent create)
await table.put(item, { ifNotExists: true });

// Only write if existing item's field matches (optimistic locking)
await table.put(updatedItem, { ifFieldEquals: { version: 3 } });

// Only delete if item exists
await table.delete(key, { ifExists: true });

// Only delete if field matches
await table.delete(key, { ifFieldEquals: { status: 'archived' } });
```

All condition failures throw with `error.name === DistributedTableErrors.ConditionalCheckFailed`.

> **No partial update:** There is no `update()` or `patch()` method. To change a field, do a read-modify-write — `get()` the item, mutate it, then `put()` the full item back. For safe concurrent updates, pass `{ ifFieldEquals: { version: <previous> } }` to `put()` so the write fails (via `ConditionalCheckFailed`) if another writer changed the item in the meantime (optimistic locking).

### Error Handling

Errors thrown by DistributedTable carry an `error.name` you can match with `isBlocksError`:

| Constant | `error.name` | Thrown when |
|----------|--------------|-------------|
| `DistributedTableErrors.ConditionalCheckFailed` | `ConditionalCheckFailedException` | An `ifNotExists` / `ifExists` / `ifFieldEquals` condition failed. |
| `DistributedTableErrors.ValidationFailed` | `ValidationFailedException` | An item failed the configured `schema` validation on `put()` / `putBatch()`. |
| `DistributedTableErrors.InvalidQuery` | `InvalidQueryException` | The query/condition shape is wrong: missing `where`, partition key not given as `{ equals }`, unknown index, multiple sort-key conditions, or an empty `ifFieldEquals`. A caller bug. |
| `DistributedTableErrors.ItemTooLarge` | `ItemTooLargeException` | A `put`/`putBatch` item exceeds DynamoDB's 400 KB per-item size limit. |
| `DistributedTableErrors.BatchIncomplete` | `BatchIncompleteException` | A batch op left entries unprocessed after the retry budget (sustained throttling). AWS runtime only. |

```typescript
import { isBlocksError } from '@aws-blocks/core';
import { DistributedTableErrors } from '@aws-blocks/bb-distributed-table';

try {
  await table.put(item, { ifNotExists: true });
} catch (e: unknown) {
  if (isBlocksError(e, DistributedTableErrors.ConditionalCheckFailed)) {
    // item already exists
  }
  if (isBlocksError(e, DistributedTableErrors.ItemTooLarge)) {
    // item > 400 KB — split it or store a reference instead
  }
  throw e;
}
```

## Examples

### Basic CRUD

> The examples use Zod, but `schema` accepts any StandardSchemaV1 implementation (Zod, Valibot, ArkType). Install your chosen library, e.g. `npm install zod`.

```typescript
import { z } from 'zod';

const orderSchema = z.object({
  userId: z.string(),
  orderId: z.string(),
  total: z.number(),
  status: z.string(),
  createdAt: z.number(),
});

const orders = new DistributedTable(scope, 'orders', {
  schema: orderSchema,
  key: { partitionKey: 'userId', sortKey: 'orderId' },
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getOrder(userId: string, orderId: string) {
    return await orders.get({ userId, orderId });
  },
  async createOrder(order: z.infer<typeof orderSchema>) {
    await orders.put(order, { ifNotExists: true });
  },
  async deleteOrder(userId: string, orderId: string) {
    await orders.delete({ userId, orderId });
  },
}));
```

### Query with Sort Key Conditions

```typescript
const orders = new DistributedTable(scope, 'orders', {
  schema: orderSchema,
  key: { partitionKey: 'userId', sortKey: 'orderId' },
  indexes: {
    byDate: { partitionKey: 'userId', sortKey: 'createdAt' },
  },
});

// Ctrl+Space on the where object shows: userId, createdAt
// userId requires { equals }, createdAt supports greaterThan, between, etc.
const results = [];
for await (const order of orders.query({
  index: 'byDate',
  where: {
    userId: { equals: 'alice' },
    createdAt: { greaterThan: Date.now() - 86400000 },
  },
})) {
  results.push(order);
}
```

### TTL (Auto-Expiring Items)

```typescript
const sessions = new DistributedTable(scope, 'sessions', {
  schema: sessionSchema,
  key: { partitionKey: 'sessionId' },
  ttl: 'expiresAt',
});

// DynamoDB automatically deletes items after the TTL timestamp
await sessions.put({
  sessionId: 'abc123',
  userId: 'alice',
  expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
});
```

### Batch Operations

```typescript
// Write many items
await orders.putBatch([order1, order2, order3]);

// Read many items
const items = await orders.getBatch([
  { userId: 'alice', orderId: '001' },
  { userId: 'bob', orderId: '002' },
]);

// Delete many items
await orders.deleteBatch([
  { userId: 'alice', orderId: '001' },
  { userId: 'bob', orderId: '002' },
]);
```

### Wrapping an Existing Table

```typescript
const legacy = new DistributedTable(scope, 'legacy', {
  schema: orderSchema,
  key: { partitionKey: 'userId', sortKey: 'orderId' },
  table: DistributedTable.fromExisting('my-existing-table'),
});
```

## Best Practices

- Design partition keys for even data distribution (e.g., `userId`, `tenantId`)
- Use sort keys for range queries (e.g., timestamps, alphabetical ordering)
- Define GSIs upfront for known access patterns — adding them later requires backfill
- Use `{ ifNotExists: true }` for idempotent creates
- Use `{ ifFieldEquals }` for optimistic locking when multiple writers are possible
- Prefer `query()` over `scan()` — scans read every item and are expensive

## Scaling & Cost (AWS)

- **Billing:** PAY_PER_REQUEST — no provisioned capacity to manage
- **Latency:** Single-digit ms reads and writes
- **Throughput:** Scales automatically, no upper limit on table size
- **Item size limit:** 400 KB per item
- **GSI limit:** Up to 20 global secondary indexes per table
- **Cost:** ~$1.25 per million writes, ~$0.25 per million reads
- **Durability:** 99.999999999% (11 nines) across 3 AZs

## Local Development

Mock data persists to disk at `.bb-data/{fullId}/` across dev server restarts. Wipe with `rm -rf .bb-data`. The mock validates the 400 KB item size limit, schema validation, and conditional check failures, matching AWS behavior. Index queries are implemented via in-memory filtering — correctness is preserved but performance characteristics differ from DynamoDB.



