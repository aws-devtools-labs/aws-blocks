# DistributedTable — Design

Design document for DistributedTable. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-distributed-table`
**Type:** Primitive (new infrastructure)
**AWS Service:** DynamoDB (partition key + optional sort key + GSIs)

## Design Decisions

### D-DT-1: Key object over positional arguments

**Decision:** `get()`, `delete()`, `getBatch()`, and `deleteBatch()` accept a key object (`{ userId: 'alice', orderId: '001' }`) rather than positional arguments (`'alice', '001'`).

**Rationale:**

Every major DynamoDB library uses a key object pattern:
- **AWS SDK v3 DocumentClient:** `Key: { userId: 'alice', orderId: '001' }`
- **ElectroDB:** `.get({ cityId: 'Atlanta1', mallId: 'EastPointe' })`
- **DynamoDB-Toolbox v1:** `.key({ pokemonId: 'pikachu1' })`

DynamoDB keys are compound by nature — a partition key and optional sort key that together identify an item. An object communicates the field names at the call site, making the code self-documenting. Positional args like `get('alice', '001')` don't tell you which value is which.

The key type is a computed `TableKey<T, K>` — a `Required<Pick<T, KeyFields>>`, not `Partial<T>`. `Partial<T>` would be too loose: it makes non-key fields optional but present, and allows omitting required key fields entirely (`table.get({})` would compile). The computed type picks exactly the key fields and makes them all required. When a sort key is defined, it is required in the key object — you cannot accidentally omit it. The class carries a third generic `K extends TableKeyConfig<T>` so the literal key config is preserved and `TableKey` resolves correctly.

This also follows the API's options-object convention (objects over positional parameters) since the key is inherently a multi-field value.

### D-DT-2: Schema is required

**Decision:** `DistributedTableOptions.schema` is required, not optional.

**Rationale:** DistributedTable's key configuration references field names from the schema (`partitionKey: 'userId'`). The schema is what makes the key type-safe — without it, there's no way to validate that key field names exist in the item type. Unlike KVStore (which stores opaque values by string key), DistributedTable operates on structured items where the schema is integral to the type system.

### D-DT-3: StandardSchemaV1 over Zod-specific types

**Decision:** Accept `StandardSchemaV1` from `@standard-schema/spec` instead of Zod-specific structural types.

**Rationale:** Building Blocks accept any StandardSchemaV1 implementation. This avoids vendor lock-in to Zod and lets customers use Valibot, ArkType, or any other conforming library. The `@standard-schema/spec` package is types-only (zero runtime). Validation uses `schema['~standard'].validate()`.

### D-DT-4: Conditional operations — ifNotExists, ifExists, ifFieldEquals

**Decision:** Support `ifNotExists` on put, `ifExists` on delete, and `ifFieldEquals` on both put and delete.

**Rationale:** DistributedTable backs structured application data that often requires coordination — idempotent creates, optimistic locking, and guarded deletes. These map directly to DynamoDB's `ConditionExpression` capabilities:

- `ifNotExists` → `attribute_not_exists(pk)` — protects create-only operations from overwriting existing items.
- `ifExists` → `attribute_exists(pk)` — ensures you're deleting something that's actually there (useful for audit trails, cascading deletes).
- `ifFieldEquals` → `#field = :value` — optimistic locking / compare-and-swap. Check that a field (e.g., `status`, `version`, `updatedAt`) matches an expected value before writing. This is the DynamoDB equivalent of `UPDATE ... WHERE version = ?` in SQL.

`ifFieldEquals` accepts `Partial<T>`, so multiple fields can be checked in a single condition (AND semantics). All condition failures throw with `error.name = 'ConditionalCheckFailedException'`, matching the AWS SDK error name.

`ifNotExists` and `ifFieldEquals` are mutually exclusive at the type level (discriminated union), as are `ifExists` and `ifFieldEquals`. DynamoDB's `ConditionExpression` could combine them, but the semantics are confusing — "create only if it doesn't exist AND the existing item's field equals X" is contradictory. The type system prevents this rather than silently picking one.

