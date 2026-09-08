# KVStore

Simple key-value storage backed by DynamoDB.

**When to use:** Fast, single-key lookups with get/put/delete semantics. Good for caches, session stores, feature flags, and config values.

**When NOT to use:** If you need to query by multiple fields or secondary indexes, use `DistributedTable`. If you need full SQL, use `Database`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## API

```typescript
const store = new KVStore(scope, id, options?)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `get(key)` | `Promise<T \| null>` | Retrieve a value. Returns `null` if absent or expired. |
| `put(key, value, options?)` | `Promise<void>` | Store a value. Overwrites unless conditions are set; accepts an optional expiry. |
| `delete(key, conditions?)` | `Promise<void>` | Remove a value. |
| `scan(options?)` | `AsyncIterable<{ key, value }>` | Enumerate all entries. Skips expired items unless `{ includeExpired: true }`. Expensive on large datasets. |
| `KVStore.fromExisting(tableName)` | `ExternalTableRef` | Wrap a pre-existing DynamoDB table. |

**Runtime only.** Data methods (`get`, `put`, `delete`, `scan`) run at request time — call them inside an `ApiNamespace` method, `RawRoute` handler, job handler, or a runtime script, **not** at the top level of your `aws-blocks/index.ts`. Top-level code runs during CDK synth, where the block resolves to its infrastructure construct (no data methods), so a top-level call throws `store.<method> is not a function` (throws `TypeError` at runtime if called during CDK synth). To seed data, do it from inside a handler or a separate runtime script. Constructing the block at module scope is fine; only method calls must move into handlers.

### Options

| Option | Type | Description |
|--------|------|-------------|
| `schema` | `StandardSchemaV1` | Runtime validation schema (Zod, Valibot, ArkType, etc.). When provided, the value type `T` is inferred from the schema and every `put()` validates the value before writing. |
| `table` | `ExternalTableRef` | Wrap an existing DynamoDB table instead of creating one. |
| `logger` | `ChildLogger` | Optional logger for internal operations. When omitted, a default Logger at error level is created. |
| `removalPolicy` | `'destroy' \| 'retain'` | Removal behavior for the underlying DynamoDB table. When omitted, the stack-wide `defaults` (from `BlocksPresets.sandbox`/`production`, chosen at `BlocksStack.create`) apply — `production` retains data on `cdk destroy`, `sandbox` destroys it. Pass `'destroy'`/`'retain'` to override for this one store. The table's deletion protection also follows the stack `defaults`. Ignored by the mock and browser runtimes. |
| `ttl` | `boolean` | Enable DynamoDB Time-to-Live so items written with an expiry are deleted automatically. Defaults to `false`. See [Expiring Items](#expiring-items-ttl). |

### Expiring Items (TTL)

TTL is opt-in in two steps — turn it on for the table, then set an expiry per write:

```typescript
const cache = new KVStore(scope, 'cache', { ttl: true });

// Relative expiry — delete 5 minutes from now
await cache.put('otp:alice', code, { ttlSeconds: 300 });

// Absolute expiry — a Date, or Unix epoch time in SECONDS
await cache.put('session:1', record, { expiresAt: new Date('2027-01-01') });

// No expiry — stored indefinitely (the default)
await cache.put('config:theme', 'dark');
```

- **`ttl` defaults to `false`.** Enabling it on a table that already exists is a CloudFormation update to the live table, so it never happens implicitly.
- **The attribute is named `ttl`.** It is written only when `ttlSeconds` or `expiresAt` is supplied, and it holds Unix epoch **seconds**.
- **`ttlSeconds` and `expiresAt` are mutually exclusive.** Passing both — or a value that looks like epoch milliseconds — throws `ValidationFailedException` rather than silently storing a year-5138 expiry.
- **Reads never return expired items.** DynamoDB's reaper is asynchronous (typically within 48 hours), so `get` returns `null` and `scan` skips an item as soon as its expiry passes, in every runtime.
- **Expiry is per write.** Re-putting a key without expiry options clears any previous expiry; re-putting with them slides it forward.
- TTL composes with conditional writes: `put(key, value, { ifNotExists: true, ttlSeconds: 60 })`.

TTL is a retention control, not an authorization one. Anything security-sensitive (session validity, token revocation) must still be checked on read.

### Conditional Operations

Both `put` and `delete` accept an optional options object:

```typescript
// Only write if key doesn't exist (idempotent create)
await store.put('user:alice', data, { ifNotExists: true });

