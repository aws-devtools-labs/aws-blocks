# KVStore design

Design document for KVStore. For usage, see [README.md](./README.md).

**Package:** `@aws-cdk-blocks/bb-kv-store`
**Type:** Primitive (new infrastructure)
**AWS Service:** DynamoDB (one table per store: a partition key, an optional sort key, optional global secondary indexes)

KVStore is the one NoSQL block of AWS CDK Blocks. It is one package, one class, and one error constant. A store has three forms that differ only in their options. The forms share one table layout, so a store moves between the first two forms with no new table. The block replaces the earlier `KVStore` and the former `DistributedTable` block. The [design decisions](#design-decisions) record what came from each.

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

A read reverses the layout. `_bkv_pk` becomes the string key. The declared key fields become the key object and stay in the value too, because they are fields of the value. `_bkv_value` becomes the value. `_bkv_ttl` leaves the value and is reported as `expiresAt`. A `ttl` field stays in the value and is also reported as `expiresAt`.

The block owns every top-level attribute name that starts with `_bkv_` ("Blocks key-value"). `put` rejects an object value that has such a field with `ValidationFailedException`. So a value that an app builds from request input cannot set the key or the expiry of an item.

`put` also rejects a value that has a field named `__proto__`, at any depth, with `ValidationFailedException`. DynamoDB cannot store that field name: the DynamoDB document client drops the field without an error, so the mock would keep a field that the AWS runtime loses. Both runtimes reject it in `buildItem`, before any I/O, so the same value gives the same stored item or the same error in both.

The layout is implemented once, in `src/item.ts`, and both runtimes call it: `normalizeKey`, `mergeKeyIntoValue`, `buildItem`, `readItem`, the condition planners, and the cursor codec. The mock persists the exact DynamoDB items to `.cdk-blocks/local/data/{fullId}/store.json`, in a file with a version (`{ "version": 2, "items": [...] }`), so a mock file shows what DynamoDB would hold.

## Key model

The runtime resolves a `KeyModel` from the options once, in the constructor. The model holds the table key attributes, whether the key is declared, the indexes, the TTL attribute, and the DynamoDB type of each key field. A string store keys its table by `_bkv_pk`. A declared key uses the named fields, which the type system requires to be required string or number fields of the schema's output type.

`normalizeKey` checks the key a caller passes against the model before any I/O. A string store takes a string. A declared-key store takes an object with exactly the key fields, no more and no fewer. A wrong shape is `InvalidQueryException`. An empty string in a key field is `ValidationFailedException`. The compiler enforces the same rules for TypeScript callers. The runtime check is for JavaScript callers and casts.

`checkKeyValue` is the one check for a key value: a non-empty string for a string field, a finite number for a number field. Four kinds of value pass through it: a key, the partition value of a `query`, each operand of a sort condition, and each key value inside a cursor. The type of the field comes from `probeKeyType`, for index fields too. A wrong type or `NaN` is `InvalidQueryException`. An empty string is `ValidationFailedException`. Inside a cursor, both are the `InvalidQueryException` of a bad cursor. A sort condition must be one known condition: `between` takes two values, and `beginsWith` needs a string field.

The DynamoDB attribute type of a key field or an index field comes from one function, `probeKeyType` in `src/item.ts`, which the CDK layer and both runtimes call (D-KV-17). The field is a number if the schema accepts one of the samples `0`, `1`, `-1` as its value: `validate({ [field]: sample })` reports no issue at the path of the field. In all other cases the field is a string. The CDK layer provisions the attribute with that type, and the runtime rejects a key value of the other type with `InvalidQueryException` before DynamoDB would. There is no third result. A schema that accepts every value, a pass-through validator, makes its key fields numbers in every layer. So a block that wraps the store states the field types in its schema, as `AsyncJob` and `Realtime` do. A schema that validates asynchronously cannot be probed, and its fields count as numbers.

`put` on a declared-key store merges the key into the value (`mergeKeyIntoValue`) before validation, so the schema sees the full item. For a store whose `ttl` option names a field, the expiry of the call goes into that field in the same step (`fullValue`). So the value that the schema validates is the value that the item stores. A key field present in the value must equal the key, or the write is `ValidationFailedException`. The schema validates the merged input value, and the block stores that input as it is.

## Conditions

On `put`, `ifNotExists` and a value check compose with OR. The expression is `attribute_not_exists(#pk) OR <value check>`. The write succeeds when the key is absent or the stored value matches. It fails only when the key exists and the value differs. On `delete`, `ifExists` and a value check compose with AND.

The value check is `ifFieldEquals` for an object value, or `ifValueEquals` for any other value. `ifFieldEquals` gives one clause for each field, joined with AND, with structural equality on nested values. `ifValueEquals` gives `#value = :expected` on `_bkv_value`. An object is spread over attributes, so DynamoDB cannot compare it in one expression. `ifValueEquals` with an object is a compile error and, from JavaScript, `InvalidQueryException`. `ifFieldEquals` needs at least one defined field. Both checks together are rejected.

Both runtimes derive the expression and the `retriable` flag from `putCondition` and `deleteCondition` in `src/item.ts`. A failed condition is an `ApiError` with status 409 and the name `ConditionalCheckFailedException`. `retriable` is `true` when a value check took part in a failed `put`, and for a failed `delete` that had a value check and no `ifExists`. It is `false` for an existence check alone. D-KV-9 has the reasons. DynamoDB reports every failed condition as one exception with no reason, so the AWS runtime decides `retriable` from the conditions that the call set. The mock decides it the same way. The mock lets a condition see an expired item until it is deleted, as DynamoDB does.

## Reads

`get` is a strongly consistent `GetItem` by default (`ConsistentRead: true`). The block holds session, job, and conversation state, where a stale read gives a wrong result with no error. A consistent read costs twice the read capacity, and `consistentRead: false` opts out. `getBatch`, `scan`, and `query` are eventually consistent, and a `query` on an index always is. The mock is always strongly consistent.

Every read hides an item whose TTL attribute has passed, in both runtimes, because DynamoDB deletes an expired item asynchronously (typically within 48 hours). `scan({ includeExpired: true })` is the one way to see such an item, for a cleanup sweep. TTL is always on for a table the block creates, on `_bkv_ttl` or on the `ttl` field.

A store with a `schema` checks each item that it reads against the schema. The `readValidation` option sets how, and it defaults to `'coerce'`. [D-015](../../docs/DECISIONS.md#d-015-kvstore-reads-default-to-readvalidation-coerce-not-off) records why.

- `'coerce'` merges the output of the schema over the stored item. Defaults fill in. Stored fields that the schema does not declare stay, so a read followed by a `put` does not delete them. An item that fails validation is returned as stored, with a warning.
- `'strict'` throws `ValidationFailedException` for an item that fails validation.
- `'off'` returns the stored item with no validation.

The merge replaces an array as a whole. `defu` concatenates arrays by default, and that would duplicate every element.

## Query, scan, and pages

`query` reads one partition of the declared key, or of an index, with at most one sort condition. `scan` reads the table. Both check their options when called, before any I/O, and both return a `Results` object: an `AsyncIterable` of `{ key, value, expiresAt? }` entries with a `cursor` property.

The cursor marks the position after the last entry the iterator returned. It encodes the DynamoDB `LastEvaluatedKey` of that position as base64url JSON: `{ v: 1, index: 'byEmail' | null, key: { ... } }`. The key holds the table key attributes, plus the index key attributes for an index query. The cursor is `undefined` when the read reached the end, and `undefined` before iteration starts. A consumer that stops early still gets the position after the last entry it saw. The cursor holds key values in a readable encoding. It is not a secret and not a permission, so an API method must check authorization on every page.

The block decodes a cursor and checks it against the key schema of the store before the cursor drives a read. The cursor must pass four checks:

- It decodes.
- It names the same index as the call.
- It holds exactly the key attributes of that table or index, each a non-empty string or a finite number.
- For a `query`, its partition value matches `where`.

Any failure is `InvalidQueryException`. The mock encodes the same cursor for the same item as the AWS runtime. A `limit` must be a positive integer, or the call is `InvalidQueryException`. A `cursor` or `limit` of `null` counts as absent, as every option with the value `null` does (D-KV-18).

On AWS the block follows `LastEvaluatedKey` until `limit` entries have been yielded or the read ends. Expired items are skipped and do not count. The cursor is computed from the last yielded item, not from `LastEvaluatedKey`, so a page that stops in the middle of a DynamoDB page resumes at the right item. DynamoDB can return a `LastEvaluatedKey` after the last item when `Limit` is met exactly. The next page is then empty with no cursor. The mock does the same. It returns a cursor whenever `limit` was reached, whether or not more items exist.

The mock sorts a query by the sort key and breaks ties on the base-table key. So an index whose sort key is not unique has a deterministic order, and that order matches the order observed on DynamoDB. `order: 'desc'` reverses the whole order, ties included. A scan is ordered by the base key so a cursor resumes at the same position after a restart. String comparisons use DynamoDB's UTF-8 byte order, so a non-ASCII key sorts and matches a range condition the same way on both.

## Indexes

`indexes` needs a `schema`. An index names one or two fields of the value, each a string or a number. The GSI manager custom resource (`src/gsi-manager-lambda.ts`) creates, changes, and removes indexes. DynamoDB holds an item in an index only when each indexed field is present. A present indexed field must be a non-empty value of the declared type: DynamoDB rejects an empty string, `null`, or a value of the other type with a `ValidationException`. `put` rejects an empty string in an indexed field before it calls DynamoDB. It does not check the type, so that error comes from DynamoDB (see [Differences between the mock and AWS](#differences-between-the-mock-and-aws)). Every index the custom resource creates uses `ProjectionType: 'ALL'`, so an index query returns whole items. A `fromExisting` table keeps the projections of its own indexes.

### GSI management custom resource

DynamoDB allows only one GSI change for each `UpdateTable` call. A change can take minutes to hours on a large table, because DynamoDB must backfill the index. A standard CDK `Table` construct cannot express several GSI changes in one deployment. KVStore manages GSIs declaratively with a CloudFormation custom resource that uses the async pattern of the CDK `Provider` framework.

**Architecture:**

- **`onEvent` handler:** CloudFormation invokes it once for each Create, Update, or Delete. It compares the current GSIs of the table with the desired state. If they match, it returns at once. Otherwise, it starts the first GSI change and returns `IN_PROGRESS`. For a sandbox deployment, it takes a fast path (see [Sandbox deployment model](#sandbox-deployment-model)).
- **`isCompleteHandler`:** The Provider framework polls it every 10 seconds, which `queryInterval` sets, up to a total timeout of 2 hours. On each poll:
  1. If the table is busy, because a GSI is still being created or deleted, it returns `IsComplete: false`.
  2. If the table is idle and matches the desired state, it returns `IsComplete: true`.
  3. If the table is idle and does not match, it starts the next GSI change and returns `IsComplete: false`.

**Delete:** CloudFormation sends the same Delete request in two cases: `indexes` was removed from the config, or the table itself leaves the stack. In both cases the custom resource depends on the table, so CloudFormation deletes the custom resource while the table still exists. The two cases need opposite results. A `retained` or `locked` table that leaves the stack stays in the account with its data. It must keep its indexes, because a rebuild of a GSI on a large table takes hours. A table that stays in the stack must lose the indexes that are no longer configured. To tell the cases apart, `onEvent` reads its own stack on Delete with `cloudformation:DescribeStacks`. During the cleanup phase of an update, it also reads the current template with `cloudformation:GetTemplate`. The current template is the new one after an update, and the restored one after a rollback.

| Stack status at Delete | Cause | Table in current template? | Indexes |
|---|---|---|---|
| `DELETE_IN_PROGRESS` | stack delete (also a retried delete, or a nested stack removed by its parent) | (not read) | kept |
| `ROLLBACK_IN_PROGRESS` | the stack's first create failed | (not read) | kept |
| `UPDATE_COMPLETE_CLEANUP_IN_PROGRESS` | `indexes` removed from the config | yes | dropped one at a time |
| `UPDATE_COMPLETE_CLEANUP_IN_PROGRESS` | the KVStore removed from the app | no | kept |
| `UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS` | a failed update had added `indexes` | yes | dropped one at a time |
| `UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS` | a failed update had added the whole table | no | kept |

A `disposable` table that leaves the stack is deleted right after. Its indexes are kept too, so the stack delete does not wait for each drop.

If a lookup fails after the retries of the SDK, the indexes are kept. The worst case is then an unwanted index that is visible and that you can remove, and not a rebuild on a retained table. The two lookups fail in different ways:

- A `DescribeStacks` failure leaves the status unknown. The handler keeps the indexes, and the Delete succeeds.
- A `GetTemplate` failure in one of the two cleanup statuses keeps the indexes and fails the Delete, with a message that names the table and its indexes. CloudFormation reports a failed delete in the cleanup phase as a `DELETE_FAILED` event and does not roll the update back, so the index that is left is visible.

A stack delete never reaches `GetTemplate`, so a `GetTemplate` failure cannot block a stack delete. `onEvent` passes its decision to keep the indexes to `isCompleteHandler` through its result, which the Provider framework merges into every `isComplete` call. So only the `onEvent` role holds the CloudFormation permissions. A Delete whose table no longer exists (`ResourceNotFoundException`) succeeds, so it does not fail the stack operation. Create and Update still fail on a missing table.

**Ordering:** The handler creates indexes before it deletes indexes when it can, so a new access pattern is available before an old one goes. There is one exception. A desired GSI can have the name of an existing GSI and a different key schema. In that case the handler deletes the old GSI first, because DynamoDB cannot change the key schema of a GSI in place.

**IAM policies are split by environment:**

| Permission | Production | Sandbox |
|------------|-----------|---------|
| `dynamodb:DescribeTable` | yes | yes |
| `dynamodb:UpdateTable` | yes | yes |
| `dynamodb:DeleteTable` | no | yes |
| `dynamodb:CreateTable` | no | yes |
| `dynamodb:Scan` | no | yes |
| `dynamodb:BatchWriteItem` | no | yes |
| `dynamodb:ListTagsOfResource`, `dynamodb:TagResource` | no | yes |
| `dynamodb:DescribeTimeToLive`, `dynamodb:UpdateTimeToLive` | no | yes |
| `dynamodb:DescribeContinuousBackups`, `dynamodb:UpdateContinuousBackups` | no | yes |
| `kms:DescribeKey`, `kms:CreateGrant`, `kms:Decrypt`, `kms:Encrypt`, `kms:ReEncrypt*`, `kms:GenerateDataKey*` (the customer key of a store only, through DynamoDB only: `kms:ViaService`) | no | only for a store with a customer-managed key |
| `cloudformation:DescribeStacks`, `cloudformation:GetTemplate` (own stack only, `onEvent` role only) | yes | yes |

A production deployment can add and remove GSIs only through `UpdateTable`. The GSI manager Lambda function cannot drop or recreate the table, scan its data, or batch-write items. So a misconfigured custom resource cannot delete production data.

### Sandbox deployment model

A sandbox deployment drops the table and creates it again. This fast path avoids the limit of one GSI change at a time:

1. Read the settings of the existing table: server-side encryption, user tags, TTL, point-in-time recovery, the stream and the table class. If a read fails, the handler stops before it deletes anything.
2. Scan all items of the existing table into memory.
3. Delete the table.
4. Wait until the deletion is complete.
5. Create a new table with all desired GSIs, with the same encryption, tags, stream and table class. DynamoDB accepts several GSIs when it creates a table.
6. Wait until the table and all GSIs are ACTIVE.
7. Turn TTL (on the same attribute) and point-in-time recovery (with the same recovery period) back on, if they were on. DynamoDB sets both only on an ACTIVE table, and refuses point-in-time recovery for a short time after the table is created, so the handler retries it. A failure in this step is reported after step 8, so it does not cost the items.
8. Write all items back with `BatchWriteItem`, 25 at a time. A new on-demand table throttles a fast restore of large items; `BatchWriteItem` then succeeds and returns the items it did not write. The handler sends those again, with a wait that doubles from 0.1 s to 5 s, up to 12 attempts for a batch.

So the new table has the settings that the CDK layer gave the old one: the AWS-managed key or the customer key of `encryption`, TTL on `_bkv_ttl` or the `ttl` field, the stack tags, and point-in-time recovery when it is on. DescribeTable reports a key ARN for the AWS-managed key too, so the CDK layer passes the ARN of a customer key in the `EncryptionKeyArn` property of the custom resource (sandbox only). Tags whose key starts with `aws:`, such as `aws:cloudformation:stack-name`, cannot be set by a caller, so the new table does not have them. A new table also has a new stream ARN, so a consumer of the old stream must subscribe again.

The handler copies the settings of the live table, so a table that has lost them would stay without them. `1.0.0-rc.0` recreated tables with only their keys and indexes, and left such tables behind. In sandbox the CDK layer therefore also passes what it declares in the `DeclaredSettings` property: the TTL attribute, and point-in-time recovery with its recovery period. A live table that lacks one of them, or has no KMS encryption (the CDK layer always sets the AWS-managed key or a customer key), gets it on the new table. The handler checks this also when the indexes already match, and then runs the fast path for the settings alone. If it cannot read the settings in that case, it leaves the table as it is.

The GSI manager role uses a customer key through DynamoDB to create the table and to copy its items. A key from `KVStore.fromKmsKey()` must allow that role in its key policy, either by name or by a statement that delegates to account IAM. With a key policy that does not allow the role at all, the scan of step 2 is denied: nothing is deleted, and the index change does not deploy.

A table with deletion protection (`protection: 'locked'`) is never deleted. Its GSIs change one at a time through `UpdateTable`, as in production.

The fast path takes seconds where one change at a time takes minutes to hours, but it **destroys the table and creates it again**. The handler uses it only when `SandboxMode` is `true`. The CDK layer sets `SandboxMode` from the `sandboxMode` context variable, which it reads with `isSandboxContext()` from core. The IAM policy of a production deployment does not grant the permissions that the fast path needs. So the fast path cannot run in production, even with `SandboxMode` set by mistake.

**Data loss risk in sandbox:** Data can be lost in three cases. The Lambda function times out after the delete of step 3 on a very large table, CreateTable in step 5 fails, or the restore of step 8 fails partway: a write is refused, or a batch still has unprocessed items after its last attempt, in which case the handler fails and reports how many items were not written back. A sandbox is a short-lived development environment, so the risk is acceptable there. It is the reason that production never uses the fast path.

## Infrastructure (CDK)

The CDK layer creates one DynamoDB table:

- **Partition key:** `_bkv_pk` (String) for a store with no `key`. Otherwise `options.key.partitionKey`, with the type probed from the schema.
- **Sort key:** Optional. `options.key.sortKey`, with the type probed from the schema.
- **Global secondary indexes:** Managed by the custom resource above.
- **TTL:** Always on. `TimeToLiveSpecification` names `options.ttl` or `_bkv_ttl`.
- **Billing mode:** PAY_PER_REQUEST.
- **Table name:** Derived from `scope.fullId`, which includes the stack name and so is unique. The name is a literal in the template, so the Delete check of the GSI manager can match it.
- **Durability and encryption:** Secure by default in production, with PITR, deletion protection, SSE-KMS, and `RemovalPolicy.RETAIN` (see D-KV-11).
- **Permissions:** `grantReadWriteData` to the execution role of the parent scope, plus `dynamodb:Query` on `index/*`.

A store fixes its key when the table is created. A changed `key` option on a deployed store fails the deploy, because CloudFormation does not replace a table that has a fixed name. The table keeps its data. A changed `ttl` option is not guarded (see D-KV-16).

`fromExisting()` binds to a table by name, grants read, write, and index query access, and provisions nothing else. The customer owns the key schema, which the `key` option must match, and also the indexes and the TTL setting of that table. A durability or encryption option passed with `fromExisting()` gives a warning at synth.

### Durability and encryption

Point-in-Time Recovery comes from the option of the block first, and then from the stack-wide `defaults.pointInTimeRecovery`. `BlocksPresets` turns it on under `production` and off under `sandbox`. Server-side encryption does **not** come from a preset. `BlocksDefaults` has no encryption field, so SSE defaults to the AWS-managed `aws/dynamodb` key under every preset, and only the `encryption` option of a store changes it. `resolveDynamoDbProtection` in `@aws-cdk-blocks/core/cdk/internal` resolves both, for every DynamoDB table that CDK Blocks provisions.

- **`pointInTimeRecovery?: boolean | { retentionDays: number }`:** `true` turns on continuous backups with the default 35-day window of DynamoDB. `{ retentionDays: n }` turns on PITR and sets the window to `n` days, from 1 to 35. A value outside that range gives a warning at synth, and the default window applies. `false` turns PITR off. When the option is omitted, `defaults.pointInTimeRecovery` applies. The template has a `PointInTimeRecoverySpecification` only when PITR is on.
- **`encryption?: 'aws-managed' | 'customer-managed' | ExternalKmsKeyRef`:** `'aws-managed'`, the default, uses the `aws/dynamodb` key. `'customer-managed'` provisions a dedicated CMK for each table. `KVStore.fromKmsKey(arn)` uses a CMK that you own, so several tables can share one key. An unrecognized value fails the synth with an error that lists the valid values. It never falls back to `'aws-managed'`, so a request for a customer-managed key cannot be downgraded with no error.
- **`protection?: 'disposable' | 'retained' | 'locked'`:** One option for the removal policy and deletion protection. See D-KV-11.

## LegacyKVStore: the store of release 0.4.0 or earlier

Release 0.4.0 or earlier keys its table by `pk` and keeps the value as JSON text in `value`, with the expiry in `ttl`. This release keys a string-key table by `_bkv_pk` and keeps one attribute for each field. The key of a DynamoDB table cannot change, and CloudFormation does not replace a table that has a fixed name. So a `KVStore` of this release cannot take over that table. `LegacyKVStore` keeps the table usable for the time that an app needs to copy its items into a `KVStore` with a new id.

**The construct** (`legacy/cdk.ts`) declares the table as release 0.4.0 declares it. The table has the name from `fullId`, the key `pk`, PAY_PER_REQUEST billing, and TTL on `ttl` only with `ttl: true`. The removal policy, deletion protection, point-in-time recovery, and encryption are those that the options of that release give. The construct path is `<parent>/<id>/table`, as in release 0.4.0. The path gives the logical id, so CloudFormation sees the table that it has and makes no change to it. The options of `LegacyKVStore` are the options of that release for this reason: the declaration must match. The execution role gets `grantReadWriteData`, as in release 0.4.0, so the policy of the role does not change either.

**The AWS runtime** (`legacy/aws.ts`) reads with `GetItem` and `Scan`, writes with `PutItem`, and deletes with `DeleteItem`. The layout is in `legacy/layout.ts`: a value is `JSON.parse` of the `value` attribute, and an item whose `value` is not JSON text is a `ValidationFailed` error that names the key. The key check, the cursor, the page logic (`requestResults` in `item.ts`), and the expiry filter are those of `KVStore`, over a key model with `pk` and `ttl`.

**The mock** (`legacy/mock.ts`) holds the same items as the table: `loadReleaseFile` in `mock-file.ts` reads the data file of the old store, `.cdk-blocks/local/data/{fullId}/store.json`, as items in the layout of release 0.4.0. So the mock and the AWS runtime share the reader, the key check, the cursor, and the expiry filter, and a cursor of one reads on in the other. An entry is read as release 0.4.0 reads it, and an entry that release 0.4.0 leaves out is left out. The load keeps an expired item, so `includeExpired` works as on AWS. The load does not change the file.

If the app ran once on this release with the old line unchanged, the mock of `KVStore` loaded that directory first. It converted `store.json`, or it could not convert it and set it aside. Both leave the file of release 0.4.0 as a copy, `store.json.bak` (the loader of `KVStore` keeps that copy before it converts), and `loadReleaseFile` reads the copy. It does not turn a converted file back: a conversion under the options of the old line (`ttl: true`) does not keep the expiry where a read can find it. What that `KVStore` wrote to the converted file is not read. A `put` or a `delete` writes `store.json` as a version 1 file.

**`put`** writes an item in the layout of release 0.4.0: the JSON text of the value in `value`, and the expiry in `ttl`. `releaseWrite` in `legacy/layout.ts` checks the call for both runtimes in one order: the key, the value against the `schema`, and the expiry. The conditions are those of release 0.4.0, `ifNotExists` and `ifValueEquals` on the JSON text, joined with OR. `delete` takes `ifExists` and `ifValueEquals`, joined with AND, as release 0.4.0 does. So the code that writes the old store runs unchanged, and the first deploy can change the class and nothing else. The block does not carry a write of the old store to the new one, and it does not say how the app migrates its data. While an app reads both stores, the old value of a key shows again whenever only the new store loses the key. The value comes back through the copy, and through a read that falls back to the old store. The README lists that case and the others.

**Deprecated and frozen.** The class has the `@deprecated` tag in every entry point from its first release, so an editor marks each use. The tag points to the README section. The API is frozen at the methods of release 0.4.0: `get`, `put`, `delete`, and `scan`. `put` and `delete` take the options of that release. `scan` also takes `limit` and `cursor` and returns `expiresAt`, and `get` is a consistent read by default. The class gets fixes and no new feature: no declared key, no index, no `query`, and no batch call. A need for one of those is a reason to finish the copy and use `KVStore`. The class can go when the upgrades from those releases end.

**What the block does not do** is migrate the data. The app migrates it in its own code, however is appropriate for it. A copy is a `scan` of the old store and a `put` with `ifNotExists` into the new one. Then the app removes the `LegacyKVStore` in a later deploy. See D-KV-20.

## Mock implementation

- Data is stored in `.cdk-blocks/local/data/{scope.fullId}/store.json` through `getMockDataDir()` from core, as `{ "version": 2, "items": [...] }`, where each entry of `items` is the exact DynamoDB item. The file format and its loader are in `src/mock-file.ts` (D-KV-19).
- The loader converts the two earlier formats, and keeps a copy of a version 1 `store.json` as `store.json.bak` before the store writes the file again. Version 1 is the `store.json` of `KVStore` before the merge: an object of key to JSON string, or of key to `{ value, ttl }`. The other is the `data.json` of `DistributedTable`, which the loader reads when the directory has no `store.json`. A conversion uses the layout of a write and is all or nothing. The store then writes `store.json` in the current format. A `data.json` stays where it is.
- An entry of a current-format file that is not an item of the store (a corrupt entry) is left out. The mock keeps a copy of the file as `store.json.bak` and reports it once at warn level.
- A file in any other shape is renamed to a `.bak` file and reported once at warn level, and the store starts empty. The mock does not write over a file that it cannot read.
- Data persists across dev server restarts. Customers can delete it with `rm -rf .cdk-blocks/local/data .bb-data`.
- The mock drops an item whose expiry has passed when it loads its file, so the file does not grow with expired items. This takes the place of the background deletion that DynamoDB does.
- `scan` sorts the items by base key once and reuses that order until the next write.
- Every write stores a copy of the item made with `marshall` then `unmarshall` from `@aws-sdk/util-dynamodb`, with the options the AWS runtime passes to its DocumentClient (`MARSHALL_OPTIONS` in `src/item.ts`). A value that DynamoDB cannot store (an empty Set, a `Date`, `NaN`, a class instance, an integer above `Number.MAX_SAFE_INTEGER`) fails locally with the marshaller's error. A value that the marshaller converts reads back converted: a `Map` as an object, `-0` as `0`, a `bigint` as a number, and `undefined` dropped at any depth. Every read returns a copy, so changing an object after `put` or changing a returned value never changes the stored item.
- The mock applies the same checks as the AWS runtime, through the shared code in `src/item.ts` and `src/errors.ts`:
  - the schema, the key checks, the reserved-field check, and the indexed-field check
  - the conditions, with the same OR and AND composition and the same `retriable` rule
  - the 400 KB item size limit (`ItemTooLargeException`), measured the way DynamoDB measures an item (`src/item-size.ts`)
  - DynamoDB's key and nesting limits: a partition key value of at most 2,048 bytes, a sort key value of at most 1,024 bytes (both for the table and for an index), and lists or maps nested at most 32 levels deep (`ValidationFailedException`)
  - a `between` whose bounds are reversed, and a batch that repeats a key within one DynamoDB request of 25 writes or 100 reads (`InvalidQueryException`). A key repeated in a later request is allowed, and the later write wins, as on AWS
  - expiry on every read, read validation, and the cursor checks
- An index query filters and sorts all items in memory.
- `getBatch`, `putBatch`, and `deleteBatch` always process every entry in one pass. The in-memory store never returns `UnprocessedKeys` or `UnprocessedItems`, so the retry loop of the AWS runtime and its `BatchIncomplete` error have no mock equivalent.
- `ifFieldEquals` compares values with an order-independent structural deep-equal. The keys of an object or a Map are compared as a set, because a DynamoDB Map is an unordered collection of name-value pairs. Arrays stay order-sensitive, because a DynamoDB List is ordered. The unordered-Map equality of `=` in a DynamoDB condition expression was confirmed against real DynamoDB.

### Differences between the mock and AWS

| Difference | Impact | Mitigation |
|------------|--------|------------|
| No throughput limits | Code that would be throttled in AWS succeeds locally | Document the gap, and recommend sandbox testing for flows that are sensitive to throughput |
| Batch retry exhaustion (`BatchIncomplete`) is AWS-runtime only | Under sustained throttling, AWS batch ops retry with backoff and throw `KVStoreErrors.BatchIncomplete` once the attempt budget is reached. The mock never throttles, so this path is unreachable locally | The error name and message are defined once in `errors.ts`, so the code that catches the error is the same for both. Exercise throttling and backoff in sandbox |
| Item size is computed, not measured by DynamoDB | The mock follows DynamoDB's documented sizing rules. A number's size is an approximation (about one byte per two significant digits) | Keep items well under 400 KB. An item at the exact limit with many numbers can land on either side of it. On AWS the runtime re-maps DynamoDB's size `ValidationException` to the same `ItemTooLarge` name |
| The data file is JSON | A Set or a binary value reads back as itself until the dev server restarts. After the reload it is a plain object | Store a set as an array when a value must survive a restart locally. Check set and binary attributes in sandbox |
| DynamoDB's number range is not checked | A number that the marshaller accepts but DynamoDB rejects (for example `1e-131`) is stored locally and fails with a `ValidationException` on AWS | Keep numbers within DynamoDB's documented range |
| `putBatch` writes all entries or none | The mock validates every entry before it writes any. On AWS each request of up to 25 entries is written on its own, so a later request can fail after an earlier one was written | Make batch entries independent of each other, or use `put` with conditions when the order of writes matters |
| Immediate consistency everywhere. On AWS, `getBatch`, `scan`, `query`, and every index read are eventually consistent | A read right after a write always sees it locally. On AWS an index or batch read may briefly miss it | `get` is strongly consistent on both. For the other reads there is no mitigation, because eventual consistency is not deterministic. Document the gap, and recommend sandbox testing |
| DynamoDB deletes expired items in the background (up to 48 h after expiry) | Locally an expired item stays in the store until the dev server restarts: the mock drops expired items when it loads its file | Both layers hide expired items from every read, so observable behavior matches. Only the time of the physical deletion differs. `scan({ includeExpired: true })` sees the remains on both, until each layer removes them |
| Scan order | The mock scans in base-key order. DynamoDB scans in internal hash order | Neither order is a contract. A cursor resumes correctly on both |
| Cursor after the last item | Both return a cursor whenever `limit` was reached, even when no item follows. The next page is then empty with no cursor | Aligned by design, so a paging loop written against the mock terminates the same way on AWS |
| A `null` or other-typed value in an indexed field | The mock stores the item. An index query never returns it through such a partition field (the query value must have the declared type), but returns it with a `null` or other-typed sort field when `where` has no sort condition (`matchesSort` accepts any present value then). DynamoDB rejects the `put` with a `ValidationException` for the type mismatch, which the runtime does not re-map, so an API client sees an unnamed 500 | Documented in the README ("Indexes"): omit an indexed field to keep an item out of the index |
| No IAM enforcement | Permission errors show only on AWS | No mitigation at mock level. CDK grants handle IAM |
| Durability/encryption options (`pointInTimeRecovery`, `protection`, `encryption`) are CDK-only | These provisioning-time settings have no observable effect on mock reads/writes | No mitigation needed. They are infrastructure settings, not data behavior. Verify the synthesized template in sandbox or production |

## Design decisions

The `D-DT-*` decisions of the former `DistributedTable` block that still apply are carried over here, renumbered `D-KV-*` and rewritten for the merged block. The new decisions of the merge follow them.

### D-KV-1: Key-first calls, with a key object for a declared key

**Decision:** Every data call takes the key first: `get(key)`, `put(key, value)`, `delete(key)`, `getBatch(keys)`, `putBatch([{ key, value }])`, `deleteBatch(keys)`. The key is a `string` on a store with no `key` option, and an object with exactly the declared key fields otherwise.

**Rationale:** One shape of `put` is easier to learn than two, and the block can check that the key and the value agree. For a declared key, every major DynamoDB library uses a key object. Examples are AWS SDK v3 DocumentClient `Key: { userId, orderId }`, ElectroDB `.get({ cityId, mallId })`, and DynamoDB-Toolbox `.key({ pokemonId })`. A compound key is two values that together identify an item, and an object names them at the call site. A pair of strings (`[partition, sort]`) was considered and rejected: the compiler cannot catch swapped parts, or a string that reaches a store of pairs. The key type is computed from the schema's output type (`KeyOf<Out, K>`), so a brand in the schema turns a swap of two string fields into a compile error.

### D-KV-2: `schema` is optional, and `key`, `indexes`, and `ttl` require it

**Decision:** A store with no options works: a string key and a string value (or the type argument). `key`, `indexes`, and `ttl` are available only together with a `schema`, enforced by the type of the options.

**Rationale:** The consolidation guidance says the zero-options constructor must produce a working block. The key and index configuration reference field names from the schema, and the schema is what makes them type-safe. Without it there is no way to validate that a key field exists or holds a string or a number. An explicit type argument together with `key` fails to compile rather than widening the key in silence.

### D-KV-3: StandardSchemaV1 over Zod-specific types

**Decision:** Accept `StandardSchemaV1` from `@standard-schema/spec` instead of Zod-specific structural types, and take both the input type (for `put`) and the output type (for reads, keys, and conditions) from it.

**Rationale:** Building Blocks accept any StandardSchemaV1 implementation. This avoids vendor lock-in to Zod and lets customers use Valibot, ArkType, or any other conforming library. The `@standard-schema/spec` package is types-only (zero runtime). Validation uses `schema['~standard'].validate()`. A brand, a default, or a transform works only because the block reads the two types separately. For example, a brand exists in the output type only, so keys that are read from the output type keep it.

### D-KV-4: Conditional operations with `ifNotExists`, `ifExists`, `ifFieldEquals`, and `ifValueEquals`

**Decision:** `put` takes `ifNotExists` and a value check. `delete` takes `ifExists` and a value check. The value check is `ifFieldEquals` for an object value and `ifValueEquals` for any other value. On `put` the two compose with OR, on `delete` with AND.

**Rationale:** The block holds application data that often needs coordination: creates that are safe to repeat, optimistic locking, and guarded deletes. Each maps to a DynamoDB `ConditionExpression`. `attribute_not_exists(pk)` protects a create-only write, `attribute_exists(pk)` guards a delete, and `#field = :value` is compare-and-swap. `ifFieldEquals` compares individual fields because an object value is spread over attributes, so a compare of the whole object would need a stored hash. `ifValueEquals` compares the one `_bkv_value` attribute. The OR composition on `put` is the "create it, or update it only if unchanged" pattern that `KVStore` shipped. AND could never hold, because a key cannot be absent and also hold a matching value. `DistributedTable` allowed one condition per call, so its callers gain the combination and lose nothing.

### D-KV-5: `scan()` not `list()`

**Decision:** The full-table enumeration method is named `scan()`, not `list()`, and it has no prefix option.

**Rationale:** `list` is an avoided verb because it understates the cost of a full table enumeration. `scan` communicates that every item is read and scales with total data size. A `prefix` option would hide that cost (guideline G18): DynamoDB cannot filter a scan by key prefix without reading every item. A store that must list items in order declares a key with a sort field, or adds an index on a field that names the group.

### D-KV-6: Single options object for `query`, with `index`, `where`, `limit`, `order`, and `cursor`

**Decision:** `query(options)` takes a single options object. Omitting `index` queries the declared key. A string store must pass `index`.

**Rationale:** A single options object is consistent with the rest of the API. The `index` field determines which key config applies to `where`. With `index`, `where` is typed against the key config of the index. Without it, `where` is typed against the declared key of the table. This is a discriminated union on `index`. The `order` field maps to `ScanIndexForward` of DynamoDB, where `'desc'` is `false`, and defaults to `'asc'`. `cursor` is the one new option name of the merge (D-KV-14).

### D-KV-7: TTL is always on, and `ttl` names a field or the block uses `_bkv_ttl`

**Decision:** Every table the block creates has DynamoDB TTL enabled. By default the expiry is the block's own `_bkv_ttl` attribute, set per write with `ttlSeconds` or `expiresAt`. A store with a schema can set `ttl: '<numberField>'` to keep the expiry in that field of the value, as `DistributedTable` did. A `put` with no expiry option then uses the field, and a `put` with an expiry option writes the field. The block writes the field into the full value before schema validation, so the schema validates the value that is stored.

**Rationale:** `KVStore` made TTL opt-in (`ttl: true`) because turning it on for a deployed table is a live table update. With one attribute name fixed at creation that concern goes away, and expiry is what caches, sessions, codes, and job records all need. Reads hide an expired item in both runtimes, whether or not DynamoDB has deleted it. DynamoDB deletes asynchronously, typically within 48 hours. So correctness never depends on TTL. TTL only removes items that no read returns. The named-field form keeps every `DistributedTable` table in place, because its TTL attribute does not change.

### D-KV-8: Split `InvalidQuery` and `ItemTooLarge` rather than one `Validation` name

**Decision:** An input that fails a check before any I/O gets a name that says what is wrong: `ValidationFailedException` for a value the block will not store, `InvalidQueryException` for a call of the wrong shape, and `ItemTooLargeException` for an item over 400 KB. The block does not use one generic `ValidationException`, the name that DynamoDB uses.

**Rationale:** `ValidationFailed` is about the value: it fails the schema, disagrees with its key, uses a reserved field name, or has an empty string in a key or indexed field. `InvalidQuery` is about the call. The key has the wrong shape, `where` is missing, the partition key is not given as `{ equals }`, or the index is unknown. Or the call has more than one sort condition, an empty `ifFieldEquals`, `ifValueEquals` with an object, or a cursor that does not belong to the call. Every one of these is a caller bug. `ItemTooLarge` is not always a caller bug, because the size of a record can be outside the control of the caller. So a caller may want to branch on it. On AWS, DynamoDB raises a generic `ValidationException` for an oversized item. The runtime matches the message about size and re-maps only that case, so both layers give the same name.

### D-KV-9: `retriable` on a 409 conflict marks a value check, not an existence assertion

**Decision:** A `ConditionalCheckFailedException` maps to an `ApiError` with status **409**. `retriable` is `true` when a value check (`ifFieldEquals` or `ifValueEquals`) took part in a failed `put`. It is also `true` for a failed `delete` whose value check ran without `ifExists`. It is `false` for a pure `ifNotExists` or `ifExists` assertion.

**Rationale:** A value conflict is an optimistic-concurrency conflict, so a re-read and a retry can succeed. A failed existence assertion is not. The same call fails again in the same way. Under the OR composition of `put`, a failure means every arm failed, so if a value arm took part the failure is the stale-value case. On `delete` the existence assertion wins. DynamoDB collapses every conditional failure under one exception with no sub-reason, so the AWS runtime decides from the conditions the call set, and the mock matches it. `retriable` marks the kind of conflict. It does not promise that a retry succeeds. A value conflict against a missing row is still flagged retriable.

### D-KV-10: `readValidation` is `off`, `coerce`, or `strict`, and defaults to `coerce`

The default choice (`'coerce'` over `'off'`) is recorded as a cross-cutting decision in [`docs/DECISIONS.md` D-015](../../docs/DECISIONS.md#d-015-kvstore-reads-default-to-readvalidation-coerce-not-off). Writes always validate. A read of a store with a schema checks each stored item against the schema, as the mode says. `'coerce'` returns the output of the schema merged over the raw item, so defaults fill in, types narrow, and undeclared stored keys stay. For an item that fails validation, it returns the raw item with a warning. `'strict'` throws `ValidationFailedException`. `'off'` returns the raw item. Coercion depends on the validator. A validator that only checks returns its input unchanged. Both runtimes call the same `applyReadValidation` in `errors.ts`. A store with no schema returns the raw value.

### D-KV-11: Secure-by-default durability and encryption, from the stack `BlocksDefaults`, with one `protection` option

The durability settings come from the stack-wide `BlocksDefaults` (`BlocksPresets` in `@aws-cdk-blocks/core/cdk`): `defaults.removalPolicy`, `defaults.deletionProtection`, and `defaults.pointInTimeRecovery`. Under `BlocksPresets.production` a table defaults to PITR **on**, deletion protection **on**, and `RemovalPolicy.RETAIN`. Under `BlocksPresets.sandbox` PITR and deletion protection are off and the removal policy is `DESTROY`, so a short-lived stack stays cheap and `sandbox:destroy` removes it with one command. SSE defaults to the AWS-managed KMS key. A store overrides each default with `protection`, `pointInTimeRecovery`, or `encryption`, and the option of a store always wins.

**Why one `protection` option and not separate `deletionProtection` and `removalPolicy` options.** Deletion protection and the removal policy answer one question: can this table be destroyed? Two options can contradict each other. `deletionProtection: true` with `removalPolicy: 'destroy'` tells CloudFormation to call `DeleteTable` on stack delete while DynamoDB refuses the delete, and the stack stops in `DELETE_FAILED`. One option with three values cannot express that combination:

- `'disposable'` is DESTROY with no deletion protection.
- `'retained'` is RETAIN with no deletion protection.
- `'locked'` is RETAIN with deletion protection.

So the former `KVStore` options `removalPolicy` and `deletionProtection` are gone.

**A CMK that you own, or one CMK for several tables.** `encryption: 'customer-managed'` provisions a dedicated CMK for each table. `KVStore.fromKmsKey(keyArn)` returns a branded `ExternalKmsKeyRef`, and it lets several tables share a key that exists. The `encryption` option has three values, so it cannot express a contradiction such as `'aws-managed'` together with a customer key. The CDK `IKey` type also stays out of the public `types.ts`. A CMK that the block creates takes the resolved removal policy of its table. So the key is never less durable than the table that it encrypts, and a sandbox teardown leaves no key that still bills. There is one consequence. When PITR is on and the table is `disposable`, the key is destroyed too, and the system backup cannot be restored after the 30-day window of KMS. This is intended, because a `disposable` table opts out of durable backups. `fromExisting` does not change. The customer owns the durability and the encryption of that table.

### D-KV-12: Flat item layout with a reserved `_bkv_` prefix

**Decision:** An object value is stored as one attribute per top-level field. Any other value goes in `_bkv_value`, the key of a string store in `_bkv_pk`, and the expiry in `_bkv_ttl` unless `ttl` names a field. Top-level value fields that start with `_bkv_` are rejected.

**Rationale:** A DynamoDB index reads top-level attributes only. With one attribute per field, an index can be added to a table that holds data, and DynamoDB fills it from the items that exist. Every former `DistributedTable` table has this layout already, and so does a table the block did not create. The alternatives are a nested `{ pk, value }` map, or the JSON string that `KVStore` used. Neither can be indexed, and an index added later would need a rewrite of every item, which the production GSI manager has no permission to do. The cost is the reserved prefix (Convex reserves `_`, DynamoDB-Toolbox reserves `_et`) and the loss of a whole-object compare (D-KV-4). The prefix check is also a safety rule: a value built from request input must not be able to set the key or the expiry of an item.

### D-KV-13: `get` is strongly consistent by default

**Decision:** `get` sends `ConsistentRead: true` unless `consistentRead: false` is passed. `getBatch`, `scan`, and `query` stay eventually consistent.

**Rationale:** The block holds session, job, and conversation state, where a stale read gives a wrong result with no error. `Agent` already asked for a consistent read on its ownership check, and `AsyncJob` compares versions it just wrote. The stores that hold application state in the wider ecosystem (Durable Objects, Deno KV, Convex) read with strong consistency by default. The stores that default to eventual reads replicate to many locations and say so. A consistent read costs twice the read capacity, so the opt-out stays. A later release can add `consistentRead` to the other reads without breaking anyone.

### D-KV-14: `query` and `scan` return a `Results` object with a checked cursor

**Decision:** Both reads return an `AsyncIterable` of `{ key, value, expiresAt? }` entries with a `cursor` property, and take a `cursor` option. The cursor encodes the `LastEvaluatedKey` as readable base64url JSON and is checked against the store's key schema, the call's index, and the call's partition before use.

**Rationale:** Workers KV, Deno KV, Netlify Blobs, ElectroDB, and Convex all return a cursor so a later request can continue a listing. An iterator alone cannot cross requests. Entries carry the key so a listing can address each item and the expiry so a copy job can pass it back to `put`. The cursor is checked rather than trusted because it comes back from a client. A cursor for another index would make DynamoDB return a `ValidationException` that does not name the cause. A cursor for another partition would return the page of that partition with no error, on a `where` that is otherwise correct. The cursor is not a secret, so an API method still checks authorization on every page. Both runtimes encode the same cursor for the same item, and both return a cursor whenever `limit` was reached, so a paging loop behaves the same locally and on AWS.

### D-KV-15: Runtime checks for what the compiler cannot see

**Decision:** Both runtimes reject the following before any I/O:

- With `InvalidQuery`:
  - a key of the wrong shape or type
  - `ifValueEquals` with an object
  - an empty `ifFieldEquals`
  - a partition value or a sort operand of the wrong type
  - a sort condition that does not exist
  - a bad cursor
- With `ValidationFailed`:
  - a key and a value that disagree
  - a reserved field
  - a field name that DynamoDB cannot store (`__proto__`, at any depth of the value)
  - an empty string in a key or indexed field
  - a value that fails the schema

The checks live in `src/item.ts` and the messages in `src/errors.ts`, shared by both runtimes.

**Rationale:** The type system enforces these for TypeScript callers. JavaScript callers, casts, and request-shaped values reach the runtime unchecked. Doing the checks in shared code keeps the mock and AWS runtime byte-for-byte aligned on what they accept and on the error they throw, which the parity tests assert. A key-type mismatch is caught with the type that the CDK layer provisions (D-KV-17), because DynamoDB's own error for it does not name the cause.

### D-KV-16: No guard for a `ttl` change on a deployed store (deferred)

**Decision:** The block does not detect a change to the `ttl` option of a deployed store. The README tells users not to change it in place.

**Rationale:** A `ttl` change strands the expiry of existing items in the old attribute, so they stop expiring and reads stop hiding them. CloudFormation requires TTL to be off before the attribute name changes, and the block never turns TTL off. So the deploy is expected to fail, but the error would not name the cause. A clear and early failure needs a check before the deploy. The `predeploy` hook for blocks is a work in progress, so the guard waits for it. A `key` change needs no guard. DynamoDB cannot change the key schema of a table, and CloudFormation does not replace a named table, so that deploy fails and the table keeps its data.

### D-KV-17: One key-type probe for the CDK layer and the runtimes

**Decision:** `probeKeyType(schema, field)` in `src/item.ts` gives the DynamoDB type of a key field or an index field, and every layer calls it. A field is a number (`N`) if the schema accepts one of the number samples `0`, `1`, `-1` at the path of the field. In all other cases it is a string (`S`). A store with no schema has string fields. A schema that validates asynchronously counts as one that accepts the sample, as the CDK layer always treated it. There is no "unknown" result.

**Rationale:** The CDK layer used a `0` probe. The runtimes used a `0` and `'x'` probe with a third result for a schema that accepted both. The runtime could then accept a key that the table could not hold, and a block with a pass-through schema needed a second schema for synth. With one function, the runtime accepts exactly the type that the table has, and a block ships one schema (`Realtime` now has one, in `connections.ts`, as `AsyncJob` has `statusTableOptions`). Three samples make a refined number field (`z.number().positive()`, `z.number().negative()`) a number. With the `0` probe alone, the CDK layer provisioned such a field as a string, and a write of a number to it failed on DynamoDB.

**Limits:** A number field that rejects all three samples (for example `z.number().min(5)`) reads as a string. Keep such a refinement out of a key field. A field that accepts a string and a number is a number. A key field whose schema rejects `0` and accepts `1` or `-1` is `N` now and was `S` before. DynamoDB cannot change the key type of a table, so a deploy over such a table fails and the table keeps its data.

### D-KV-18: An option with the value `null` counts as absent

**Decision:** Each public method that reads options passes them through one function, `presentOptions` in `src/item.ts`, which takes out every option whose value is `null`. The rule holds for every option of every method, in both runtimes. The option types do not include `null`. The exceptions are the two value checks: `ifValueEquals: null` compares with a stored `null`, and `ifFieldEquals: null` is `InvalidQueryException`.

**Rationale:** JSON has no `undefined`. An API method that forwards its arguments into the options of a store (`store.scan({ limit, cursor })`) can get `null` for an argument that the client left out. The RPC client of `@aws-cdk-blocks/core` leaves trailing `undefined` arguments out of a request, which covers the usual case. This rule covers an `undefined` before a later argument, and a caller that is not that client. Before, `cursor`, `limit` and `index` each had their own check and the other options had none: `expiresAt: null` was an error. One function gives one rule.

The value checks are excluded because they guard a write. `get` returns `null` for a missing key, so `put(key, next, { ifValueEquals: await store.get(key) })` must be a conflict for a missing key. If `null` counted as absent there, the write would run with no condition.

### D-KV-19: A mock data file with a version, and conversion of the earlier formats

**Decision:** The mock writes `{ "version": 2, "items": [...] }`. On load it converts a version 1 `store.json` (the `KVStore` format before the merge, which has no version field) and, when the directory has no `store.json`, the `data.json` of `DistributedTable`. A conversion puts each entry through `layoutItem`, the layout of a write without the schema, and is all or nothing. A corrupt entry in a current-format file is left out, with a copy of the file kept as `.bak`. A file in any other shape is renamed to `.bak`. Both are reported once at warn level. "A corrupt entry" and "an earlier format" are separate cases with separate tests (`src/mock-file.test.ts`).

**Rationale:** The merge changed the shape of the mock data file. With no version, the loader read a file of the earlier `KVStore` as a list of corrupt entries, loaded an empty store, and the next write replaced the file. The `data.json` of `DistributedTable` was left behind. The local data of an app went away on upgrade with no message. A version field lets the loader tell a file of an earlier format from a damaged file, and lets a later change of the format do the same. A conversion goes through the layout of a write, so a converted item is the item that a `put` of the same value gives. Schema validation is not part of a conversion. The mock loads its file in the constructor, which cannot wait for a schema that validates asynchronously. `readValidation` reconciles a converted item with the schema on read. A file that the mock cannot read stays on disk under a `.bak` name, because only the developer knows if the data matters.

### D-KV-20: A store of release 0.4.0 or earlier is read through `LegacyKVStore`, and the app copies its items

**Decision:** The block does not convert a table of release 0.4.0 or earlier. It gives the app a second class, `LegacyKVStore`, that declares that table unchanged and keeps it usable. The app copies the items into a `KVStore` with a new id at run time. `LegacyKVStore` has the data methods of release 0.4.0: `get`, `put`, `delete`, and `scan`. It is deprecated from its first release, and frozen at that API.

**Rationale:** The table cannot become a table of this release (its key cannot change), so the items must move to a second table. Three places can do the move. `KVStore` can keep the old layout for such a store. That gives the block two layouts for as long as it lives, and a store in the old layout has no index and no condition on a field. The deploy can copy, which ties the copy to the order, the limits, and the rollback of a CloudFormation update, at a moment that the app does not choose. Or the app can copy. A copy in app code runs when the app chooses, can stop and go on, and works on any compute. The block then only has to keep the old table usable, which is a small class beside `KVStore` that can go when the upgrades from those releases end. `KVStore` keeps one layout.

**The cost:** the app writes the copy, and until the copy is done its data is in two stores. A read by key can fall back to the old store. A `scan` or a `query` of the new store cannot. A delete can lose a race with a copy that holds the item at that moment. A value that the app writes to the old store after the copy passed its key stays in the old store. The block does not prescribe the migration. The README section "Upgrade from release 0.4.0 or earlier" has steps that are suitable for some migrations, and these limits.
