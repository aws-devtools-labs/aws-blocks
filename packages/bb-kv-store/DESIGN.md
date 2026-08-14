# KVStore — Design

Design document for KVStore. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-kv-store`
**Type:** Primitive (new infrastructure)
**AWS Service:** DynamoDB (single-table, partition key only)

## Infrastructure (CDK)

Creates a single DynamoDB table:

- **Partition key:** `pk` (String)
- **Billing mode:** PAY_PER_REQUEST
- **Table name:** Derived from `scope.fullId` (includes stack name for uniqueness)
- **Removal policy:** DESTROY (sandbox), configurable for production
- **Time-to-Live:** Disabled by default; `{ ttl: true }` sets `timeToLiveAttribute: 'ttl'`
- **Permissions:** `grantReadWriteData` to the parent scope's handler automatically

No sort key, no GSIs. This is intentional — `KVStore` is the simple case. Customers needing sort keys or secondary indexes should use `DistributedTable`.

## Expiry (TTL)

TTL is opt-in at the construct (`{ ttl: true }`) and per write (`put(k, v, { ttlSeconds })` or `{ expiresAt }`), because switching TTL on for a table that already exists is a CloudFormation update to the live table.

The attribute name is fixed to `ttl` rather than configurable like `DistributedTable`'s `ttl?: keyof T`. A `DistributedTable` item's attributes are the customer's schema fields, so TTL points at one of them; a `KVStore` item is always `{ pk, value }` with the customer payload opaque inside `value`, so there is no customer attribute to name. Fixing it also matches the `timeToLiveAttribute: 'ttl'` convention already used elsewhere in the repo.

`ttlSeconds` (relative) and `expiresAt` (absolute `Date` or epoch seconds) resolve through one shared helper (`src/ttl.ts`) used by both runtimes, so the mock and AWS layers cannot drift on the value written or on when an item counts as expired. It rejects mutually-exclusive options, non-positive `ttlSeconds` durations, and numbers large enough to be epoch milliseconds — a milliseconds value would be accepted by DynamoDB as a year-5138 expiry, silently defeating the feature. `expiresAt` is an instant rather than a duration, so it has no positive lower bound: any past timestamp, epoch `0` included, reads as "expire immediately".

Because DynamoDB deletes expired items asynchronously (typically within 48 hours), an expired item can still be physically present. Both runtimes therefore filter on read: `get` returns `null` and `scan` skips the item as soon as its expiry passes. Conditional expressions still see the stored item until it is actually deleted, matching DynamoDB.

Maintenance sweeps that must act on every row still physically present — deleting the remains of expired items rather than waiting on the reaper — opt out of that filter with `scan({ includeExpired: true })`. It is deliberately not the default: a read answering "is this still valid?" must never see an expired item. `AuthCognito`'s session revoke uses it so a deliberate revoke physically deletes rows whose refresh tokens are still at rest.

This read-side filtering is a `KVStore` guarantee only. `DistributedTable` also supports TTL (`ttl?: keyof T`) but sets `timeToLiveAttribute` without filtering reads, so an expired item there keeps reading as live until the reaper collects it — up to 48 hours. Do not assume the two blocks behave the same; a `DistributedTable` consumer relying on TTL for expiry semantics needs its own read-side check.

## Serialization & Validation

Values are serialized to JSON on write and deserialized on read. Both mock and AWS runtime use `JSON.stringify` / `JSON.parse`.

When `options.schema` is provided (any `StandardSchemaV1` implementation — Zod, Valibot, ArkType, etc.), the type parameter `T` is inferred from the schema and every `put()` validates the value at runtime before writing. Validation failures throw with `error.name = 'ValidationFailedException'`. When no schema is provided, `T` defaults to `string` with no runtime validation.

## Mock Implementation

- Data stored in `.bb-data/{scope.fullId}/store.json` via `getMockDataDir()` from core.
- Data persists across dev server restarts. Customers can wipe with `rm -rf .bb-data`.
- Conditional write/delete failures throw with `error.name = 'ConditionalCheckFailedException'`.
- Schema validation on `put()` when configured, throws `ValidationFailedException`.
- Validates the 400 KB item size limit; throws `ItemTooLargeException` (`KVStoreErrors.ItemTooLarge`) on oversized items. On AWS, DynamoDB raises a generic `ValidationException`; the runtime narrows on the size-specific message and re-maps only that case to `ItemTooLarge`, so both layers surface the same `error.name`.
- Emulates TTL: items with an expiry are persisted as `{ "value": "...", "ttl": 1234567890 }` and pruned lazily on `get` (single key) and `scan` (full sweep), standing in for DynamoDB's background reaper. Items without an expiry stay bare serialized strings, so stores written by earlier versions load unchanged and non-expiring writes produce no format churn.

### Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| No throughput limits | Code that would be throttled in AWS succeeds locally | Document the gap; recommend sandbox testing for throughput-sensitive flows |
| No item size limit enforcement beyond 400 KB check | Edge cases around DynamoDB marshalling overhead | Mock validates serialized JSON size, which is a close approximation |
| Immediate consistency (vs eventual) | Reads always reflect the latest write locally | No mitigation — eventual consistency is inherently non-deterministic |
| No IAM enforcement | Permission errors only surface in AWS | No mitigation at mock level — IAM is handled by CDK grants automatically |
| Disk I/O vs DynamoDB latency | Local ops are faster and never timeout | No mitigation needed — latency differences don't affect correctness |
| TTL deletion is immediate on read (vs up to 48 h in DynamoDB) | An expired item's storage is reclaimed sooner locally | Both layers hide expired items from `get`/`scan`, so observable behavior matches; only physical deletion timing differs |
