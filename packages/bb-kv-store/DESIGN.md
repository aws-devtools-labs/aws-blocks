# KVStore — Design

Design document for KVStore. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-kv-store`
**Type:** Primitive (new infrastructure)
**AWS Service:** DynamoDB (one table per store: a partition key, an optional sort key, optional global secondary indexes)

KVStore is the one NoSQL block of AWS Blocks. It folds the former `DistributedTable` block into `KVStore`: one package, one class, one error constant, and three forms of a store that differ only in their options. The forms share one table layout, so a store moves between the first two forms with no new table.

| Form | Options | Key of the store | Table key schema |
|---|---|---|---|
| 1 | none | `string` | partition key `_bkv_pk` (S) |
| 2 | `schema`, `indexes` | `string` | partition key `_bkv_pk` (S) |
| 3 | `schema`, `key` (and `indexes`) | an object with exactly the key fields | the declared fields, types probed from the schema |

## Item layout

An item is stored flat: one DynamoDB attribute for each top-level field of an object value. Any other value (a string, a number, an array, `null`) goes in the attribute `_bkv_value`. The expiry goes in `_bkv_ttl`, unless the `ttl` option names a field of the value.

| Call | Stored item |
|---|---|
| `cache.put('a', 'hello')` | `{ _bkv_pk: 'a', _bkv_value: 'hello' }` |
| `users.put('u1', { name: 'Ada', email: 'ada@example.com' })` | `{ _bkv_pk: 'u1', name: 'Ada', email: 'ada@example.com' }` |
| `orders.put({ userId: 'alice', orderId: '001' }, { total: 12 })` | `{ userId: 'alice', orderId: '001', total: 12 }` |
| any `put` with `{ expiresAt: 1800000000 }` | the same item, plus `_bkv_ttl: 1800000000` |
| `sessions.put({ sessionId: 's1' }, { expiresAt: 1800000000 })` with `ttl: 'expiresAt'` | `{ sessionId: 's1', expiresAt: 1800000000 }` |

A read reverses the layout. `_bkv_pk` becomes the string key; the declared key fields become the key object and stay in the value too, because they are fields of the value. `_bkv_value` becomes the value. `_bkv_ttl` leaves the value and is reported as `expiresAt`; a `ttl` field stays in the value and is also reported as `expiresAt`.

The block owns every top-level attribute name that starts with `_bkv_` ("Blocks key-value"). `put` rejects an object value that has such a field with `ValidationFailedException`, so a value an app builds from request input cannot set the key or the expiry of an item.

`put` also rejects a value that has a field named `__proto__`, at any depth, with `ValidationFailedException`. DynamoDB cannot store that field name: the DynamoDB document client drops the field without an error, so the mock would keep a field that the AWS runtime loses. Both runtimes reject it in `buildItem`, before any I/O, so the same value gives the same stored item or the same error in both.

The layout is implemented once, in `src/item.ts`, and both runtimes call it: `normalizeKey`, `mergeKeyIntoValue`, `buildItem`, `readItem`, the condition planners, and the cursor codec. The mock persists the exact DynamoDB item shape to `.bb-data/{fullId}/store.json`, keyed by the serialized table key, so a mock file shows what DynamoDB would hold.

## Key model

The runtime resolves a `KeyModel` from the options once, in the constructor: the table key attributes, whether the key is declared, the indexes, the TTL attribute, and the DynamoDB type of each key field. A string store keys its table by `_bkv_pk`. A declared key uses the named fields, which the type system requires to be required string or number fields of the schema's output type.

`normalizeKey` checks the key a caller passes against the model before any I/O. A string store takes a string; a declared-key store takes an object with exactly the key fields, no more and no fewer. A wrong shape is `InvalidQueryException`; an empty string in a key field is `ValidationFailedException`. The compiler enforces the same rules for TypeScript callers; the runtime check is for JavaScript callers and casts.

`checkKeyValue` is the one check for a key value: a non-empty string for a string field, a finite number for a number field. A key, the partition value of a `query`, each operand of a sort condition, and each key value inside a cursor pass through it, with the type of the field from `probeKeyType` (index fields included). A wrong type or `NaN` is `InvalidQueryException`. An empty string is `ValidationFailedException`. Inside a cursor, both are the `InvalidQueryException` of a bad cursor. A sort condition must be one known condition: `between` takes two values, and `beginsWith` needs a string field.

The DynamoDB attribute type of a key field or an index field comes from one function, `probeKeyType` in `src/item.ts`, which the CDK layer and both runtimes call (D-KV-17). The field is a number if the schema accepts one of the samples `0`, `1`, `-1` as its value: `validate({ [field]: sample })` reports no issue at the path of the field. In all other cases the field is a string. The CDK layer provisions the attribute with that type, and the runtime rejects a key value of the other type with `InvalidQueryException` before DynamoDB would. There is no third result: a schema that accepts every value (a pass-through validator) makes its key fields numbers in every layer, so a block that wraps the store states the field types in its schema, as `AsyncJob` and `Realtime` do. A schema that validates asynchronously cannot be probed, and its fields count as numbers.

`put` on a declared-key store merges the key into the value (`mergeKeyIntoValue`) before validation, so the schema sees the full item. For a store whose `ttl` option names a field, the expiry of the call goes into that field in the same step (`fullValue`), so the value that the schema validates is the value that the item stores. A key field present in the value must equal the key, or the write is `ValidationFailedException`. The schema validates the merged input value and the block stores that input as it is, as both blocks did before.

## Conditions

The condition rules of `KVStore` stay. On `put`, `ifNotExists` and a value check compose with OR: `attribute_not_exists(#pk) OR <value check>`. The write succeeds when the key is absent or the stored value matches, and fails only when the key exists and the value differs. On `delete`, `ifExists` and a value check compose with AND.

The value check is `ifFieldEquals` for an object value (one clause per field, AND inside, structural equality on nested values) or `ifValueEquals` for any other value (`#value = :expected` on `_bkv_value`). An object is spread over attributes, so DynamoDB cannot compare it in one expression; `ifValueEquals` with an object is a compile error and, from JavaScript, `InvalidQueryException`. `ifFieldEquals` needs at least one defined field; both checks together are rejected.

Both runtimes derive the expression and the `retriable` flag from `putCondition` / `deleteCondition` in `src/item.ts`. A failed condition is an `ApiError` with status 409 and the name `ConditionalCheckFailedException`. `retriable` is `true` whenever a value check took part in a failed `put` (under OR composition the combined failure means the key exists but its value differs, so a re-read and retry can succeed), `true` for a failed `delete` whose value check ran without `ifExists`, and `false` for a pure existence assertion (a blind retry fails identically). DynamoDB collapses every conditional failure under one exception with no sub-reason, so the AWS runtime decides this from the conditions the call set, and the mock matches it branch for branch. The mock lets a condition see an expired item until it is deleted, as DynamoDB does.

## Reads

`get` is a strongly consistent `GetItem` by default (`ConsistentRead: true`). The block holds session, job, and conversation state, where a stale read gives a wrong result with no error; a consistent read costs twice the read capacity, and `consistentRead: false` opts out. `getBatch`, `scan`, and `query` are eventually consistent, and a `query` on an index always is. The mock is always strongly consistent.

Every read hides an item whose TTL attribute has passed, in both runtimes, because DynamoDB deletes an expired item asynchronously (typically within 48 hours). `scan({ includeExpired: true })` is the one way to see such an item, for a cleanup sweep. TTL is always on for a table the block creates, on `_bkv_ttl` or on the `ttl` field.

A store with a `schema` reconciles each read with the schema per `readValidation`, which defaults to `'coerce'` (see [D-015](../../docs/DECISIONS.md#d-015-kvstore-reads-default-to-readvalidation-coerce-not-off)): the coerced output is deep-merged over the raw item so defaults fill in while undeclared stored fields survive a read-modify-write; a row that fails validation is returned raw with a warning; `'strict'` throws `ValidationFailedException`; `'off'` returns the raw value. The merge treats arrays as opaque leaves (defu concatenates arrays by default, which would duplicate elements).

## Query, scan, and pages

`query` reads one partition of the declared key, or of an index, with at most one sort condition; `scan` reads the table. Both check their options when called, before any I/O, and both return a `Results` object: an `AsyncIterable` of `{ key, value, expiresAt? }` entries with a `cursor` property.

The cursor marks the position after the last entry the iterator returned. It encodes the DynamoDB `LastEvaluatedKey` of that position — the table key attributes, plus the index key attributes for an index query — as base64url JSON: `{ v: 1, index: 'byEmail' | null, key: { ... } }`. The cursor is `undefined` when the read reached the end, and `undefined` before iteration starts. A consumer that stops early still gets the position after the last entry it saw. The cursor holds key values in a readable encoding; it is not a secret and not a permission, so an API method must check authorization on every page.

Before it drives a read, a cursor is decoded and checked against the store's key schema: it must decode, must name the same index as the call, must hold exactly the key attributes of that table or index (each a non-empty string or a finite number), and for a `query` its partition value must match `where`. Any failure is `InvalidQueryException`. The mock encodes the same cursor for the same item as the AWS runtime. A `limit` must be a positive integer, or the call is `InvalidQueryException`. A `cursor` or `limit` of `null` counts as absent, as every option with the value `null` does (D-KV-18).

On AWS the block follows `LastEvaluatedKey` until `limit` entries have been yielded or the read ends; expired items are skipped and do not count. The cursor is computed from the last yielded item, not from `LastEvaluatedKey`, so a page that stops in the middle of a DynamoDB page resumes at the right item. DynamoDB can return a `LastEvaluatedKey` after the last item when `Limit` is met exactly; the next page is then empty with no cursor. The mock mirrors this: it returns a cursor whenever `limit` was reached, whether or not more items exist.

The mock sorts a query by the sort key and breaks ties on the base-table key, so an index whose sort key is not unique has a deterministic order that matches DynamoDB's observed ordering; `order: 'desc'` reverses the whole order, ties included. A scan is ordered by the base key so a cursor resumes at the same position after a restart. String comparisons use JavaScript UTF-16 order, which can differ from DynamoDB's UTF-8 byte order for non-ASCII keys.

## Indexes

`indexes` needs a `schema`. An index names one or two fields of the value, each a string or a number. The GSI manager custom resource (`src/gsi-manager-lambda.ts`) creates, changes, and removes indexes as the former block did. DynamoDB holds an item in an index only when each indexed field is present, is not an empty string, and has the declared type; `put` rejects an empty string in an indexed field before it calls DynamoDB, because an empty-string index key is the one case DynamoDB reports as an error instead of a silent omission.

### GSI Management Custom Resource

DynamoDB only allows one GSI change per `UpdateTable` call, and each change can take minutes to hours on large tables (DynamoDB must backfill the index). A standard CDK `Table` construct cannot express multi-GSI changes in a single deployment. KVStore uses a CloudFormation custom resource with the CDK `Provider` framework's async pattern to manage GSIs declaratively.

**Architecture:**

- **`onEvent` handler** — Invoked once per CloudFormation Create/Update/Delete. Compares the table's current GSIs against the desired state. If already matching, returns immediately. Otherwise, initiates the first GSI change and returns `IN_PROGRESS`. For sandbox deployments, takes a fast path (see below).
- **`isCompleteHandler`** — Polled by the Provider framework every 10 seconds (configurable via `queryInterval`), up to a 2-hour total timeout. On each poll:
  1. If the table is busy (a GSI is still creating/deleting), returns `IsComplete: false`.
  2. If the table is idle and matches the desired state, returns `IsComplete: true`.
  3. If the table is idle but doesn't match, initiates the next GSI change and returns `IsComplete: false`.

**Delete:** CloudFormation sends the same Delete request whether `indexes` was removed from the config or the table itself is leaving the stack, and the custom resource (which depends on the table) is deleted while the table still exists in both cases. A `retained`/`locked` table that leaves the stack is orphaned with its data and must keep its indexes (rebuilding a GSI on a large table takes hours); a table that stays must lose the indexes no longer configured. On Delete, `onEvent` therefore reads its own stack with `cloudformation:DescribeStacks` and, during an update's cleanup phase, `cloudformation:GetTemplate` (the current template: the new one after an update, the restored one after a rollback):

| Stack status at Delete | Cause | Table in current template? | Indexes |
|---|---|---|---|
| `DELETE_IN_PROGRESS` | stack delete (also a retried delete, or a nested stack removed by its parent) | (not read) | kept |
| `ROLLBACK_IN_PROGRESS` | the stack's first create failed | (not read) | kept |
| `UPDATE_COMPLETE_CLEANUP_IN_PROGRESS` | `indexes` removed from the config | yes | dropped one at a time |
| `UPDATE_COMPLETE_CLEANUP_IN_PROGRESS` | the KVStore removed from the app | no | kept |
| `UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS` | a failed update had added `indexes` | yes | dropped one at a time |
| `UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS` | a failed update had added the whole table | no | kept |

A `disposable` table that leaves the stack is deleted right after, so keeping its indexes also spares the stack delete the wait for each drop. If a lookup fails (after the SDK's retries), the indexes are kept: the worst case is an unwanted index left in place, visible and removable, rather than a rebuild on a retained table. A `DescribeStacks` failure (status unknown) keeps them and succeeds. A `GetTemplate` failure in one of the two cleanup statuses keeps them and fails the Delete with a message naming the table and its indexes: a failed delete in the cleanup phase is reported as a `DELETE_FAILED` event and does not roll the update back, so the leftover is visible instead of silent. A stack delete never reaches `GetTemplate`, so the failure cannot block one. `onEvent` passes the "keep" verdict to `isCompleteHandler` through its result (the Provider framework merges it into every isComplete call), so only the `onEvent` role holds the permissions. A Delete whose table no longer exists (`ResourceNotFoundException`) succeeds instead of failing the stack operation; Create and Update still fail on a missing table.

**Ordering:** Creations are performed before deletions when possible. This ensures new access patterns are available before old ones are removed. The one exception is schema-mismatched GSIs — if a desired GSI has the same name as an existing GSI but different key schema, the old one must be deleted first because DynamoDB doesn't support in-place GSI modification.

**IAM policies are split by environment:**

| Permission | Production | Sandbox |
|------------|-----------|---------|
| `dynamodb:DescribeTable` | ✅ | ✅ |
| `dynamodb:UpdateTable` | ✅ | ✅ |
| `dynamodb:DeleteTable` | ❌ | ✅ |
| `dynamodb:CreateTable` | ❌ | ✅ |
| `dynamodb:Scan` | ❌ | ✅ |
| `dynamodb:BatchWriteItem` | ❌ | ✅ |
| `cloudformation:DescribeStacks`, `cloudformation:GetTemplate` (own stack only, `onEvent` role only) | ✅ | ✅ |

Production deployments can only add/remove GSIs via `UpdateTable`. The GSI manager lambda cannot drop or recreate the table, scan its data, or batch-write items. This prevents accidental data loss from a misconfigured custom resource.

### Sandbox Deployment Model

Sandbox deployments use a **drop-and-recreate** fast path that bypasses the sequential one-at-a-time GSI limitation:

1. Scan all items from the existing table (backup to memory)
2. Delete the table
3. Wait for deletion to complete
4. Create a new table with all desired GSIs defined upfront (DynamoDB allows multiple GSIs at table creation time)
5. Wait for the table and all GSIs to become ACTIVE
6. Restore all items via `BatchWriteItem`

This is dramatically faster than sequential GSI creation (seconds vs. minutes/hours) but **destroys and recreates the table**. It is only used when `SandboxMode` is `true` (set by the CDK layer based on the `sandboxMode` context variable, read via core's `isSandboxContext()`). The IAM policy for production deployments does not grant the permissions needed for this path, so it cannot execute in production even if `SandboxMode` were accidentally set.

⚠️ **Data loss risk in sandbox:** If the Lambda times out during step 1 (scan) on a very large table, or if the restore in step 6 fails partway through, data may be lost. This is acceptable for sandbox (ephemeral dev environments) but is why the fast path is never used in production.

## Infrastructure (CDK)

Creates a single DynamoDB table:

- **Partition key:** `_bkv_pk` (String) for a store with no `key`; otherwise `options.key.partitionKey`, type probed from the schema
- **Sort key:** `options.key.sortKey`, type probed from the schema (optional)
- **Global secondary indexes:** Managed by the custom resource above
- **TTL:** Always on — `TimeToLiveSpecification` names `options.ttl` or `_bkv_ttl`
- **Billing mode:** PAY_PER_REQUEST
- **Table name:** Derived from `scope.fullId` (includes stack name for uniqueness), a literal in the template so the GSI manager's Delete check can match it
- **Durability & encryption:** Secure-by-default in production — PITR, deletion protection, SSE-KMS, and `RemovalPolicy.RETAIN` (see D-KV-11)
- **Permissions:** `grantReadWriteData` to the parent scope's execution role automatically, plus explicit `dynamodb:Query` on `index/*`

The key fixes when the table is created. A changed `key` option on a deployed store fails the deploy: CloudFormation does not replace a table that has a fixed name, so the table keeps its data. A changed `ttl` option is not guarded (see D-KV-16).

`fromExisting()` binds to a table by name, grants read/write and index query, and provisions nothing else: the customer owns the key schema (which the `key` option must match), the indexes, and the TTL setting of that table. Durability and encryption options passed alongside it warn at synth.

### Durability & encryption

Point-in-Time Recovery resolves from the per-block option first and then the stack-wide `defaults.pointInTimeRecovery` (`BlocksPresets` — on under `production`, off under `sandbox`). Server-side encryption is **not** preset-driven: `BlocksDefaults` carries no encryption field, so SSE defaults to the AWS-managed `aws/dynamodb` key under every preset, and the per-block `encryption` option is the only thing that changes it per store. Both resolve through `resolveDynamoDbProtection` in `@aws-blocks/core/cdk/internal`, shared with every Blocks-provisioned DynamoDB table.

- **`pointInTimeRecovery?: boolean | { retentionDays: number }`** — `true` enables continuous backups with DynamoDB's default 35-day window; `{ retentionDays: n }` both enables PITR and pins the window (**1–35**; an out-of-range value warns at synth and falls back to the default window); `false` disables it. Omitted, it follows `defaults.pointInTimeRecovery`. The `PointInTimeRecoverySpecification` is only emitted when enabled, keeping sandbox/opt-out templates clean.
- **`encryption?: 'aws-managed' | 'customer-managed' | ExternalKmsKeyRef`** — `'aws-managed'` (default) uses the `aws/dynamodb` key; `'customer-managed'` provisions a dedicated CMK per table; `KVStore.fromKmsKey(arn)` reuses an existing CMK you own, so several tables can share one key. An unrecognized value fails the synth with an error listing the valid values; it never falls back to `'aws-managed'`, so a request for a customer-managed key can't be silently downgraded.
- **`protection?: 'disposable' | 'retained' | 'locked'`** — one knob for removal policy and deletion protection; see D-KV-11.

## Mock Implementation

- Data stored in `.bb-data/{scope.fullId}/store.json` via `getMockDataDir()` from core, as a JSON object keyed by the serialized table key whose values are the exact DynamoDB items. An entry that is not an item (a corrupt or pre-merge entry) is skipped on load.
- Data persists across dev server restarts. Customers can wipe with `rm -rf .bb-data`.
- An item whose expiry has passed is dropped when the mock loads its file, in place of DynamoDB's background reaper, so the file does not grow with dead rows.
- `scan` sorts the items by base key once and reuses that order until the next write.
- The mock applies the schema, the key checks, the reserved-field and indexed-field checks, the conditions with the same OR/AND composition and `retriable` derivation, the 400 KB serialized item size limit (`ItemTooLargeException`), expiry on every read, read validation, and the cursor checks, all through the shared code in `src/item.ts` and `src/errors.ts`.
- Index queries are implemented via in-memory filtering and sorting over the full dataset.
- `getBatch`/`putBatch`/`deleteBatch` always process every entry in one pass — the in-memory store never returns `UnprocessedKeys`/`UnprocessedItems`, so the AWS runtime's retry loop and `BatchIncomplete` exhaustion error have no mock equivalent.
- `ifFieldEquals` compares values with an order-independent structural deep-equal. Object/Map keys are compared as a set (DynamoDB Maps are an unordered collection of name-value pairs), while arrays remain order-sensitive (DynamoDB Lists are ordered). The unordered-Map equality of `=` in a DynamoDB condition expression was confirmed against real DynamoDB.

### Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| No throughput limits | Code that would be throttled in AWS succeeds locally | Document the gap; recommend sandbox testing for throughput-sensitive flows |
| Batch retry exhaustion (`BatchIncomplete`) is AWS-runtime only | Under sustained throttling, AWS batch ops retry with backoff and throw `KVStoreErrors.BatchIncomplete` once the attempt budget is reached; the mock never throttles so this path is unreachable locally | Error name and message are single-sourced in `errors.ts` so catch-site handling is identical regardless of backend. Exercise throttling/backoff behavior in sandbox |
| No item size limit enforcement beyond the 400 KB check on the serialized item | Edge cases around DynamoDB marshalling overhead | The mock validates serialized JSON size, which is a close approximation; on AWS the runtime re-maps DynamoDB's size `ValidationException` to the same `ItemTooLarge` name |
| Immediate consistency everywhere (vs eventual for `getBatch`, `scan`, `query`, and every index read on AWS) | A read right after a write always sees it locally; on AWS an index or batch read may briefly miss it | `get` is strongly consistent on both. For the other reads there is no mitigation — eventual consistency is inherently non-deterministic. Document the gap; recommend sandbox testing |
| Expired items are deleted by DynamoDB's reaper (up to 48 h after expiry) | Locally an expired item stays in the store until the dev server restarts: the mock drops expired items when it loads its file | Both layers hide expired items from every read, so observable behavior matches; only physical deletion timing differs. `scan({ includeExpired: true })` sees the remains on both, until each layer removes them |
| Scan order | The mock scans in base-key order; DynamoDB scans in internal hash order | Neither order is a contract. A cursor resumes correctly on both |
| Cursor after the last item | Both return a cursor whenever `limit` was reached, even when no item follows; the next page is then empty with no cursor | Aligned by design, so a paging loop written against the mock terminates the same way on AWS |
| String ordering of sort and base keys | The mock compares with JavaScript `<`/`>` (UTF-16 code-unit order), DynamoDB with UTF-8 byte order; the two differ for some non-ASCII strings | Document the gap; ASCII keys order identically |
| No IAM enforcement | Permission errors only surface in AWS | No mitigation at mock level — IAM is handled by CDK grants automatically |
| Durability/encryption options (`pointInTimeRecovery`, `protection`, `encryption`) are CDK-only | These provisioning-time settings have no observable effect on mock reads/writes | No mitigation needed — they're infrastructure config, not data behavior; verify the synthesized template in sandbox/prod |

## Design decisions

The `D-DT-*` decisions of the former `DistributedTable` block that still apply are carried over here, renumbered `D-KV-*` and rewritten for the merged block; the new decisions of the merge follow them.

### D-KV-1: Key-first calls, with a key object for a declared key

**Decision:** Every data call takes the key first: `get(key)`, `put(key, value)`, `delete(key)`, `getBatch(keys)`, `putBatch([{ key, value }])`, `deleteBatch(keys)`. The key is a `string` on a store with no `key` option, and an object with exactly the declared key fields otherwise.

**Rationale:** One shape of `put` is easier to learn than two, and the block can check that the key and the value agree. For a declared key, every major DynamoDB library uses a key object (AWS SDK v3 DocumentClient `Key: { userId, orderId }`, ElectroDB `.get({ cityId, mallId })`, DynamoDB-Toolbox `.key({ pokemonId })`): a compound key is two values that together identify an item, and an object names them at the call site. A pair of strings (`[partition, sort]`) was considered and rejected: the compiler cannot catch swapped parts, or a string that reaches a store of pairs. The key type is computed from the schema's output type (`KeyOf<Out, K>`), so a brand in the schema turns a swap of two string fields into a compile error.

### D-KV-2: `schema` is optional, and `key`, `indexes`, and `ttl` require it

**Decision:** A store with no options works: a string key and a string value (or the type argument). `key`, `indexes`, and `ttl` are available only together with a `schema`, enforced by the type of the options.

**Rationale:** The consolidation guidance says the zero-options constructor must produce a working block. The key and index configuration reference field names from the schema, and the schema is what makes them type-safe — without it there is no way to validate that a key field exists or holds a string or a number. An explicit type argument together with `key` fails to compile rather than widening the key in silence.

### D-KV-3: StandardSchemaV1 over Zod-specific types

**Decision:** Accept `StandardSchemaV1` from `@standard-schema/spec` instead of Zod-specific structural types, and take both the input type (for `put`) and the output type (for reads, keys, and conditions) from it.

**Rationale:** Building Blocks accept any StandardSchemaV1 implementation. This avoids vendor lock-in to Zod and lets customers use Valibot, ArkType, or any other conforming library. The `@standard-schema/spec` package is types-only (zero runtime). Validation uses `schema['~standard'].validate()`. Reading the two types separately is what lets a brand, a default, or a transform work: a brand exists in the output type only, so keys read from the output type keep it.

### D-KV-4: Conditional operations — `ifNotExists`, `ifExists`, `ifFieldEquals`, `ifValueEquals`

**Decision:** `put` takes `ifNotExists` and a value check; `delete` takes `ifExists` and a value check. The value check is `ifFieldEquals` for an object value and `ifValueEquals` for any other value. On `put` the two compose with OR, on `delete` with AND.

**Rationale:** The block backs application data that often requires coordination — idempotent creates, optimistic locking, and guarded deletes — which map directly to DynamoDB `ConditionExpression`s: `attribute_not_exists(pk)` protects create-only writes, `attribute_exists(pk)` guards deletes, `#field = :value` is compare-and-swap. `ifFieldEquals` compares individual fields because an object value is spread over attributes, so comparing the whole object would need a stored hash; `ifValueEquals` compares the one `_bkv_value` attribute. The OR composition on `put` is the "create it, or update it only if unchanged" pattern that `KVStore` shipped; AND would be unsatisfiable (a key cannot be both absent and hold a matching value). `DistributedTable` allowed one condition per call, so its callers gain the combination and lose nothing.

### D-KV-5: `scan()` not `list()`

**Decision:** The full-table enumeration method is named `scan()`, not `list()`, and it has no prefix option.

**Rationale:** `list` is an avoided verb because it understates the cost of a full table enumeration. `scan` communicates that every item is read and scales with total data size. A `prefix` option would hide that cost (guideline G18): DynamoDB cannot filter a scan by key prefix without reading every item. A store that must list items in order declares a key with a sort field, or adds an index on a field that names the group.

### D-KV-6: Single options object for `query`, with `index`, `where`, `limit`, `order`, and `cursor`

**Decision:** `query(options)` takes a single options object. Omitting `index` queries the declared key; a string store must pass `index`.

**Rationale:** A single options object is consistent with the rest of the API. The `index` field determines which key config applies to `where` — when present, `where` is typed against the index's key config; when absent, against the table's declared key. This is a discriminated union on `index`. The `order` field maps to DynamoDB's `ScanIndexForward` (`'desc'` → `false`) and defaults to `'asc'`. `cursor` is the one new option name of the merge (D-KV-14).

### D-KV-7: TTL always on; `ttl` names a field or the block uses `_bkv_ttl`

**Decision:** Every table the block creates has DynamoDB TTL enabled. By default the expiry is the block's own `_bkv_ttl` attribute, set per write with `ttlSeconds` or `expiresAt`. A store with a schema can set `ttl: '<numberField>'` to keep the expiry in that field of the value, as `DistributedTable` did; a `put` with no expiry option then uses the field, and a `put` with an expiry option writes the field. The block writes the field into the full value before schema validation, so the schema validates the value that is stored.

**Rationale:** `KVStore` made TTL opt-in (`ttl: true`) because enabling it on a deployed table is a live table update; with one attribute name fixed at creation that concern goes away, and expiry is what caches, sessions, codes, and job records all need. Reads hide an expired item in both runtimes regardless of the reaper (DynamoDB deletes asynchronously, typically within 48 hours), so correctness never depends on TTL — it is storage hygiene. The named-field form keeps every `DistributedTable` table in place: its TTL attribute does not change.

### D-KV-8: Split `InvalidQuery` and `ItemTooLarge` rather than one `Validation` bucket

**Decision:** Pre-flight input failures surface as intent-revealing names — `ValidationFailedException` for a value the block will not store, `InvalidQueryException` for a call of the wrong shape, `ItemTooLargeException` for an item over 400 KB — instead of a single generic `ValidationException` that mirrors DynamoDB's wire name.

**Rationale:** `ValidationFailed` is about the value: it fails the schema, disagrees with its key, uses a reserved field name, or has an empty string in a key or indexed field. `InvalidQuery` is about the call: a key of the wrong shape, a missing `where`, a partition key not given as `{ equals }`, an unknown index, more than one sort condition, an empty `ifFieldEquals`, `ifValueEquals` with an object, or a cursor that does not belong to the call. Every one of these is a caller bug. `ItemTooLarge` is not necessarily a caller bug — the size of a record may be outside the caller's control — so a caller may want to branch on it. On AWS, DynamoDB raises a generic `ValidationException` for an oversized item; the runtime narrows on the size-specific message and re-maps only that case, so both layers surface the same name.

### D-KV-9: `retriable` on a 409 conflict marks a value check, not an existence assertion

**Decision:** A `ConditionalCheckFailedException` maps to an `ApiError` with status **409**. `retriable` is `true` when a value check (`ifFieldEquals` / `ifValueEquals`) took part in a failed `put`, `true` for a failed `delete` whose value check ran without `ifExists`, and `false` for a pure `ifNotExists` / `ifExists` assertion.

**Rationale:** A value conflict is genuinely optimistic-concurrency — a re-read and retry can succeed. An existence assertion failure is not: a blind identical retry fails identically. Under the OR composition of `put`, a failure means every arm failed, so if a value arm took part the failure is the stale-value case. On `delete` the existence assertion wins. DynamoDB collapses every conditional failure under one exception with no sub-reason, so the AWS runtime decides from the conditions the call set, and the mock matches it. `retriable` marks the conflict *kind*, not a guarantee that a retry will succeed: a value conflict against a missing row is still flagged retriable.

### D-KV-10: `readValidation` — `off | coerce | strict`, defaulting to `coerce`

The default choice (`'coerce'` over `'off'`) is recorded as a cross-cutting decision in [`docs/DECISIONS.md` D-015](../../docs/DECISIONS.md#d-015-kvstore-reads-default-to-readvalidation-coerce-not-off). Writes always validate. Reads of a store with a schema reconcile each stored item with the schema per the mode: `'coerce'` returns the schema's output deep-merged over the raw item (defaults filled, types narrowed, undeclared stored keys preserved) and falls back to the raw item with a warning; `'strict'` throws `ValidationFailedException`; `'off'` returns the raw item. Coercion is best-effort: a check-only validator returns its input unchanged. Both runtimes call the same `applyReadValidation` in `errors.ts`. A store with no schema returns the raw value.

### D-KV-11: Secure-by-default durability & encryption, sourced from stack `BlocksDefaults`, with one `protection` knob

Durability posture is resolved from the stack-wide `BlocksDefaults` (`BlocksPresets` in `@aws-blocks/core/cdk`): `defaults.removalPolicy`, `defaults.deletionProtection`, and `defaults.pointInTimeRecovery`. Under `BlocksPresets.production` a table defaults to PITR **on**, deletion protection **on**, and `RemovalPolicy.RETAIN`; under `BlocksPresets.sandbox` all three flip off/`DESTROY` so throwaway stacks stay cheap and `sandbox:destroy` is a one-command teardown. SSE defaults to the AWS-managed KMS key. Every default is overridable per store via `protection`, `pointInTimeRecovery`, and `encryption`; a per-block option always wins.

**Why one `protection` knob instead of separate `deletionProtection` + `removalPolicy`.** Deletion protection and removal policy answer a single question — "can this table be destroyed?" — and two booleans can encode a contradiction: `deletionProtection: true` + `removalPolicy: 'destroy'` tells CloudFormation to `DeleteTable` on stack delete while DynamoDB refuses the delete, wedging the stack in `DELETE_FAILED`. One three-value enum (`'disposable'` → DESTROY + unprotected; `'retained'` → RETAIN + unprotected; `'locked'` → RETAIN + protected) makes the invalid combination unrepresentable. The former `KVStore` options `removalPolicy` and `deletionProtection` are therefore gone.

**Bring-your-own / shared CMK.** `encryption: 'customer-managed'` provisions a dedicated CMK per table; `KVStore.fromKmsKey(keyArn)` — a branded `ExternalKmsKeyRef` — shares an existing key across tables. The `encryption` option is a three-way value so a contradictory state (an `'aws-managed'` choice alongside a customer key) cannot be expressed, and the CDK `IKey` type stays out of the public `types.ts`. An auto-created CMK takes the table's resolved removal policy, so it is never less durable than the table it encrypts and a sandbox teardown leaves no orphaned, billed key; when PITR is on and the table is `disposable`, destroying the key also makes the system backup unrestorable once the KMS 30-day window elapses — intentional, a `disposable` table opts out of durable backups. `fromExisting` is untouched: the customer owns that table's durability and encryption.

### D-KV-12: Flat item layout with a reserved `_bkv_` prefix

**Decision:** An object value is stored as one attribute per top-level field; any other value in `_bkv_value`; the key of a string store in `_bkv_pk`; the expiry in `_bkv_ttl` unless `ttl` names a field. Top-level value fields that start with `_bkv_` are rejected.

**Rationale:** A DynamoDB index reads top-level attributes only. With one attribute per field, an index can be added to a table that holds data, and DynamoDB fills it from the items that exist. Every former `DistributedTable` table has this layout already, and so does a table the block did not create. The alternatives — a nested `{ pk, value }` map, or the JSON string `KVStore` used — cannot be indexed, and adding an index later would need a rewrite of every item that the production GSI manager has no permission to perform. The cost is the reserved prefix (Convex reserves `_`, DynamoDB-Toolbox reserves `_et`) and the loss of a whole-object compare (D-KV-4). The prefix check is also a safety rule: a value built from request input must not be able to set the key or the expiry of an item.

### D-KV-13: `get` is strongly consistent by default

**Decision:** `get` sends `ConsistentRead: true` unless `consistentRead: false` is passed. `getBatch`, `scan`, and `query` stay eventually consistent.

**Rationale:** The block holds session, job, and conversation state, where a stale read gives a wrong result with no error; `Agent` already asked for a consistent read on its ownership check, and `AsyncJob` compares versions it just wrote. The stores that hold application state in the wider ecosystem (Durable Objects, Deno KV, Convex) read with strong consistency by default; the stores that default to eventual reads replicate to many locations and say so. A consistent read costs twice the read capacity, so the opt-out stays. A later release can add `consistentRead` to the other reads without breaking anyone.

### D-KV-14: `query` and `scan` return a `Results` object with a checked cursor

**Decision:** Both reads return an `AsyncIterable` of `{ key, value, expiresAt? }` entries with a `cursor` property, and take a `cursor` option. The cursor encodes the `LastEvaluatedKey` as readable base64url JSON and is checked against the store's key schema, the call's index, and the call's partition before use.

**Rationale:** Workers KV, Deno KV, Netlify Blobs, ElectroDB, and Convex all return a cursor so a later request can continue a listing; an iterator alone cannot cross requests. Entries carry the key so a listing can address each item and the expiry so a copy job can pass it back to `put`. The cursor is checked rather than trusted because it comes back from a client: a cursor for another index would make DynamoDB return a confusing `ValidationException`, and a cursor for another partition would silently return another partition's page on an otherwise correct `where`. The cursor is not a secret, so an API method still checks authorization on every page. Both runtimes encode the same cursor for the same item, and both return a cursor whenever `limit` was reached, so a paging loop behaves the same locally and on AWS.

### D-KV-15: Runtime checks for what the compiler cannot see

**Decision:** Both runtimes reject, before any I/O: a key of the wrong shape or type (`InvalidQuery`), a key/value disagreement, a reserved field, a field name that DynamoDB cannot store (`__proto__`, at any depth of the value), an empty string in a key or indexed field, and a value that fails the schema (`ValidationFailed`); `ifValueEquals` with an object, an empty `ifFieldEquals`, a partition value or a sort operand of the wrong type, a sort condition that does not exist, and a bad cursor (`InvalidQuery`). The checks live in `src/item.ts` and the messages in `src/errors.ts`, shared by both runtimes.

**Rationale:** The type system enforces these for TypeScript callers; JavaScript callers, casts, and request-shaped values reach the runtime unchecked. Doing the checks in shared code keeps the mock and AWS runtime byte-for-byte aligned on what they accept and on the error they throw, which the parity tests assert. A key-type mismatch is caught with the type that the CDK layer provisions (D-KV-17), because DynamoDB's own error for it does not name the cause.

### D-KV-16: No guard for a `ttl` change on a deployed store (deferred)

**Decision:** The block does not detect a change to the `ttl` option of a deployed store. The README tells users not to change it in place.

**Rationale:** A `ttl` change strands the expiry of existing items in the old attribute, so they stop expiring and reads stop hiding them. CloudFormation requires TTL to be off before the attribute name changes, and the block never turns TTL off, so the deploy is expected to fail — but the error would not name the cause. A clear and early failure needs a check before the deploy; the `predeploy` hook for blocks is a work in progress, so the guard waits for it. A `key` change needs no guard: DynamoDB cannot change a table's key schema and CloudFormation does not replace a named table, so that deploy fails and the table keeps its data.

### D-KV-17: One key-type probe for the CDK layer and the runtimes

**Decision:** `probeKeyType(schema, field)` in `src/item.ts` gives the DynamoDB type of a key field or an index field, and every layer calls it. A field is a number (`N`) if the schema accepts one of the number samples `0`, `1`, `-1` at the path of the field. In all other cases it is a string (`S`). A store with no schema has string fields. A schema that validates asynchronously counts as one that accepts the sample, as the CDK layer always treated it. There is no "unknown" result.

**Rationale:** The CDK layer used a `0` probe. The runtimes used a `0` and `'x'` probe with a third result for a schema that accepted both. The runtime could then accept a key that the table could not hold, and a block with a pass-through schema needed a second schema for synth. With one function, the runtime accepts exactly the type that the table has, and a block ships one schema (`Realtime` now has one, in `connections.ts`, as `AsyncJob` has `statusTableOptions`). Three samples make a refined number field (`z.number().positive()`, `z.number().negative()`) a number. With the `0` probe alone, the CDK layer provisioned such a field as a string, and a write of a number to it failed on DynamoDB.

**Limits:** A number field that rejects all three samples (for example `z.number().min(5)`) reads as a string; keep such a refinement out of a key field. A field that accepts a string and a number is a number. A key field whose schema rejects `0` and accepts `1` or `-1` is `N` now and was `S` before; DynamoDB cannot change the key type of a table, so a deploy over such a table fails and the table keeps its data.

### D-KV-18: An option with the value `null` counts as absent

**Decision:** Each public method that reads options passes them through one function, `presentOptions` in `src/item.ts`, which takes out every option whose value is `null`. The rule holds for every option of every method, in both runtimes. The option types do not include `null`. The exceptions are the two value checks: `ifValueEquals: null` compares with a stored `null`, and `ifFieldEquals: null` is `InvalidQueryException`.

**Rationale:** JSON has no `undefined`. An API method that forwards its arguments into the options of a store (`store.scan({ limit, cursor })`) can get `null` for an argument that the client left out. The RPC client of `@aws-blocks/core` leaves trailing `undefined` arguments out of a request, which covers the usual case; this rule covers an `undefined` before a later argument, and a caller that is not that client. Before, `cursor`, `limit` and `index` each had their own check and the other options had none: `expiresAt: null` was an error. One function gives one rule.

The value checks are excluded because they guard a write. `get` returns `null` for a missing key, so `put(key, next, { ifValueEquals: await store.get(key) })` must be a conflict for a missing key. If `null` counted as absent there, the write would run with no condition.