// Only write if current value matches (optimistic locking / compare-and-swap)
await store.put('counter', newVal, { ifValueEquals: oldVal });

// Only delete if key exists
await store.delete('temp', { ifExists: true });

// Only delete if value matches
await store.delete('lock', { ifValueEquals: expectedVal });
```

All condition failures throw with `error.name === KVStoreErrors.ConditionalCheckFailed`.

### Error Handling

| Constant | `error.name` | Thrown when |
|----------|--------------|-------------|
| `KVStoreErrors.ConditionalCheckFailed` | `ConditionalCheckFailedException` | An `ifNotExists` / `ifExists` / `ifValueEquals` condition failed. |
| `KVStoreErrors.ValidationFailed` | `ValidationFailedException` | A value failed the configured `schema` validation. |
| `KVStoreErrors.ItemTooLarge` | `ItemTooLargeException` | The serialized item exceeds the 400 KB DynamoDB per-item size limit. (In the AWS layer, DynamoDB raises a generic `ValidationException`; KVStore re-maps the size-specific case to this name.) |

```typescript
import { isBlocksError } from '@aws-blocks/core';
import { KVStoreErrors } from '@aws-blocks/bb-kv-store';

try {
  await store.put('key', value, { ifNotExists: true });
} catch (e: unknown) {
  if (isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)) {
    // key already exists
  }
  if (isBlocksError(e, KVStoreErrors.ItemTooLarge)) {
    // value is too large — consider compressing or splitting
  }
  throw e;
}
```

## Examples

### Basic Usage (string values)

```typescript
const store = new KVStore(scope, 'cache');

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async setGreeting(value: string) {
    await store.put('greeting', value);
  },
  async getGreeting() {
    return { value: await store.get('greeting') };
  },
}));
```

Without a `schema`, the value type defaults to `string`. To store structured data without runtime validation, pass a type argument — `new KVStore<MyType>(scope, id)`; values are JSON-serialized on write and parsed on read automatically (no manual `JSON.stringify` needed).

### Typed Values with Schema

Use a schema to get type-safe values with runtime validation:

> The examples use Zod, but `schema` accepts any StandardSchemaV1 implementation (Zod, Valibot, ArkType). Install your chosen library, e.g. `npm install zod`.

```typescript
import { z } from 'zod';

const sessionSchema = z.object({
  userId: z.string(),
  expiresAt: z.number(),
});

const sessions = new KVStore(scope, 'sessions', { schema: sessionSchema });

// Type is inferred from the schema — no generic arg needed
await sessions.put(token, { userId: 'alice', expiresAt: Date.now() + 3600000 });
const session = await sessions.get(token); // { userId: string; expiresAt: number } | null

// Invalid data is rejected at runtime
await sessions.put(token, { userId: 123 }); // throws ValidationFailedException
```

### Wrapping an Existing Table

```typescript
const legacy = new KVStore(scope, 'legacy', {
  table: KVStore.fromExisting('my-existing-table'),
});
```

## Best Practices

- Keep keys short and descriptive (e.g., `user:{id}`, `session:{token}`)
- Store one logical entity per KVStore instance
- Use a `schema` for structured values — it ensures runtime data matches your types
- Use `{ ifNotExists: true }` for idempotent creates
- Use `{ ifValueEquals }` for compare-and-swap when multiple writers are possible
- `scan()` returns an `AsyncIterable` — collect with `await Array.fromAsync(store.scan())` or `for await`. Prefer `get(key)` over `scan()` (scans read every item).

## Scaling & Cost (AWS)

- **Billing:** PAY_PER_REQUEST — no provisioned capacity to manage
- **Latency:** Single-digit ms reads and writes
- **Throughput:** Scales automatically, no upper limit on table size
- **Item size limit:** 400 KB per item
- **Cost:** ~$1.25 per million writes, ~$0.25 per million reads
- **Durability:** 99.999999999% (11 nines) across 3 AZs

## Local Development

Mock data persists to disk at `.bb-data/{fullId}/` across dev server restarts. Wipe with `rm -rf .bb-data`. The mock validates the 400 KB item size limit, schema validation, and conditional check failures, matching AWS behavior.