KVStore uses `ifValueEquals` (compare the entire value). DistributedTable uses `ifFieldEquals` (compare individual fields) because items are structured objects with multiple fields — comparing the entire item would be impractical and fragile.

### D-DT-5: `scan()` not `list()`

**Decision:** The full-table enumeration method is named `scan()`, not `list()`.

**Rationale:** `list` is an avoided verb because it understates the cost of a full table enumeration. `scan` communicates that every item is read and scales with total data size. The name is borrowed directly from DynamoDB to reinforce the cost implication.

### D-DT-6: Single options object for query

**Decision:** `query(options)` takes a single options object with `index`, `where`, `limit`, and `order` fields. Omitting `index` queries the primary key.

**Rationale:** A single options object is consistent with the rest of the API. The `index` field determines which key config applies to `where` — when present, `where` is typed against the GSI's key config; when absent, it's typed against the table's primary key. This is implemented as a discriminated union on `index`:

```typescript
// GSI query — where is typed against byDate's key config
orders.query({
  index: 'byDate',
  where: { userId: { equals: 'alice' }, createdAt: { greaterThan: 1000 } },
  order: 'desc',
})

// Primary key query — where is typed against the table's primary key
orders.query({
  where: { userId: { equals: 'alice' }, orderId: { beginsWith: '2024-' } },
})
```

The `order` field maps to DynamoDB's `ScanIndexForward` parameter (`'desc'` → `ScanIndexForward: false`). It defaults to `'asc'`.

### D-DT-7: TTL via options field

**Decision:** TTL is configured via `ttl: 'fieldName'` in the constructor options, not as a separate method or decorator.

**Rationale:** DynamoDB TTL is a table-level setting that designates one attribute as the expiration timestamp. It's a static configuration concern, not a per-item operation, so it belongs in the constructor options alongside `key` and `indexes`. The field must exist in the schema and should contain a Unix epoch timestamp in seconds. DynamoDB automatically deletes expired items in the background (typically within 48 hours of expiration).

### D-DT-8: Split `InvalidQuery` and `ItemTooLarge` rather than one `Validation` bucket

**Decision:** Pre-flight input failures surface as two intent-revealing error names — `InvalidQueryException` and `ItemTooLargeException` — instead of a single generic `ValidationException` that mirrors DynamoDB's wire name.

**Rationale:** These are two genuinely different failure modes that an earlier revision collapsed under one catch:

- **`InvalidQuery`** — the request *shape* is wrong: a missing `where` clause, a partition key not given as `{ equals: value }`, an unknown index, more than one sort-key condition, or an empty `ifFieldEquals`. Every one of these is a **caller bug** — something the caller fixes by correcting the call. There's no value in branching on which specific shape error occurred at runtime, so they share one name.
- **`ItemTooLarge`** — an item exceeds the 400 KB per-item limit. This is **not necessarily a caller bug**: the size of a given record may be outside the caller's control (user-supplied content, accumulated history). A caller may legitimately want to branch on it — skip the item, split it, or store a reference instead — which it cannot do if the only signal is a generic name plus message text.

A generic `ValidationException` is exactly the kind of catch-all bucket worth avoiding, and `BatchIncomplete` already establishes the Blocks-specific-name pattern in this same package. Splitting into intent-revealing names lets a customer write `isBlocksError(e, DistributedTableErrors.ItemTooLarge)` and reliably tell "this item is too big" from "my query is malformed" without string-matching the message.

**Mock/AWS parity:** the mock checks serialized byte length client-side and throws `ItemTooLarge` directly. On AWS, DynamoDB raises a generic `ValidationException` for an oversized item; the runtime narrows on the size-specific message (`size has exceeded`) and re-maps only that case to `ItemTooLarge`. Other `ValidationException` causes (malformed expressions, type mismatches) propagate unchanged. Both layers therefore surface the same `error.name`, and the shared message lives in `errors.ts` (`DistributedTableMessages.itemTooLarge`) so the two stay byte-for-byte aligned.

