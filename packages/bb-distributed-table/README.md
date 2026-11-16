# DistributedTable

Structured data storage backed by DynamoDB with secondary indexes and rich query capabilities.

**When to use:** You need to query by multiple fields, use composite keys, or perform sort-key-based range queries. Good for entities with relationships, time-series data, and access patterns that require multiple indexes.

**When NOT to use:** If you only need single-key lookups, use `KVStore`. If you need full SQL (joins, aggregations), use `Database`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

> Production settings (scaling & cost, durability, deletion protection, encryption): [PRODUCTION.md](./PRODUCTION.md)

## API

```typescript
const table = new DistributedTable(scope, id, options)
```

> **Type inference (important):** Do **not** pass a single explicit type argument like `new DistributedTable<MyType>(...)`. Doing so pins only `T` and lets the key/index generics fall back to their broad defaults, which breaks key-type inference — `get()` and `query({ where })` will then demand *every* field of the type instead of just the key fields. Either let all generics infer (`new DistributedTable(scope, id, { schema, key, indexes })` with no explicit `<...>`), or pass all three generics. Note that `as const` alone does **not** fix it.

| Method | Returns | Description |
|--------|---------|-------------|
| `get(key, options?)` | `Promise<T \| null>` | Retrieve a single item by primary key. The key is an object with every key field (`get({ userId, orderId })`, not `get(userId)`). Pass `{ consistentRead: true }` for a strongly consistent read. |
| `put(item, options?)` | `Promise<void>` | Store an item. Overwrites unless conditions are set. |
| `delete(key, options?)` | `Promise<void>` | Remove an item by primary key. |
| `query(options)` | `AsyncIterable<T>` | Query items by index or primary key. |
| `scan(options?)` | `AsyncIterable<T>` | Enumerate all items. Expensive on large datasets. |
| `getBatch(keys)` | `Promise<(T \| null)[]>` | Retrieve multiple items by key. |
| `putBatch(items)` | `Promise<void>` | Store multiple items. |
| `deleteBatch(keys)` | `Promise<void>` | Remove multiple items by key. |
| `DistributedTable.fromExisting(tableName)` | `ExternalTableRef` | Wrap a pre-existing DynamoDB table. |

**Runtime only.** Data methods (`get`, `put`, `delete`, `query`, `scan`, `getBatch`, `putBatch`, `deleteBatch`) run at request time — call them inside an `ApiNamespace` method, `RawRoute` handler, job handler, or a runtime script, **not** at the top level of your `aws-blocks/index.ts`. Top-level code runs during CDK synth, where the block resolves to its infrastructure construct, whose data methods are guards: a top-level call throws an `Error` reading `DistributedTable.<method>() cannot be called during CDK synth. Data methods run at request time — …`. To seed data, do it from inside a handler or a separate runtime script. Constructing the block at module scope is fine; only method calls must move into handlers.

> **Collecting `scan()` results:** like `query()`, `scan()` returns an `AsyncIterable` — collect with `await Array.fromAsync(table.scan())` or iterate with `for await`. Prefer `query()` over `scan()` (scans read every item).

### Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `schema` | `StandardSchemaV1` | Yes | Runtime validation schema (Zod, Valibot, ArkType, etc.). Type `T` is inferred from the schema. |
| `key` | `TableKeyConfig<T>` | Yes | Primary key configuration: `{ partitionKey, sortKey? }`. Field names must exist in the schema. |
| `indexes` | `Record<string, TableKeyConfig<T>>` | No | Global secondary index definitions, as an object keyed by index name (`{ byStatus: { partitionKey: 'status' } }`), not an array. |
| `ttl` | `keyof T & string` | No | Enable DynamoDB TTL on the specified attribute. The field should contain a Unix epoch timestamp in seconds. |
| `pointInTimeRecovery` | `boolean \| { retentionDays: number }` | No | Point-in-Time Recovery (continuous backups). `true` = on with the default 35-day window; `false` = off; `{ retentionDays: n }` = on with an `n`-day window (**1–35**). Defaults to the stack `defaults.pointInTimeRecovery` (on under `BlocksPresets.production`, off under `sandbox`). Bills for backup storage per GB-month; a shorter window trims cost. |
| `protection` | `'disposable' \| 'retained' \| 'locked'` | No | How hard the table is to destroy (spans removal policy + deletion protection). `'disposable'` = deleted with the stack; `'retained'` = orphaned on stack delete but a direct delete still works; `'locked'` = orphaned **and** deletion-protected. When omitted, removal policy + deletion protection follow the stack `defaults` (`BlocksPresets.production` ≈ `'locked'`, `sandbox` ≈ `'disposable'`). |
| `encryption` | `'aws-managed' \| 'customer-managed' \| ExternalKmsKeyRef` | No | At-rest encryption key. `'aws-managed'` (default) uses the `aws/dynamodb` KMS key (auditable, no key charge); `'customer-managed'` provisions a dedicated CMK; pass `DistributedTable.fromKmsKey(arn)` to encrypt with an existing CMK you own (shareable across tables). Any other value (e.g. a typo from untyped JavaScript or config) fails the synth with an error listing the valid values, rather than falling back to `'aws-managed'`. |
| `readValidation` | `'off' \| 'coerce' \| 'strict'` | No | How reads (`get`/`getBatch`/`query`/`scan`) reconcile a stored item with `schema`. `'coerce'` (**default**) returns the coerced value and, on failure, the raw value + a warning (never throws); `'strict'` throws `ValidationFailed` on a non-conforming item; `'off'` returns the raw value with no validation. See [Reads and schema evolution](#reads-and-schema-evolution). |
| `table` | `ExternalTableRef` | No | Wrap an existing DynamoDB table instead of creating one. Durability/encryption options are ignored — the customer owns the table's configuration. |
| `logger` | `ChildLogger` | No | Optional logger for internal operations. When omitted, a default Logger at warn level is created so `readValidation: 'coerce'` fallback warnings surface. |

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

**The key is the item's identity.** `get()`, `put()` and `delete()`, and the `ifNotExists` / `ifExists` conditions, match the **whole** primary key: the partition key plus the sort key, if the table has one. With a composite key, the sort key field is unique only within its partition. In `orders` above, `orderId` is unique per `userId`, not across users: `put({ userId: 'bob', orderId: '001', … }, { ifNotExists: true })` succeeds even when `alice` already has an order `'001'`. When a field must be unique across the whole table (an id, an email, a handle), make it the whole key and serve grouped lists from an index:

```typescript
const members = new DistributedTable(scope, 'members', {
  schema: memberSchema,
  key: { partitionKey: 'email' },                                       // unique across the table
  indexes: { byTeam: { partitionKey: 'teamId', sortKey: 'joinedAt' } }, // list a team's members
});
```

**Read consistency:** on AWS, `get()` is eventually consistent by default (a DynamoDB `GetItem` without `ConsistentRead`), so a read right after a `put()` may briefly return `null` or an older version. When the next step depends on an item that was just written, such as an existence or ownership check, pass `{ consistentRead: true }`. A strongly consistent read costs twice the read capacity. The local mock is always strongly consistent. On AWS every other read (`getBatch()`, `query()`, `scan()`) stays eventually consistent.

```typescript
// Sees a put() that has just completed, on AWS as well as locally
const fresh = await orders.get({ userId: 'alice', orderId: '001' }, { consistentRead: true });
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
| `order` | `'asc' \| 'desc'` | No | Sort direction on the sort key. Defaults to `'asc'`; any other value throws `InvalidQuery`. |

**Paging:** `query()` has no cursor or offset option. To page through results, sort on a unique, stable sort key (add a tie-breaker to a timestamp), pass the last key you returned as the bound in `where` (`{ greaterThan: cursor }` ascending, `{ lessThan: cursor }` with `order: 'desc'`), and request `limit: pageSize + 1` to learn whether another page exists.

### Conditional Operations

Both `put` and `delete` accept optional conditions:

```typescript
// Only write if no item has this exact primary key (partition key + sort key)
await table.put(item, { ifNotExists: true });

// Only write if existing item's field matches (optimistic locking)
await table.put(updatedItem, { ifFieldEquals: { version: 3 } });

// Only delete if item exists
await table.delete(key, { ifExists: true });

// Only delete if field matches
await table.delete(key, { ifFieldEquals: { status: 'archived' } });
```

All condition failures throw with `error.name === DistributedTableErrors.ConditionalCheckFailed` (the value is `'ConditionalCheckFailedException'`; match the constant, not a string or the message). They serialize to JSON-RPC **409 (Conflict)** over the wire (not 500), in both the mock and AWS runtime. Only `ifFieldEquals` optimistic-lock conflicts are flagged retriable; `ifNotExists` / `ifExists` existence assertions are **not** retriable (a blind retry fails identically). Left uncaught, the error reaches the client under that name; when your API promises its own error name, catch it and throw that `ApiError` instead (see [Error Handling](#error-handling)).

> **No partial update:** There is no `update()` or `patch()` method. To change a field, do a read-modify-write — `get()` the item, mutate it, then `put()` the full item back. For safe concurrent updates, pass `{ ifFieldEquals: { version: <previous> } }` to `put()` so the write fails (via `ConditionalCheckFailed`) if another writer changed the item in the meantime (optimistic locking).

### Reads and schema evolution

Writes always validate against `schema`. Reads reconcile a stored item with the schema according to the **`readValidation`** option, which matters after a schema change: a row written under an older schema may no longer match the declared type `T`. Under the default `'coerce'` (and under `'strict'`), a newly added field with a `.default()` is **filled in on the returned value**, but the stored row is **not rewritten** — the default reaches storage only when you `put()` the returned item back. Under `'off'` the field stays **absent** from the read (so the value silently violates `T`, and a `.default()` is neither applied nor persisted on write-back). A **required, no-default** field can't be filled in any mode: the read-modify-write cycle above **fails on the write** as `put()` rejects the legacy shape (under `'strict'`, the read itself throws first).

`readValidation` has three modes:

| Mode | On read | On a non-conforming item |
|---|---|---|
| **`'coerce'`** (default) | returns the schema's coerced output (defaults filled, types narrowed) | returns the **raw** value + logs a warning — **never throws** |
| **`'strict'`** | validates against the schema | **throws** `ValidationFailed` |
| **`'off'`** | returns the raw stored value, no validation | returns it as-is |

The default `'coerce'` closes the schema-evolution gap so a legacy row round-trips cleanly:

```typescript
const orderSchema = z.object({
  orderId: z.string(),
  total: z.number(),
  currency: z.string().default('USD'),   // added in a later release
});

const orders = new DistributedTable(scope, 'orders', {
  schema: orderSchema,
  key: { partitionKey: 'orderId' },
  // readValidation: 'coerce' is the default
});

const order = await orders.get({ orderId: 'o1' }); // legacy row → { …, currency: 'USD' }
await orders.put({ ...order, total: 20 });          // round-trips without ValidationFailed
```

**`'coerce'` never throws:** a value that genuinely can't be coerced (e.g. a required field with no default) is returned **as-is** with a warning, so unrecoverable rows stay readable for migration and `get()` never throws for a bad row.

> **Best-effort coercion (validator-dependent).** Coercion depends on the schema *transforming* its input. Zod fills defaults and casts; a check-only Standard Schema validator (some Valibot/ArkType schemas) validates without transforming, so `'coerce'` returns the value unchanged for those — it never invents data.

> **`'coerce'` preserves stored keys not in the schema.** Many schemas discard unrecognized keys when they validate (Zod object schemas `.strip()` by default), which would drop attributes a stored row carries beyond the current schema — and a read-modify-write would then persist the loss. To avoid that, `'coerce'` deep-merges the coerced output **over the raw stored item**: schema output wins per key (defaults filled, types narrowed), while attributes the schema doesn't declare — from an older schema version, or columns another writer owns — are **kept**. Arrays are replaced wholesale (the coerced array wins), and nested unknown keys are preserved too. So a routine read-modify-write never silently deletes a field you didn't touch. (Use **`'strict'`** if you instead want a schema mismatch to be rejected, or **`'off'`** to skip the schema pass entirely.)

Choose **`'strict'`** for tables where a schema mismatch should be treated as corruption and rejected (note: one bad row then fails the whole `query`/`scan`/`getBatch`). Choose **`'off'`** for hot paths, data you trust was written through this schema, or to read (and preserve) rows you can't yet coerce during a migration.

### Error Handling

Errors thrown by DistributedTable carry an `error.name` you can match with `isBlocksError`:

| Constant | `error.name` | Thrown when |
|----------|--------------|-------------|
| `DistributedTableErrors.ConditionalCheckFailed` | `ConditionalCheckFailedException` | An `ifNotExists` / `ifExists` / `ifFieldEquals` condition failed. Serializes to HTTP **409 (Conflict)**; retriable only for `ifFieldEquals` optimistic-lock conflicts (not `ifNotExists` / `ifExists`). |
| `DistributedTableErrors.ValidationFailed` | `ValidationFailedException` | An item failed the configured `schema` validation on `put()` / `putBatch()`. |
| `DistributedTableErrors.InvalidQuery` | `InvalidQueryException` | The call's input shape is wrong: a key that isn't an object with every key field (`get('alice')`, or a composite key without its sort key), an item without its key fields, `indexes` not given as an object, missing `where`, partition key not given as `{ equals }`, unknown index (the message lists the declared ones), an `order` other than `'asc'` / `'desc'`, multiple sort-key conditions, or an empty `ifFieldEquals`. A caller bug; the mock and the AWS runtime both throw it before calling DynamoDB. |
| `DistributedTableErrors.ItemTooLarge` | `ItemTooLargeException` | A `put`/`putBatch` item exceeds DynamoDB's 400 KB per-item size limit. |
| `DistributedTableErrors.BatchIncomplete` | `BatchIncompleteException` | A batch op left entries unprocessed after the retry budget (sustained throttling). AWS runtime only. |

```typescript
import { ApiError, DistributedTableErrors, isBlocksError } from '@aws-blocks/blocks';

try {
  await orders.put(order, { ifNotExists: true });
} catch (e: unknown) {
  if (isBlocksError(e, DistributedTableErrors.ConditionalCheckFailed)) {
    // an order with this userId + orderId already exists: report it under the API's own error name
    throw new ApiError('Order already exists', 409, { name: 'OrderExists', cause: e });
  }
  if (isBlocksError(e, DistributedTableErrors.ItemTooLarge)) {
    // item > 400 KB — split it or store a reference instead
  }
  throw e;
}
```

## Examples

### Basic CRUD

> The examples use Zod, but `schema` accepts any StandardSchemaV1 implementation (Zod, Valibot, ArkType). Install your chosen library, e.g. `npm install zod`. A hand-written validator's `~standard.validate` returns `{ value }` on success or `{ issues }` on failure, not Zod's `{ success, data }`.

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

## Local Development

Mock data persists to disk at `.bb-data/{fullId}/` across dev server restarts. Wipe with `rm -rf .bb-data`. The mock validates the 400 KB item size limit, schema validation, and conditional check failures, matching AWS behavior. Index queries are implemented via in-memory filtering — correctness is preserved but performance characteristics differ from DynamoDB.



