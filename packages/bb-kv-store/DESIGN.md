# KVStore — Design

Design document for KVStore. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-kv-store`
**Type:** Primitive (new infrastructure)
**AWS Service:** DynamoDB (single-table, partition key only)

## API Surface

```typescript
class KVStore<T = string> extends Scope {
	constructor(scope: ScopeParent, id: string, options?: KVStoreOptions<T>);
	get(key: string): Promise<T | null>;
	put(key: string, value: T, conditions?: ConditionalWriteOptions<T>): Promise<void>;
	delete(key: string, conditions?: ConditionalDeleteOptions<T>): Promise<void>;
	scan(): AsyncIterable<{ key: string; value: T }>;
	static fromExisting(tableName: string): ExternalTableRef;
}

interface KVStoreOptions<T = string> {
	/** Runtime validation schema. Accepts any StandardSchemaV1 implementation (Zod, Valibot, ArkType). When provided, T is inferred from the schema. */
	schema?: StandardSchemaV1<T>;
	/** Wrap an existing DynamoDB table instead of creating one. */
	table?: ExternalTableRef;
	/** Optional logger for internal BB diagnostics. Defaults to error-level logging. */
	logger?: ChildLogger;
}

interface ConditionalWriteOptions<T> {
	ifNotExists?: boolean;
	ifValueEquals?: T;
}

interface ConditionalDeleteOptions<T> {
	ifExists?: boolean;
	ifValueEquals?: T;
}
```

## Error Constants

```typescript
export const KVStoreErrors = {
	ConditionalCheckFailed: 'ConditionalCheckFailedException',
	ValidationFailed: 'ValidationFailedException',
	ItemTooLarge: 'ItemTooLargeException',
} as const;
```

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

### Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| No throughput limits | Code that would be throttled in AWS succeeds locally | Document the gap; recommend sandbox testing for throughput-sensitive flows |
| No item size limit enforcement beyond 400 KB check | Edge cases around DynamoDB marshalling overhead | Mock validates serialized JSON size, which is a close approximation |
| Immediate consistency (vs eventual) | Reads always reflect the latest write locally | No mitigation — eventual consistency is inherently non-deterministic |
| No IAM enforcement | Permission errors only surface in AWS | No mitigation at mock level — IAM is handled by CDK grants automatically |
| Disk I/O vs DynamoDB latency | Local ops are faster and never timeout | No mitigation needed — latency differences don't affect correctness |
