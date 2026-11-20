# KVStore

Key-value and document storage backed by DynamoDB, with optional secondary indexes.

**When to use:** Any data that you read by key. [Pick a form](#pick-a-form) lists the three forms.

**Declare a key for anything you list.** A store fixes its key when you create it. A store with a string key reads one item for each key, and it cannot list its keys in order or by prefix.

**When NOT to use:** If you need joins, aggregations, or a transaction across tables, use `Database`.

The examples import from the umbrella package `aws-cdk-blocks`, which every app made with `npm create @aws-cdk-blocks/blocks-app` depends on.

> Design and mock parity details: [DESIGN.md](./DESIGN.md)

For an app that has a `KVStore` from release 0.4.0 or earlier, see [Upgrade from release 0.4.0 or earlier](#upgrade-from-release-040-or-earlier).

## Pick a form

| You read the data | Form | Examples |
|---|---|---|
| by one key that you know | no options | caches, feature flags, config values, sessions |
| by one key, and also by another field | `schema` and `indexes` | users by id and by email |
| as a list, in order, inside a group | `schema` and a `key` with a sort field | the todos of one user, the messages of one conversation |

```typescript
import { KVStore } from 'aws-cdk-blocks';
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

```text
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

**Runtime only.** The data methods run at request time. Call them inside an `ApiNamespace` method, a `RawRoute` handler, a job handler, or a runtime script. Do not call them at the top level of `cdk-blocks/index.ts`. Top-level code runs during CDK synth, where a data method throws an `Error` that reads `KVStore.<method>() cannot be called during CDK synth`. You can construct the block at module scope.

**`null` options.** An option with the value `null` counts as an option that you did not pass, in every method. A value from a request can be `null` where the type says `undefined`. For example, an `expiresAt` of `null` sets no expiry. The two value checks are the exception. `ifValueEquals: null` compares with a stored `null`, and `ifFieldEquals: null` is an error.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `schema` | `StandardSchemaV1` | none | Validates every `put` and sets the value types. Required for `key`, `indexes`, and `ttl`. |
| `key` | `{ partitionKey, sortKey? }` | a string key | Names the fields of the value that form the key. Each field is required in the schema and holds a string or a number. The schema must state which: a field that accepts a number is a number key, and any other field is a string key. |
| `indexes` | `Record<string, { partitionKey, sortKey? }>` | none | Secondary indexes over fields of the value. |
| `ttl` | field name | none | Names the number field of the value that holds the expiry, in Unix epoch seconds. Without `ttl`, the block keeps the expiry outside the value. |
| `readValidation` | `'off' \| 'coerce' \| 'strict'` | `'coerce'` | How a read reconciles a stored value with `schema`. See [Reads and schema changes](#reads-and-schema-changes). |
| `protection` | `'disposable' \| 'retained' \| 'locked'` | the stack `defaults` | How hard the table is to destroy. See [Durability and security defaults](#durability-and-security-defaults). |
| `pointInTimeRecovery` | `boolean \| { retentionDays: number }` | the stack `defaults` | Continuous backups. |
| `encryption` | `'aws-managed' \| 'customer-managed' \| ExternalKmsKeyRef` | `'aws-managed'` | The key for encryption at rest. |
| `table` | `ExternalTableRef` | a new table | Use a table that exists. See [Use a table that exists](#use-a-table-that-exists). |
| `logger` | `ChildLogger` | a logger at warn level | A logger for internal operations. |

The mock and browser runtimes ignore `protection`, `pointInTimeRecovery`, and `encryption`.

## Errors

Match an error by name with `isBlocksError`. See the catch in [Rewrite a store of strings as objects](#rewrite-a-store-of-strings-as-objects).

| Constant | `error.name` | Thrown when |
|----------|--------------|-------------|
| `KVStoreErrors.ConditionalCheckFailed` | `ConditionalCheckFailedException` | A condition on `put` or `delete` failed. Status 409 in the JSON-RPC error. The HTTP status is also 409 when the namespace sets `httpErrorStatus: true`. |
| `KVStoreErrors.ValidationFailed` | `ValidationFailedException` | A value or an expiry is not valid. The causes are listed below. |
| `KVStoreErrors.InvalidQuery` | `InvalidQueryException` | The call has the wrong shape. The causes are listed below. |
| `KVStoreErrors.ItemTooLarge` | `ItemTooLargeException` | An item is larger than 400 KB. |
| `KVStoreErrors.BatchIncomplete` | `BatchIncompleteException` | A batch call left entries unprocessed. AWS runtime only. |

`ValidationFailedException` is thrown for a value that:

- fails the schema
- disagrees with its key
- has a `_bkv_` field or a `__proto__` field
- has an empty string in a key field or an indexed field
- has a key or indexed field over DynamoDB's size limit (2,048 bytes for a partition key, 1,024 for a sort key)
- nests lists or maps more than 32 levels deep

It is also thrown for a bad expiry.

`InvalidQueryException` is thrown for:

- a bad key
- a missing `where`, or a partition key not given as `{ equals: value }`
- a partition value or sort operand of the wrong type
- more than one sort condition, an unknown sort condition, or a `between` with its bounds reversed
- an unknown index
- an `order` that is not `'asc'` or `'desc'`
- a bad `limit`
- a bad cursor
- an `indexes` option that is not an object
- `ifValueEquals` with an object
- an empty `ifFieldEquals`
- a batch that repeats a key within one DynamoDB request (25 writes or 100 reads)

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

- `get`, `put`, `delete`, and the conditions `ifNotExists` and `ifExists` match the whole key: the partition field, and the sort field if the store has one.
- A sort field is unique only in its partition.
- To make one field unique in the whole store, make it the partition field of a key with no sort field.
- To list the items by another field, add an index.

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

The block stores each top-level field of an object value as one DynamoDB attribute. Field names that start with `_bkv_` belong to the block, and `put` rejects a value that has one. `put` also rejects a value that has a field named `__proto__`, at any depth, because DynamoDB cannot store that field name. An item can hold up to 400 KB.

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

A store with a schema can keep the expiry in a field of the value. Name the field with `ttl`. A `put` with no expiry option then uses the field. A `put` with an expiry option writes that expiry into the field before the schema validates the value, so the schema validates the value that is stored.

```typescript
const sessions = new KVStore(scope, 'sessions', {
	schema: z.object({ sessionId: z.string(), userId: z.string(), expiresAt: z.number() }),
	key: { partitionKey: 'sessionId' },
	ttl: 'expiresAt',
});
await sessions.put({ sessionId: 's1' }, { userId: 'alice', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
```

Do not change `ttl` on a deployed store. Items from before the change would keep their expiry in the old attribute and stop expiring. To change it, copy the items to a new store. See [Move a store between forms](#move-a-store-between-forms).

Expiry controls how long data stays. It does not control access. To revoke a session or a token before it expires, delete the item.

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

The error has a `retriable` flag. It is true when a value check took part in a failed `put`, and when a failed `delete` had a value check and no `ifExists`. When `retriable` is true, read the item again and retry. A failed `ifNotExists` or `ifExists` alone is not retriable.

A conditional write is atomic for its item, on AWS and in the local mock. No other write to that item lands between the call's check and its write.

There is no transaction across items. A batch call is not atomic on AWS. After a `BatchIncompleteException`, the entries that DynamoDB processed stay written. For a transaction, use `transaction()` on [`Database`](../bb-database/README.md#transactions).

There is no atomic increment. For a shared counter, read its value and write the increment only if the value has not changed. Give the counter no expiry: `get()` hides expired items that write conditions still see.

```typescript
import { isBlocksError, KVStoreErrors } from 'aws-cdk-blocks';

const counters = new KVStore<number>(scope, 'counters');

async function increment(name: string): Promise<number> {
	for (let attempt = 0; attempt < 10; attempt++) {
		const current = await counters.get(name);
		const next = (current ?? 0) + 1;
		try {
			await counters.put(name, next, current === null ? { ifNotExists: true } : { ifValueEquals: current });
			return next;
		} catch (e: unknown) {
			if (!isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)) throw e;
		}
	}
	throw new Error(`Could not increment ${name} after 10 attempts`);
}

await increment('visits');
```

If another writer creates the counter first, the failed create has `retriable: false`. The loop does not repeat that `put()`: it reads the new value and computes a new increment.

Alternatively, write one item per event in a store with a `key` such as `{ partitionKey: 'counterId', sortKey: 'eventId' }`. To get the total, use `query()` on the counter's partition and count the items. Each total reads every event for that counter and is eventually consistent on AWS.

## Read consistency

`get` is a strongly consistent read by default. A consistent read uses twice the read capacity. Pass `{ consistentRead: false }` where a stale value is acceptable.

`getBatch`, `scan`, and `query` are eventually consistent. A `query` on an index is always eventually consistent. The local mock is always strongly consistent.

## Query

The store needs a `key` with a sort field, or an index.

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

The sort field takes one of `equals`, `greaterThan`, `greaterThanOrEqual`, `lessThan`, `lessThanOrEqual`, `between`, or `beginsWith`. `beginsWith` is for a string field only. The partition value and each sort value pass the same check as a key. The value has the type of its field, and it is not an empty string or `NaN`.

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

## Scan

`scan` reads the whole table and has no prefix option. Prefer `get` or `query`. `scan` takes these options.

| Field | Required | Description |
|-------|----------|-------------|
| `limit` | No | The largest number of entries to return. A positive integer. |
| `cursor` | No | The position to start after. See [Pages](#pages). |
| `includeExpired` | No | Return expired items that are still in the table. Defaults to `false`. See [Expiry](#expiry). |

## Pages

`query` and `scan` return a `cursor`. Pass it to the same call to read the next page, in this request or in a later one. The cursor is `undefined` when the read reached the end. A `cursor` of `undefined` or `null` starts at the first entry, so a client can pass back the `cursor` of the page before as it is.

```typescript
import { ApiNamespace, Auth } from 'aws-cdk-blocks';

const auth = new Auth(scope, 'auth');

export const todoApi = new ApiNamespace(scope, 'todo-api', (context) => ({
	async listTodos(cursor?: string) {
		const user = await auth.requireAuth(context);
		// The partition comes from the signed-in user, never from the request.
		const page = todos.query({ where: { userId: { equals: user.userSub } }, limit: 20, cursor });
		const entries = await Array.fromAsync(page);
		return { todos: entries.map((entry) => entry.value), cursor: page.cursor };
	},
}));
```

The block validates a cursor before it uses it. A cursor that does not decode, or that belongs to another store, index, or partition, throws `InvalidQueryException`.

A cursor holds key values in a readable encoding. It is not a secret and not a permission. Check on every page that the caller can read the data, as the example does.

## Indexes

- An index field holds a string or a number. The schema states which, as for a key field.
- An index holds an item only when each indexed field is present, is not an empty string, and has the declared type. `put` rejects an empty string in an indexed field.
- To keep an item out of an index, leave the field out. Don't set it to `null`. On AWS, DynamoDB rejects a `put` whose indexed field holds `null` or a value of the other type with a `ValidationException`. The local mock accepts that write, so the error shows only on AWS.
- An index query returns whole items, because every index that the block creates holds all fields of the value. A table from `fromExisting` keeps the indexes you gave it.
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

## Use a table that exists

Pass the table name and the `key` that matches the table. The block does not create, change, or delete that table, and it ignores `protection`, `pointInTimeRecovery`, and `encryption` for it.

```typescript
const existingOrders = new KVStore(scope, 'existing-orders', {
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
import { isBlocksError, KVStoreErrors } from 'aws-cdk-blocks';

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

## Upgrade from release 0.4.0 or earlier

Release 0.4.0 or earlier keeps each item as `{ pk, value: <JSON text>, ttl? }`. This release keeps one attribute for each field, under another key attribute. DynamoDB cannot change the key of a table, so a `KVStore` of this release cannot take over the table of such a store. The deploy fails with `CloudFormation cannot update a stack when a custom-named resource requires replacing`, and the table keeps its items.

`LegacyKVStore` keeps the old table usable during the upgrade. It has the four data methods of release 0.4.0: `get`, `put`, `delete`, and `scan`. Two things differ: `scan` takes `limit` and `cursor` and returns `expiresAt` for items with an expiry; `get` now defaults to a strongly consistent read, which uses twice the read capacity. Pass `{ consistentRead: false }` to keep eventually consistent reads. You copy the data into a `KVStore` with a new id in your own code.

`LegacyKVStore` is deprecated and frozen. Use it only for this upgrade. It gets no new features, and a later release can remove it. Use `KVStore` for new data. When the data is in the new store, remove the `LegacyKVStore` from your app.

| Method | Returns | Description |
|--------|---------|-------------|
| `get(key, options?)` | `Promise<T \| null>` | Read one value of the old store. A consistent read by default. |
| `put(key, value, options?)` | `Promise<void>` | Write one value to the old store, as release 0.4.0 does. Takes `ttlSeconds` or `expiresAt`, and the conditions `ifNotExists` and `ifValueEquals`. |
| `scan(options?)` | `Results` | Read every entry of the old store, with its expiry. Takes `limit`, `cursor`, and `includeExpired`. |
| `delete(key, conditions?)` | `Promise<void>` | Remove a key from the old store. Takes the conditions `ifExists` and `ifValueEquals`. |

`put` validates the value with the `schema`. With both `put` conditions, the write goes ahead if the key is absent or its value matches. With both `delete` conditions, both must hold.

### What to know before you start

- **The table name changes with the id.** An alarm, a dashboard, or a policy of yours that names the table must follow.
- **A value that this release does not store fails the `put`** with `ValidationFailedException`. Such a value is an object with a top-level field that starts with `_bkv_`, or with a field named `__proto__`. Change the value in the copy.
- **Cost.** A copy reads every item of the old table once, and uses one write unit for each item of 1 KB or less.
- **Locally there is no table.** `LegacyKVStore` reads the data file of the old store in `.cdk-blocks/local/data/`, so the same steps run on the dev server. It does not change that file until a `put` or a `delete`.

### Step 1. Declare both stores, and deploy

Change the class on the line of the old store. Keep its id and its options. Add the new store with a new id.

```typescript
import { LegacyKVStore } from 'aws-cdk-blocks';

interface Prefs {
	theme: string;
}

// Release 0.4.0:
//   const prefs = new KVStore<Prefs>(scope, 'prefs', { ttl: true });
const oldPrefs = new LegacyKVStore<Prefs>(scope, 'prefs', { ttl: true });
const prefs = new KVStore<Prefs>(scope, 'prefs-v2');
```

The deploy creates the table of `prefs`. It does not change the table of `oldPrefs`, and the app's role keeps its access to that table.

`LegacyKVStore` takes the options that `KVStore` took in release 0.4.0: `ttl`, `removalPolicy`, `deletionProtection`, `pointInTimeRecovery`, `encryption`, `table`, `schema`, and `logger`. Pass exactly the options that the old store had, with their values, including a `KVStore.fromExisting()` table and a `KVStore.fromKmsKey()` key. The block declares the old table from them, and a changed or missing option makes CloudFormation change that table.

### Step 2. Migrate the data

The block does not copy the items, and it does not carry a write from one store to the other.

One way to migrate while the app stays live:

1. Deploy the app with reads that try the new store first and then the old one, and with writes that go to the new store.
2. Copy the items of the old store to the new store, in a handler or a job, for example an `AsyncJob`.
3. When the copy is done, remove the reads of the old store.

A copy uses these tools:

- **`scan` of the `LegacyKVStore`** gives each entry with its key, its value, and its expiry (`expiresAt`). With `limit` and `cursor` it reads one page at a time, so a copy of a large store can run in parts.
- **`put` of the `KVStore`** takes `expiresAt`, so a copied entry keeps its expiry. With `ifNotExists` it keeps a value that the new store has, so a copy is safe to run again.
- **`AsyncJob`** runs a copy outside a request. Each run can copy one page, and submit the next run with the cursor.

While the app reads both stores, these limits apply:

- A read that falls back to the old store returns the old value of a key that the new store does not have. This is the case after a delete, and after a value with an expiry expires.
- A condition on the new store does not see the old store. A `put` with `ifNotExists` goes ahead for a key that only the old store has.
- A `scan` or a `query` of the new store is not complete until the copy is done. Only a read by key can fall back to the old store.
- A delete or a write can lose a race with the copy. The copy holds a page of items while it writes them. A key that the app deletes at that moment, or writes with an expiry that passes at that moment, can come back with its old value.

### Step 3. Remove the old store, and deploy

When the data is in the new store, remove the `LegacyKVStore` line and the code that reads the old store, and deploy. The old table leaves the stack. A table with a removal policy of `destroy` is deleted. A table that is retained, which is the default of the production preset, stays in your account until you delete it.

## Best practices

- Give a store that accepts user input a `schema`.
- Take the partition of user data from the signed-in user, not from the request.

## Scaling and cost (AWS)

- **Billing.** On-demand. You pay for each read and each write. See [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/).
- **Indexes.** Each index adds a write for every item that it holds.
- **Latency.** Single-digit milliseconds for a read or a write by key.

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
- `encryption: 'customer-managed'` creates one KMS key for each table. To share one key, pass `KVStore.fromKmsKey(keyArn)`. The key policy must allow the execution role of the stack. In a sandbox, a store with `indexes` is recreated when its indexes change, by the role of the stack's index manager function, so the key policy must allow that role too. A key policy that delegates to account IAM allows both.
- Point-in-Time Recovery bills for backup storage. Turn it off for data that you can rebuild.

## Local development

The mock keeps data on disk in `.cdk-blocks/local/data/{fullId}/store.json`, so data stays across restarts of the dev server. To delete it, run `rm -rf .cdk-blocks/local/data .bb-data`.

The mock applies the schema, the conditions, expiry, the 400 KB limit (measured the way DynamoDB measures it), DynamoDB's key and nesting limits, and the cursor checks as AWS does. It runs an index query in memory, so the result is correct and the speed differs from DynamoDB. The mock has no throughput limits and no IAM.

The mock converts a data file of an earlier release when it first loads the file, and keeps a copy of the `store.json` from before the conversion as `store.json.bak`. It renames a file that it cannot read to a `.bak` file and logs a warning. It does not write over that file.

The mock keeps the store in the memory of the dev server, and reads `store.json` only when it constructs the store. Two processes on the same `.cdk-blocks/local/data` folder (two dev servers, or a script beside the dev server) do not see the writes of the other process, and can write over them.
