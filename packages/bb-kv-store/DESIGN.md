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
- **Permissions:** `grantReadWriteData` to the parent scope's handler automatically

No sort key, no GSIs. This is intentional — `KVStore` is the simple case. Customers needing sort keys or secondary indexes should use `DistributedTable`.

## Serialization & Validation

Values are serialized to JSON on write and deserialized on read. Both mock and AWS runtime use `JSON.stringify` / `JSON.parse`.

When `options.schema` is provided (any `StandardSchemaV1` implementation — Zod, Valibot, ArkType, etc.), the type parameter `T` is inferred from the schema and every `put()` validates the value at runtime before writing. Validation failures throw with `error.name = 'ValidationFailedException'`. When no schema is provided, `T` defaults to `string` with no runtime validation.

## Mock Implementation

- Data stored in `.bb-data/{scope.fullId}/store.json` via `getMockDataDir()` from core.
- Data persists across dev server restarts. Customers can wipe with `rm -rf .bb-data`.
- Conditional write/delete failures throw with `error.name = 'ConditionalCheckFailedException'`.
- Schema validation on `put()` when configured, throws `ValidationFailedException`.
- Validates the 400 KB item size limit; throws `ItemTooLargeException` (`KVStoreErrors.ItemTooLarge`) on oversized items. On AWS, DynamoDB raises a generic `ValidationException`; the runtime narrows on the size-specific message and re-maps only that case to `ItemTooLarge`, so both layers surface the same `error.name`.

## Agent Tools

`toAgentTools(options?)` exposes KVStore operations as agent tools via the shared `KV_TOOL_METHODS` registry in `agent-tools.ts`. Both mock and AWS runtimes delegate to `kvToAgentTools()` which calls core's `buildAgentTools()` helper.

A KVStore can be keyed by `userId`, so `kvToAgentTools()` passes `{ requiresScope: true }`: callers must supply either `scope` or `unscoped: true`, otherwise `toAgentTools()` throws at construction. See core's `buildAgentTools` for the mechanism.

`scan` is marked `scopeSafe: false`. `scope` pins an exact key, but `scan` lists the whole store, so on a scoped store it would return every user's entries. `buildAgentTools` therefore throws if `scan` is exposed under `scope` — scoped stores must `exclude: ['scan']` (or opt out with `unscoped: true` when the data is genuinely shared).

### Tool Registry (`KV_TOOL_METHODS`)

| Method | `needsApproval` | `trustable` | Notes |
|--------|-----------------|-------------|-------|
| `get` | `false` | — | Read-only |
| `put` | `true` | `true` | Agent can repeat writes without re-prompting |
| `delete` | `true` | `false` | Each deletion requires explicit approval |
| `scan` | `false` | — | Default limit of 100 entries; collects AsyncIterable into array |

### Parameters

Tool parameters are defined as JSON Schema objects. Users can override with zod via `overrides: { methodName: { schema: z.object({...}) } }`.

### Scan Default Limit

`scan` caps results at 100 entries by default to prevent unbounded responses. The agent can pass `{ limit: N }` to override. The handler breaks out of the AsyncIterable once the limit is reached.

### Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| No throughput limits | Code that would be throttled in AWS succeeds locally | Document the gap; recommend sandbox testing for throughput-sensitive flows |
| No item size limit enforcement beyond 400 KB check | Edge cases around DynamoDB marshalling overhead | Mock validates serialized JSON size, which is a close approximation |
| Immediate consistency (vs eventual) | Reads always reflect the latest write locally | No mitigation — eventual consistency is inherently non-deterministic |
| No IAM enforcement | Permission errors only surface in AWS | No mitigation at mock level — IAM is handled by CDK grants automatically |
| Disk I/O vs DynamoDB latency | Local ops are faster and never timeout | No mitigation needed — latency differences don't affect correctness |
