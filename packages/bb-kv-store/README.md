# KVStore

Key-value and document storage backed by DynamoDB, with optional secondary indexes.

**When to use:** Any data that you read by key. With no options, `KVStore` is a string-keyed store for caches, sessions, feature flags, and config values. With a `schema` and a `key`, it holds app records that you list or query as a collection, such as todos, orders, or messages. Add `indexes` to read the same records by other fields.

**Declare a key for anything you list.** A store fixes its key when you create it. A store with a string key reads one item for each key, and it cannot list its keys in order or by prefix.

**When NOT to use:** If you need joins, aggregations, or a transaction across tables, use `Database`.

> Design and mock parity details: [DESIGN.md](./DESIGN.md)

## Pick a form

Pick the form by how you read the data.

| You read the data | Form | Examples |
|---|---|---|
| by one key that you know | no options | caches, feature flags, config values, sessions |
| by one key, and also by another field | `schema` and `indexes` | users by id and by email |
| as a list, in order, inside a group | `schema` and a `key` with a sort field | the todos of one user, the messages of one conversation |

```typescript
import { KVStore } from '@aws-blocks/bb-kv-store';
import { z } from 'zod';

// 1. No options. A string key and a string value.
const cache = new KVStore(scope, 'cache');

// 2. A schema and an index. Typed values, and a read by another field.
const users = new KVStore(scope, 'users', {
	schema: z.object({ name: z.string(), email: z.string() }),
	indexes: { byEmail: { partitionKey: 'email' } },
});

// 3. A schema and a key. Records that you list in order inside a group.
const todos = new KVStore(scope, 'todos', {
	schema: z.object({
		userId: z.string(),
		todoId: z.string(),
		title: z.string(),
		done: z.boolean(),
		version: z.number(),
	}),
	key: { partitionKey: 'userId', sortKey: 'todoId' },
});
```

