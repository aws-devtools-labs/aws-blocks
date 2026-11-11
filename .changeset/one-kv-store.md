---
"@aws-blocks/bb-kv-store": minor
"@aws-blocks/blocks": minor
---

feat(bb-kv-store): one KVStore block (folds DistributedTable in)

AWS Blocks now ships one NoSQL block. `KVStore` takes over the data model of `DistributedTable`, and the `@aws-blocks/bb-distributed-table` package is removed from the umbrella and from the workspace. There is no shim.

A store has three forms, and the first two share one table:

- No options: a string key and a string value (or a type argument), for caches, sessions, flags and config values.
- A `schema` and `indexes`: typed values on a string key, with a read by another field.
- A `schema` and a `key` (`{ partitionKey, sortKey? }`): the key of the store is an object with exactly those fields, and the table uses them as its key schema. This is the former `DistributedTable` model, including number keys.

What moved over from `DistributedTable`: `query({ index?, where, limit?, order?, cursor? })`, `getBatch`, `putBatch`, `deleteBatch`, `indexes` and the GSI manager, `ifFieldEquals`, `readValidation` (default `'coerce'`), `protection`, `consistentRead`, and `table: KVStore.fromExisting(name)` with a matching `key`.

What is new:

- Items are stored flat: one attribute per top-level field of an object value; any other value in `_bkv_value`; the expiry in `_bkv_ttl` unless `ttl: '<numberField>'` names a field of the value. The string key lives in `_bkv_pk`. Top-level value fields that start with the reserved prefix `_bkv_` are rejected.
- A field name that DynamoDB cannot store is rejected: a value with a field named `__proto__`, at any depth, fails with `ValidationFailedException` in both runtimes.
- Every call is key first: `put(key, value, options)`, `putBatch([{ key, value }])`. On a declared-key store, `put` writes the key fields from the key; a value whose key field disagrees is rejected.
- `query` and `scan` return a `Results` object: an async iterable of `{ key, value, expiresAt? }` entries with a `cursor` property. Pass `limit` and the `cursor` of an earlier call to read the next page, in this request or a later one. A cursor is checked against the store's key schema, the call's index and the call's partition before use.
- The partition value of a `query`, the values of a sort condition and the key values inside a cursor pass the same check as a key: the value has the type of its field, and it is not an empty string or `NaN`. A sort condition that does not exist, `between` without two values, and `beginsWith` on a number field are `InvalidQueryException`.
- `get` is strongly consistent by default; `consistentRead: false` opts out.
- An option with the value `null` counts as an option that was not passed, in every method (for example `limit: null`, `cursor: null`, `expiresAt: null`), because a value from a request can be `null` where the type says `undefined`. The two value checks are the exception: `ifValueEquals: null` compares with a stored `null`, and `ifFieldEquals: null` is an error.
- The type of a key field or an index field (string or number) comes from one probe of the schema, which the CDK layer and the runtimes share: a field is a number if the schema accepts `0`, `1` or `-1` for it, and a string in all other cases. A refined number such as `z.number().positive()` is now a number key. The runtime rejects a key of the other type with `InvalidQueryException`. A key field needs a schema that states its type; a schema that accepts every value makes it a number.
- Every read hides an expired item, and DynamoDB TTL is always on for a table the block creates.
- With `ttl: '<field>'`, a `put` that passes `ttlSeconds` or `expiresAt` writes the expiry into the field before the schema validates the value, so the schema validates the value that is stored.
- The read type and the write type come from the schema: `put` takes the schema's input type, a read returns its output type, and keys and conditions use the output type, so a brand in the schema makes a swap of two key fields a compile error.
- Conditions keep the `KVStore` rules: on `put`, `ifNotExists` and a value check compose with OR; on `delete`, `ifExists` and a value check compose with AND. The value check is `ifFieldEquals` for an object value and `ifValueEquals` for any other value.
- `KVStoreErrors` is the union of both blocks' names: `ConditionalCheckFailed`, `ValidationFailed`, `InvalidQuery`, `ItemTooLarge`, `BatchIncomplete`.

Removed options: `ttl: true` (expiry is always on), `removalPolicy` and `deletionProtection` (use `protection`). `ifValueEquals` with an object value is now a compile error; use `ifFieldEquals`.

Migration for a `DistributedTable` app: `new KVStore(scope, id, { schema, key, indexes, ttl })` keeps the same table name, key schema, TTL attribute and items, so the table stays in place. `put(item)` becomes `put({ pk: item.pk, sk: item.sk }, item)`, `putBatch([item])` becomes `putBatch([{ key, value: item }])`, and `for await (const item of table.query(o))` becomes `for await (const { value: item } of store.query(o))`. `DistributedTableErrors` becomes `KVStoreErrors`.

Migration for a `KVStore` app: drop `ttl: true`, replace `removalPolicy`/`deletionProtection` with `protection`, and replace `ifValueEquals` on an object value with `ifFieldEquals`. The stored item format changed (`pk` + JSON `value` became `_bkv_pk` + flat attributes), so a deployed table cannot stay in place: for a sandbox, destroy the stack and deploy again; for data you must keep, give the new store a new id, deploy, copy the items, and remove the old store.

The umbrella `@aws-blocks/blocks` no longer exports `DistributedTable`, `DistributedTableErrors`, or the `DT*` option types. It exports the KVStore types `KeyConfig`, `IndexConfig`, `KeyOf`, `ValueOf`, `KVEntry`, `KVResults`, `KVQueryOptions`, `KVScanOptions`, `KVGetOptions`, `PutBatchEntry`, `SortCondition`, `Where` and `ReadValidationMode` alongside the existing ones.