### D-DT-9: `readValidation` — `off | coerce | strict`, defaulting to `coerce`

> The **default choice** (`'coerce'` over `'off'`) is recorded as a cross-cutting architectural decision in [`docs/DECISIONS.md` D-015](../../docs/DECISIONS.md#d-015-distributedtable-reads-default-to-readvalidation-coerce-not-off). This section covers the per-BB mechanics.

**Decision:** Writes always validate. Reads reconcile a stored item with the schema per the `readValidation` mode, which defaults to **`'coerce'`**. `get`/`getBatch`/`query`/`scan` pass each stored value through `schema['~standard'].validate()`:
- **`'coerce'`** (default) — return the schema's output (defaults filled / types narrowed for transform-bearing schemas); on validation failure return the **raw** value with a `warn` log — never throws.
- **`'strict'`** — throw `ValidationFailed` on any item that doesn't satisfy the schema.
- **`'off'`** — return the raw stored value, no validation.

**Rationale:** The asymmetry "validate on write, return raw on read" breaks the documented read-modify-write update pattern after a schema change, in two ways. A newly added field is absent from the read, so `get()` returns a value that silently violates the declared type `T` and any schema `.default()` is neither applied nor persisted on write-back; and if the new field is required with no default, the `put()` half of the cycle throws `ValidationFailed`, stranding the row. Coercing on read fixes the round-trip for the coercible case (added fields with `.default()`, widened/narrowed types) by handing the caller a value the current schema accepts. It cannot invent a required-no-default value — those rows fall through to the raw + warn path and still need an explicit migration.

**Why `coerce` is the default.** The bug is that the *default* read violates `T`; a fix only users who discover a flag can enable isn't a fix. Market research across comparable typed data layers backs a coercing default: Rails ActiveRecord type-casts on load, Mongoose applies defaults/casts when hydrating, ElectroDB runs getters and returns schema-shaped items — none re-throw on stored data, and Postgres itself synthesizes an added column's `DEFAULT` at read time (`ALTER TABLE ADD COLUMN … DEFAULT`), which is coerce-on-read in all but name.

**Why not `strict` by default.** Throwing on read makes legacy/corrupt rows unreadable — you couldn't fetch them to migrate — turns one bad row into a whole-`scan`/`getBatch` outage, and violates the project rule that reads return data or `null` and throw only for violated preconditions. Every surveyed library that ships a strict read (DynamoDB-Toolbox `format()`, the `zod-firebase` converter) also ships an escape hatch. So `strict` is offered as an opt-in for tables that want mismatch treated as corruption, not as the default.

**Why keep `off`.** The raw escape hatch (ElectroDB's `data:'raw'`, Mongoose's `.lean()`) is needed for hot paths, trusted write-validated data, and reading rows that can't yet be coerced during a migration.

**Best-effort coercion caveat.** Standard Schema only guarantees `validate()` *checks*; it does not require transformation. Zod fills defaults/coerces, but a check-only Valibot/ArkType schema returns its input unchanged — so `'coerce'` degrades to pass-through for those validators. Documented as best-effort; coercion never fabricates a required value.

**`coerce` preserves unknown keys.** Most validators discard unrecognized keys when they produce their output (Zod `.strip()`s by default), so a stored row carrying attributes beyond the current schema — fields from an older schema version, or columns another writer owns — would lose them on read, and a read-modify-write (`get()` → `put()`) would persist that loss, silently deleting data. To prevent this, `'coerce'` deep-merges the coerced value **over the raw stored item** (`mergeCoercedOverRaw` in `errors.ts`, built on `defu`'s `createDefu`): schema output wins per key (defaults filled, types narrowed), while keys the schema doesn't declare — including nested ones — survive. Arrays are treated as opaque leaves: the coerced array replaces the raw array wholesale (defu concatenates arrays by default, which would *duplicate* elements here since the coerced array is derived from the raw one, so that one behavior is overridden). The merge runs only when both the stored item and the coerced value are plain objects; defu's `__proto__`/`constructor` guard is retained. `'coerce'` is therefore additive-and-lossless for the common cases (added fields, nested unknowns, type coercion). The one residual: a schema whose *transform* deliberately renames or removes a key — the merge resurrects the old key, so transform-heavy schemas should use `'strict'` or `'off'`. `defu` is used rather than a hand-rolled merge because treating arrays as leaves requires custom config in every merge library regardless, and defu is a maintained, prototype-safe, zero-dependency ESM package.

**Mock/AWS parity:** both layers call the same `applyReadValidation()` helper in `errors.ts`, so all three modes (coerced output, raw-fallback + warn, strict throw) behave identically. `null` (a missing item) passes through untouched in every mode, preserving not-found semantics.

### D-DT-10: Secure-by-default durability & encryption, sourced from stack `BlocksDefaults`

Durability posture is resolved from the stack-wide `BlocksDefaults` (`BlocksPresets` in `@aws-blocks/core/cdk`), the shared infrastructure-defaults mechanism (introduced in #302): `defaults.removalPolicy`, `defaults.deletionProtection`, and `defaults.pointInTimeRecovery`. Under `BlocksPresets.production` a table defaults to PITR **on**, deletion protection **on**, and `RemovalPolicy.RETAIN`; under `BlocksPresets.sandbox` all three flip off/`DESTROY` so throwaway stacks stay cheap and `sandbox:destroy` is a one-command teardown. SSE defaults to the AWS-managed KMS key. Every default is overridable per table via `protection`, `pointInTimeRecovery`, and `encryption`; a per-block option always wins (`option ?? scope.defaults.field`). Each field is read **independently** from `defaults` — deletion protection and PITR are never derived from `removalPolicy`.

**Why read `this.defaults` rather than the `sandboxMode` context.** An earlier revision of this PR read `--context sandboxMode=true` directly and gated durability on it. #302 replaced that per-block guessing with one stack-wide posture object every block reads, so an app tunes durability in one place and blocks stay consistent. Durability now flows entirely through `defaults`; the block only still reads `sandboxMode` for the GSI custom resource's drop-and-recreate fast path (an operational concern, not a durability default).

**Why gate deletion protection at the construct (via `defaults`) rather than the stack aspect.** A natural alternative was to enable deletion protection unconditionally and let `SandboxDisableDeletionProtection` relax it for sandboxes. That does **not** work: the mixin duck-types on a `deletionProtection` *instance* property, and the DynamoDB L2 `Table` only accepts `deletionProtection` as a constructor prop — it exposes no such instance property to flip afterward (pinned by `core/src/cdk/mixins.test.ts`). Reading `this.defaults.deletionProtection` in the constructor is exactly why that construct-level mechanism exists; the mixin is now `@deprecated`.

**Why one `protection` knob instead of separate `deletionProtection` + `removalPolicy`.** As a per-block override, deletion protection and removal policy answer a single question — "can this table be destroyed?" — and two booleans can encode a contradiction: `deletionProtection: true` + `removalPolicy: 'destroy'` tells CloudFormation to `DeleteTable` on stack delete while DynamoDB refuses the delete, wedging the stack in `DELETE_FAILED`. Collapsing them into one three-value enum (`'disposable'` → DESTROY + unprotected; `'retained'` → RETAIN + unprotected; `'locked'` → RETAIN + protected) makes the invalid combination unrepresentable while still exposing the meaningful middle state (retain without locking). When omitted, the two CDK properties come from `defaults` directly. Encryption stays a separate knob because it's an orthogonal concern.

**Why AWS-managed (not customer-managed) KMS by default.** AWS-managed SSE (`aws/dynamodb`) gives CloudTrail-auditable encryption at rest with no per-key monthly charge and no extra stack resources, satisfying "SSE-KMS by default" without imposing cost. Teams that need key rotation/policy control opt into a dedicated CMK with `encryption: 'customer-managed'`.

**Bring-your-own / shared CMK.** `encryption: 'customer-managed'` provisions a **dedicated CMK per table**, so an app with many customer-managed tables accrues one key (and one monthly charge) each. To share a single key across tables, callers pass `DistributedTable.fromKmsKey(keyArn)` — a branded `ExternalKmsKeyRef` — as the `encryption` value; the CDK layer resolves it with `Key.fromKeyArn(...)` and sets it as the table's `encryptionKey` (no new key is minted). The `encryption` option is therefore a three-way value (`'aws-managed' | 'customer-managed' | ExternalKmsKeyRef`) rather than a separate `encryptionKey` field — folding it into one knob avoids a contradictory state (e.g. `encryption: 'aws-managed'` alongside a customer key). This follows the same branded-reference pattern as `fromExisting()` (`ExternalTableRef`) and deliberately keeps the CDK `IKey` type out of the public `types.ts`, which must stay runtime-agnostic across the four export layers — the public surface only ever sees the key's ARN string wrapped in a brand.

**`fromExisting` is untouched.** When binding to a pre-existing table these options don't apply — the customer owns that table's durability/encryption configuration, exactly as they own its GSIs.

## Infrastructure (CDK)

Creates a single DynamoDB table:

- **Partition key:** Configurable name and type via `options.key.partitionKey`
- **Sort key:** Configurable name and type via `options.key.sortKey` (optional)
- **Global secondary indexes:** Managed by a custom resource (see below)
- **TTL:** Enabled via `TimeToLiveSpecification` when `options.ttl` is set
- **Billing mode:** PAY_PER_REQUEST
- **Table name:** Derived from `scope.fullId` (includes stack name for uniqueness)
- **Durability & encryption:** Secure-by-default in production — PITR, deletion protection, SSE-KMS, and `RemovalPolicy.RETAIN` (see D-DT-10)
- **Permissions:** `grantReadWriteData` to the parent scope's handler automatically, plus explicit `dynamodb:Query` on `index/*`

Attribute types are inferred from the schema at synth time. The CDK layer probes the schema's `StandardSchemaV1.validate()` method with a test value of `0` for each key field — if the field accepts it without issues, it's numeric (`AttributeType.NUMBER`), otherwise string (`AttributeType.STRING`). This is schema-library-agnostic and uses only the standard validation interface.

### GSI Management Custom Resource

DynamoDB only allows one GSI change per `UpdateTable` call, and each change can take minutes to hours on large tables (DynamoDB must backfill the index). A standard CDK `Table` construct cannot express multi-GSI changes in a single deployment. DistributedTable uses a CloudFormation custom resource with the CDK `Provider` framework's async pattern to manage GSIs declaratively.

**Architecture:**

- **`onEvent` handler** — Invoked once per CloudFormation Create/Update/Delete. Compares the table's current GSIs against the desired state. If already matching, returns immediately. Otherwise, initiates the first GSI change and returns `IN_PROGRESS`. For sandbox deployments, takes a fast path (see below).
- **`isCompleteHandler`** — Polled by the Provider framework every 10 seconds (configurable via `queryInterval`), up to a 2-hour total timeout. On each poll:
  1. If the table is busy (a GSI is still creating/deleting), returns `IsComplete: false`.
  2. If the table is idle and matches the desired state, returns `IsComplete: true`.
  3. If the table is idle but doesn't match, initiates the next GSI change and returns `IsComplete: false`.

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

Production deployments can only add/remove GSIs via `UpdateTable`. The GSI manager lambda cannot drop or recreate the table, scan its data, or batch-write items. This prevents accidental data loss from a misconfigured custom resource.

### Sandbox Deployment Model

Sandbox deployments use a **drop-and-recreate** fast path that bypasses the sequential one-at-a-time GSI limitation:

1. Scan all items from the existing table (backup to memory)
2. Delete the table
3. Wait for deletion to complete
4. Create a new table with all desired GSIs defined upfront (DynamoDB allows multiple GSIs at table creation time)
5. Wait for the table and all GSIs to become ACTIVE
6. Restore all items via `BatchWriteItem`

This is dramatically faster than sequential GSI creation (seconds vs. minutes/hours) but **destroys and recreates the table**. It is only used when `SandboxMode` is `true` (set by the CDK layer based on the `sandboxMode` context variable). The IAM policy for production deployments does not grant the permissions needed for this path, so it cannot execute in production even if `SandboxMode` were accidentally set.

⚠️ **Data loss risk in sandbox:** If the Lambda times out during step 1 (scan) on a very large table, or if the restore in step 6 fails partway through, data may be lost. This is acceptable for sandbox (ephemeral dev environments) but is why the fast path is never used in production.

## Serialization

Items are stored as DynamoDB JSON (marshalled via `@aws-sdk/lib-dynamodb` DocumentClient). The type parameter `T` is inferred from the StandardSchemaV1 schema at compile time. Runtime validation occurs on `put` and `putBatch` before writing. Both mock and AWS runtime use the same validation path (`schema['~standard'].validate()`).

## Mock Implementation

- Data stored in `.bb-data/{scope.fullId}/data.json` via `getMockDataDir()` from core.
- Data persists across dev server restarts. Customers can wipe with `rm -rf .bb-data`.
- Index queries implemented via in-memory filtering over the full dataset.
- Conditional write/delete failures throw with `error.name = 'ConditionalCheckFailedException'`.
- Schema validation on `put()` and `putBatch()`; throws with `error.name = 'ValidationFailedException'`.
- Validates 400 KB serialized item size limit.
- TTL is accepted in options but not enforced — items are not auto-deleted locally.
- `getBatch`/`putBatch`/`deleteBatch` always process every entry in one pass — the
  in-memory store never returns `UnprocessedKeys`/`UnprocessedItems`, so the AWS
  runtime's retry loop and `BatchIncomplete` exhaustion error have no mock equivalent
  (see parity gaps below).
- `ifFieldEquals` compares values with an order-independent structural deep-equal.
  Object/Map keys are compared as a set (DynamoDB Maps are an unordered collection
  of name-value pairs), while arrays remain order-sensitive (DynamoDB Lists are
  ordered). The unordered-Map equality of `=` in a DynamoDB condition expression
  was confirmed against real DynamoDB: storing `{ role: 'admin', level: 5 }` and
  issuing a conditional `put` with `ifFieldEquals: { level: 5, role: 'admin' }`
  (keys reversed) passes the condition, so the mock's order-independent compare
  matches AWS.

### Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| No throughput limits | Code that would be throttled in AWS succeeds locally | Document the gap; recommend sandbox testing for throughput-sensitive flows |
| Batch retry exhaustion (`BatchIncomplete`) is AWS-runtime only | Under sustained throttling, AWS batch ops retry with backoff and throw `DistributedTableErrors.BatchIncomplete` once `MAX_BATCH_ATTEMPTS` is reached; the mock never throttles so this path is unreachable locally | Error name and message are single-sourced in `errors.ts` so catch-site handling (`isBlocksError(e, DistributedTableErrors.BatchIncomplete)`) is identical regardless of backend. Exercise throttling/backoff behavior in sandbox |
| No item size limit enforcement beyond 400 KB check | Edge cases around DynamoDB marshalling overhead | Mock validates serialized JSON size, which is a close approximation |
| Immediate consistency (vs eventual for GSIs) | GSI reads always reflect the latest write locally | No mitigation — eventual consistency is inherently non-deterministic. Document the gap; recommend sandbox testing |
| No IAM enforcement | Permission errors only surface in AWS | No mitigation at mock level — IAM is handled by CDK grants automatically |
| In-memory index queries vs DynamoDB index reads | Index query performance characteristics differ; no GSI throughput throttling | No mitigation — correctness is preserved. Performance testing requires sandbox |
| TTL not enforced locally | Items with expired TTL remain in mock data | Document the gap; test TTL behavior in sandbox |
| Durability/encryption options (`pointInTimeRecovery`, `pointInTimeRecoveryDays`, `protection`, `encryption`) are CDK-only | These provisioning-time settings have no observable effect on mock reads/writes | No mitigation needed — they're infrastructure config, not data behavior; verify the synthesized template in sandbox/prod |