Forms 1 and 2 use the same table, so a store moves between them with no new table. Form 3 fixes the key when you create the store. See [Move a store between forms](#move-a-store-between-forms).

The examples use Zod. `schema` accepts any Standard Schema library, such as Zod, Valibot, or ArkType.

## API

```typescript
const store = new KVStore(scope, id, options?)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `get(key, options?)` | `Promise<T \| null>` | Read one value. Returns `null` if the key is absent or expired. A consistent read by default. |
| `put(key, value, options?)` | `Promise<void>` | Store a value. Replaces the old value unless you set a condition. Takes an optional expiry. |
| `delete(key, options?)` | `Promise<void>` | Remove a value. Takes an optional condition. |
| `query(options)` | `Results` | Read the items of one partition, or of one index partition, in sort order. |
| `scan(options?)` | `Results` | Read every item. The cost grows with the size of the table. |
| `getBatch(keys)` | `Promise<(T \| null)[]>` | Read many values by key. |
| `putBatch(entries)` | `Promise<void>` | Store many values. |
| `deleteBatch(keys)` | `Promise<void>` | Remove many values by key. |
| `KVStore.fromExisting(tableName)` | `ExternalTableRef` | Refer to a DynamoDB table that exists. |
| `KVStore.fromKmsKey(keyArn)` | `ExternalKmsKeyRef` | Refer to a KMS key that exists. |

`Results` is an `AsyncIterable` of `{ key, value, expiresAt }` entries with one more property, `cursor`. `expiresAt` is present when the item has an expiry. Collect it with `await Array.fromAsync(results)` or read it with `for await`.

**Runtime only.** The data methods run at request time. Call them inside an `ApiNamespace` method, a `RawRoute` handler, a job handler, or a runtime script. Do not call them at the top level of `aws-blocks/index.ts`. Top-level code runs during CDK synth, where a data method throws an `Error` that reads `KVStore.<method>() cannot be called during CDK synth`. You can construct the block at module scope.

### Options

| Option | Type | Description |
|--------|------|-------------|
| `schema` | `StandardSchemaV1` | Validates every `put` and sets the value types. Required for `key`, `indexes`, and `ttl`. |
| `key` | `{ partitionKey, sortKey? }` | Names the fields of the value that form the key. Each field is required in the schema and holds a string or a number. The schema must state which: a field that accepts a number is a number key, and any other field is a string key. Without `key`, the key is a string. |
| `indexes` | `Record<string, { partitionKey, sortKey? }>` | Secondary indexes over fields of the value. |
| `ttl` | field name | Names the number field of the value that holds the expiry, in Unix epoch seconds. Without `ttl`, the block keeps the expiry outside the value. |
| `readValidation` | `'off' \| 'coerce' \| 'strict'` | How a read reconciles a stored value with `schema`. Defaults to `'coerce'`. See [Reads and schema changes](#reads-and-schema-changes). |
| `protection` | `'disposable' \| 'retained' \| 'locked'` | How hard the table is to destroy. Defaults to the stack `defaults`. |
| `pointInTimeRecovery` | `boolean \| { retentionDays: number }` | Continuous backups. Defaults to the stack `defaults`. |
| `encryption` | `'aws-managed' \| 'customer-managed' \| ExternalKmsKeyRef` | The key for encryption at rest. Defaults to `'aws-managed'`. |
| `table` | `ExternalTableRef` | Use a table that exists. See [Use a table that exists](#use-a-table-that-exists). |
| `logger` | `ChildLogger` | A logger for internal operations. Defaults to a logger at warn level. |

The mock and browser runtimes ignore `protection`, `pointInTimeRecovery`, and `encryption`.

## Keys

A store with no `key` option takes a string key. A store with a `key` option takes an object that has exactly the key fields.

```typescript
await cache.get('greeting');
await todos.get({ userId: 'alice', todoId: '001' });

// todos.get('alice');              compile error: the key is an object
// todos.get({ userId: 'alice' });  compile error: todoId is missing
```

`put` writes the key fields from the key, so the value can leave them out. If the value has a key field, it must equal the key. Otherwise `put` throws `ValidationFailedException`.

A key field cannot hold an empty string.

### Branded key fields

Two string fields have the same type, so the compiler accepts `{ userId: todoId, todoId: userId }`. To make that a compile error, brand the key fields in the schema.

```typescript
const UserId = z.string().brand<'UserId'>();
const NoteId = z.string().brand<'NoteId'>();
const notes = new KVStore(scope, 'notes', {
	schema: z.object({ userId: UserId, noteId: NoteId, text: z.string() }),
	key: { partitionKey: 'userId', sortKey: 'noteId' },
});

const userId = UserId.parse('alice');
const noteId = NoteId.parse('n1');
await notes.get({ userId, noteId });

// notes.get({ userId: noteId, noteId: userId });      compile error
// notes.get({ userId: 'alice', noteId: 'n1' });       compile error: plain strings have no brand
```

## Values

With no `schema`, the value type is `string`. Pass a type argument to store another JSON type with no validation.

```typescript
const counts = new KVStore<number>(scope, 'counts');
await counts.put('visits', 42);
```

With a `schema`, the value type comes from the schema. `put` takes the input type of the schema and stores that value as it is. A read returns the output type. The two types differ only when a field has a default, a brand, or a transform. Do not pass a type argument together with a `schema`.

```typescript
await cache.put('greeting', 'hello');
await users.put('u1', { name: 'Ada', email: 'ada@example.com' });
await todos.put({ userId: 'alice', todoId: '001' }, { title: 'Write the README', done: false, version: 1 });

const todo = await todos.get({ userId: 'alice', todoId: '001' });
// { userId: 'alice', todoId: '001', title: 'Write the README', done: false, version: 1 }
```

The block stores each top-level field of an object value as one DynamoDB attribute. Field names that start with `_bkv_` belong to the block, and `put` rejects a value that has one. `put` also rejects a value that has a field named `__proto__`, at any depth: DynamoDB cannot store that field name. An item can hold up to 400 KB.

## Expiry

Set an expiry on a write. Every read hides an expired item from that moment. DynamoDB deletes the item later, in the background.

```typescript
// Relative. The item expires 5 minutes from now.
await cache.put('otp:alice', '123456', { ttlSeconds: 300 });

// Absolute. A Date, or Unix epoch time in seconds.
await cache.put('banner', 'Sale ends soon', { expiresAt: new Date('2027-01-01') });

// No expiry. The item stays until you delete it.
await cache.put('config:theme', 'dark');
```

- `ttlSeconds` and `expiresAt` exclude each other.
- A number in `expiresAt` is in seconds. A value that looks like milliseconds throws `ValidationFailedException`.
- Expiry belongs to the write. A `put` with no expiry option clears the old expiry.
- A condition still sees an expired item until DynamoDB deletes it.
- `scan({ includeExpired: true })` returns expired items that are still in the table. Use it only for a cleanup job.

A store with a schema can keep the expiry in a field of the value. Name the field with `ttl`. A `put` with no expiry option then uses the field.

```typescript
const sessions = new KVStore(scope, 'sessions', {
	schema: z.object({ sessionId: z.string(), userId: z.string(), expiresAt: z.number() }),
	key: { partitionKey: 'sessionId' },
	ttl: 'expiresAt',
});
await sessions.put({ sessionId: 's1' }, { userId: 'alice', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
```

Do not change `ttl` on a deployed store. Items from before the change would keep their expiry in the old attribute and stop expiring. To change it, copy the items to a new store. See [Move a store between forms](#move-a-store-between-forms).

Expiry controls how long data stays. It does not control access. Check on every read that a session or a token is still valid.

## Conditional writes

`put` and `delete` take conditions. A failed condition throws `ConditionalCheckFailedException` with status 409.

```typescript
// Create only. Fails if the key exists.
await cache.put('lock:report', 'worker-1', { ifNotExists: true, ttlSeconds: 60 });

// Compare a value that is not an object.
await cache.put('lock:report', 'worker-2', { ifValueEquals: 'worker-1' });

// Compare fields of an object value. This is optimistic locking with a version field.
const current = await todos.get({ userId: 'alice', todoId: '001' });
if (current) {
	await todos.put(
		{ userId: 'alice', todoId: '001' },
		{ ...current, done: true, version: current.version + 1 },
		{ ifFieldEquals: { version: current.version } },
	);
}

// Create it, or replace it only if it is unchanged.
await cache.put('config:theme', 'light', { ifNotExists: true, ifValueEquals: 'dark' });

// Delete only if the value still matches.
await cache.delete('lock:report', { ifValueEquals: 'worker-2' });
```

| Call | Conditions | How they combine |
|---|---|---|
| `put` | `ifNotExists`, and `ifFieldEquals` or `ifValueEquals` | OR. The write succeeds if the key is absent or the stored value matches. |
| `delete` | `ifExists`, and `ifFieldEquals` or `ifValueEquals` | AND. Both must hold. |

Use `ifFieldEquals` for an object value and `ifValueEquals` for any other value. `ifFieldEquals` needs at least one field.

The error has a `retriable` flag. It is true when a value check took part in a failed `put`, and when a failed `delete` had a value check and no `ifExists`. Read the item again and retry. A failed `ifNotExists` or `ifExists` alone is not retriable.

## Read consistency

`get` is a strongly consistent read by default. It returns a value that a `put` wrote a moment before. A consistent read uses twice the read capacity. Pass `{ consistentRead: false }` where a stale value is acceptable.

`getBatch`, `scan`, and `query` are eventually consistent. A `query` on an index is always eventually consistent. The local mock is always strongly consistent.

## Query

`query` reads the items of one partition in sort order. The store needs a `key` with a sort field, or an index.

```typescript
for await (const { key, value } of todos.query({
	where: { userId: { equals: 'alice' }, todoId: { beginsWith: '2026-' } },
	order: 'desc',
	limit: 10,
})) {
	console.log(key.todoId, value.title);
}

const matches = await Array.fromAsync(
	users.query({ index: 'byEmail', where: { email: { equals: 'ada@example.com' } } }),
);
```

| Field | Required | Description |
|-------|----------|-------------|
| `where` | Yes | The partition field with `{ equals }`, and at most one condition on the sort field. |
| `index` | No | The index to read. Without `index`, the query reads by the key of the store. |
| `limit` | No | The largest number of entries to return. A positive integer. |
| `order` | No | `'asc'` or `'desc'` on the sort field. Defaults to `'asc'`. |
| `cursor` | No | The position to start after. See [Pages](#pages). |

The sort field takes one of `equals`, `greaterThan`, `greaterThanOrEqual`, `lessThan`, `lessThanOrEqual`, `between`, or `beginsWith`. `beginsWith` is for a string field only.

A sort field can hold a number. Use a number for time order.

```typescript
const readings = new KVStore(scope, 'readings', {
	schema: z.object({ deviceId: z.string(), at: z.number(), celsius: z.number() }),
	key: { partitionKey: 'deviceId', sortKey: 'at' },
});
const lastHour = readings.query({
	where: { deviceId: { equals: 'd1' }, at: { greaterThan: Date.now() - 3_600_000 } },
});
```

`scan` reads the whole table and has no prefix option. Prefer `get` or `query`.

## Pages

`query` and `scan` return a `cursor`. Pass it to the same call to read the next page, in this request or in a later one. The cursor is `undefined` when the read reached the end. A `cursor` of `undefined` or `null` starts at the first entry, so a client can pass back the `cursor` of the page before as it is.

```typescript
import { ApiNamespace } from '@aws-blocks/core';
import { AuthBasic } from '@aws-blocks/bb-auth-basic';

const auth = new AuthBasic(scope, 'auth');

export const todoApi = new ApiNamespace(scope, 'todo-api', (context) => ({
	async listTodos(cursor?: string) {
		const user = await auth.requireAuth(context);
		// The partition comes from the signed-in user, never from the request.
		const page = todos.query({ where: { userId: { equals: user.userId } }, limit: 20, cursor });
		const entries = await Array.fromAsync(page);
		return { todos: entries.map((entry) => entry.value), cursor: page.cursor };
	},
	async addTodo(title: string) {
		const user = await auth.requireAuth(context);
		const todoId = crypto.randomUUID();
		await todos.put({ userId: user.userId, todoId }, { title, done: false, version: 1 }, { ifNotExists: true });
		return { todoId };
	},
}));
```

The block validates a cursor before it uses it. A cursor that does not decode, or that belongs to another store, index, or partition, throws `InvalidQueryException`.

A cursor holds key values in a readable encoding. It is not a secret and not a permission. Check on every page that the caller can read the data, as the example does.

## Indexes

An index reads the same items by other fields of the value. `indexes` needs a `schema`.

- An index field holds a string or a number. The schema states which, as for a key field.
- An index holds an item only when each indexed field is present, is not an empty string, and has the declared type. `put` rejects an empty string in an indexed field.
- A read from an index is eventually consistent.
- A store can have up to 20 indexes.
- To add or remove an index, change `indexes` and deploy. DynamoDB fills a new index from the items that exist. On a large table that takes minutes to hours.

A store with a string key can list items through an index. Add a field that names the group, and put an index on that field.

## Batch calls

```typescript
const [first, second] = await todos.getBatch([
	{ userId: 'alice', todoId: '001' },
	{ userId: 'alice', todoId: '002' },
]);

await todos.putBatch([
	{ key: { userId: 'alice', todoId: '003' }, value: { title: 'Ship', done: false, version: 1 } },
]);

await todos.deleteBatch([{ userId: 'alice', todoId: '003' }]);
```

`getBatch` returns the values in the order of the keys, with `null` for a key that is absent or expired. `putBatch` validates every value, takes an expiry for each entry, and takes no conditions. On AWS, a batch call throws `BatchIncompleteException` if DynamoDB leaves entries unprocessed after the retries.

## Reads and schema changes

A `put` always validates against `schema`. A stored item can still differ from the schema, because an older version of the app wrote it. `readValidation` sets what a read does with such an item.

| Mode | A read returns | An item that does not match |
|---|---|---|
| `'coerce'`, the default | the output of the schema, with defaults filled in | the stored value, with a warning in the log. The read never throws. |
| `'strict'` | the output of the schema | the read throws `ValidationFailedException` |
| `'off'` | the stored value, with no validation | the stored value |

`'coerce'` keeps stored fields that the schema does not declare, so a read followed by a `put` does not delete them. A default reaches the table only when you `put` the value back.

## Errors

Match an error by name with `isBlocksError`.

| Constant | `error.name` | Thrown when |
|----------|--------------|-------------|
| `KVStoreErrors.ConditionalCheckFailed` | `ConditionalCheckFailedException` | A condition on `put` or `delete` failed. Status 409. |
| `KVStoreErrors.ValidationFailed` | `ValidationFailedException` | A value fails the schema, disagrees with its key, has a `_bkv_` field, has a `__proto__` field, or has an empty string in a key field or an indexed field. Also a bad expiry. |
| `KVStoreErrors.InvalidQuery` | `InvalidQueryException` | The call has the wrong shape: a bad key, a bad `where`, an unknown index, a bad `limit`, a bad cursor, or `ifValueEquals` with an object. |
| `KVStoreErrors.ItemTooLarge` | `ItemTooLargeException` | An item is larger than 400 KB. |
| `KVStoreErrors.BatchIncomplete` | `BatchIncompleteException` | A batch call left entries unprocessed. AWS runtime only. |

```typescript
import { isBlocksError } from '@aws-blocks/core';
import { KVStoreErrors } from '@aws-blocks/bb-kv-store';

try {
	await cache.put('lock:report', 'worker-3', { ifNotExists: true });
} catch (e: unknown) {
	if (isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)) {
		// another worker holds the lock
	} else {
		throw e;
	}
}
```

## Use a table that exists

Pass the table name and the `key` that matches the table. The block does not create, change, or delete that table, and it ignores `protection`, `pointInTimeRecovery`, and `encryption` for it.

```typescript
const legacyOrders = new KVStore(scope, 'legacy-orders', {
	schema: z.object({ customerId: z.string(), orderId: z.string(), total: z.number() }),
	key: { partitionKey: 'customerId', sortKey: 'orderId' },
	table: KVStore.fromExisting('my-existing-table'),
});
```

You own the indexes and the TTL setting of that table.

## Move a store between forms

| Change | What it needs |
|---|---|
| Add a `schema` to a store of object values | Nothing. An item that fails the schema follows `readValidation`. |
| Add a `schema` to a store of strings | Rewrite each item as an object. See the recipe below. |
| Add or remove an index | A deploy. DynamoDB fills or drops the index. |
| Remove the `schema` | A type argument that matches the stored values. Without one, the value type is `string`. |
| Add, change, or remove `key` | A new store. A `key` change in place fails the deploy. |
| Add, change, or remove `ttl` | A new store. Do not change `ttl` in place. |

### Rewrite a store of strings as objects

A string has no fields, so an index cannot read it. Do the move in three steps.

```typescript
const memberSchema = z.object({ name: z.string(), email: z.string() });
type Member = z.infer<typeof memberSchema>;

// Step 1. While the move runs, the store holds both shapes.
const members = new KVStore<string | Member>(scope, 'members');

// Step 2. In a job handler, write each string back as an object, with its expiry.
for await (const { key, value, expiresAt } of members.scan()) {
	if (typeof value !== 'string') continue;
	try {
		await members.put(key, memberSchema.parse(JSON.parse(value)), { ifValueEquals: value, expiresAt });
	} catch (e: unknown) {
		// Another writer changed the item. The next run picks it up.
		if (!isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)) throw e;
	}
}

// Step 3. When no strings remain, add the schema, and then the index:
// new KVStore(scope, 'members', { schema: memberSchema, indexes: { byEmail: { partitionKey: 'email' } } });
```

In step 1, the code that reads the store must accept both shapes.

### Copy a store to a new key

Give the new store a new id, deploy, and copy. Then point the app at the new store and remove the old one.

```typescript
const todosById = new KVStore(scope, 'todos-by-id', {
	schema: z.object({
		userId: z.string(),
		todoId: z.string(),
		title: z.string(),
		done: z.boolean(),
		version: z.number(),
	}),
	key: { partitionKey: 'todoId' },
});

for await (const { value, expiresAt } of todos.scan()) {
	await todosById.put({ todoId: value.todoId }, value, { expiresAt });
}
```

## Best practices

- Declare a `key` for anything that you list.
- Take the partition of user data from the signed-in user, not from the request.
- Give a store that accepts user input a `schema`.
- Choose a partition field that spreads the data, such as `userId` or `tenantId`.
- Use a sort field for range queries, such as a timestamp.
- Declare indexes for the access patterns that you know when you create the store.
- Use `{ ifNotExists: true }` for a create that is safe to repeat.
- Use `ifFieldEquals` with a version field when several writers can change one item.
- Store one kind of entity in each store.
- Prefer `get` and `query` to `scan`.

## Scaling and cost (AWS)

- **Billing.** On-demand. You pay for each read and each write, with no capacity to manage. See [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/).
- **Reads.** A consistent `get` uses twice the read capacity of an eventually consistent read.
- **Indexes.** Each index adds a write for every item that it holds.
- **Latency.** Single-digit milliseconds for a read or a write by key.
- **Limits.** 400 KB for each item, and 20 indexes for each store.
- **Replication.** DynamoDB keeps the data in three Availability Zones of the Region.

## Durability and security defaults

The stack `defaults` set how durable a table is. You choose them with `BlocksPresets.production` or `BlocksPresets.sandbox` when you create the stack.

| | `production` | `sandbox` |
|---|---|---|
| Point-in-Time Recovery | on, 35 days | off |
| Removal | the table stays when the stack is deleted | the table is deleted with the stack |
| Deletion protection | on | off |
| Encryption at rest | AWS-managed KMS key | AWS-managed KMS key |

Each option overrides the default for one store.

```typescript
const sharedKey = KVStore.fromKmsKey('arn:aws:kms:us-east-1:111122223333:key/abcd-1234');
const audit = new KVStore(scope, 'audit', {
	protection: 'locked',
	pointInTimeRecovery: { retentionDays: 7 },
	encryption: sharedKey,
});
```

- `protection: 'disposable'` deletes the table with the stack. `'retained'` keeps the table. `'locked'` keeps the table and turns on deletion protection.
- A table that stays after a stack delete keeps its name. A new deploy of the same app fails with `Table already exists` until you delete or import that table.
- `encryption: 'customer-managed'` creates one KMS key for each table. To share one key, pass `KVStore.fromKmsKey(keyArn)`. The key policy must allow the execution role of the stack.
- Point-in-Time Recovery bills for backup storage. Turn it off for data that you can rebuild.

## Local development

The mock keeps data on disk in `.bb-data/{fullId}/`, so data stays across restarts of the dev server. Delete it with `rm -rf .bb-data`. The mock applies the schema, the conditions, expiry, the 400 KB limit, and the cursor checks as AWS does. It runs an index query in memory, so the result is correct and the speed differs from DynamoDB. The mock has no throughput limits and no IAM.
