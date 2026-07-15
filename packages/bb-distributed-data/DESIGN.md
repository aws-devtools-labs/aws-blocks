# DistributedDatabase — Design

Design document for the DistributedDatabase Building Block. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-distributed-data`
**Type:** Primitive (new infrastructure)
**AWS Service:** Amazon Aurora DSQL

## Architecture

```
data-common (shared abstractions)
    ├── DatabaseEngine interface
    ├── DatabaseBase class
    ├── sql tagged template + SqlQuery
    ├── Kysely adapter
    └── splitStatements()

bb-distributed-data (this package)
    ├── DsqlEngine (AWS — pg.Pool + IAM token auth)
    ├── DsqlMockEngine (local — PGlite + validation layer)
    ├── Validation layer (DSQL compatibility checks)
    ├── TransactionTracker (DDL/DML/row-limit enforcement)
    ├── DSQL-specific migration runner
    └── CDK construct (CfnResource + migration CustomResource)
```

## Why a Separate Block (Not an Engine Flag on Database)

1. **Transaction semantics differ** — OCC means callbacks may need retry. Different API contract.
2. **Feature set is a strict subset** — FK, RLS, triggers, views absent. An engine flag hides this until deploy time.
3. **Mock parity goes in opposite directions** — PGlite is too permissive for DSQL. A separate block can have a restrictive mock.
4. **"When to use" guidance is completely different** — customers shouldn't accidentally pick DSQL.
5. **Multi-region is a first-class capability** — not a bolt-on option.

## Engine Implementations

### DsqlEngine (AWS Runtime)

- `pg.Pool` with IAM token authentication via `@aws-sdk/dsql-signer`
- Password callback generates fresh tokens per connection (60-min expiry)
- Translates pg error codes to `DistributedDatabaseErrors` names
- Pool handles reconnection transparently when connections expire

### DsqlMockEngine (Local Dev)

- PGlite wrapped with a validation layer
- `validateStatement()` rejects unsupported SQL before execution
- `TransactionTracker` enforces DDL/DML separation and 3,000-row limit
- `simulateConflict()` test helper for OCC testing
- Error translation matches production behavior

## Validation Layer

The core insight: PGlite supports everything DSQL doesn't. Without validation, code works locally but breaks in production — the worst failure mode. The mock actively restricts PGlite to match DSQL's subset.

### Statement Validation

`validateStatement(sql)` strips string literals and comments, then checks regex patterns:

| Pattern | Rejects |
|---------|---------|
| `FOREIGN KEY` / `REFERENCES` | FK constraints |
| `CREATE TRIGGER` | Triggers |
| `CREATE VIEW` | Views |
| `LANGUAGE plpgsql` | PL/pgSQL functions |
| `SERIAL` / `BIGSERIAL` | Sequences |
| `TRUNCATE` | Use DELETE FROM |
| `LISTEN` / `NOTIFY` | Async notifications |
| `CREATE EXTENSION` | Extensions |
| `ADD COLUMN ... DEFAULT` | Column default on ALTER |
| `ALTER DEFAULT PRIVILEGES` | Not supported by DSQL |
| `CREATE POLICY` / `ENABLE ROW LEVEL SECURITY` | RLS |
| `CREATE TEMP TABLE` | Temporary tables |
| `SET TRANSACTION ISOLATION LEVEL` | Fixed Repeatable Read |
| `COLLATE` | C collation only |
| `CREATE INDEX ... ASC/DESC` | Sort direction on index keys (NULLS FIRST/LAST is allowed) |

### Transaction Tracking

`TransactionTracker` enforces per-transaction constraints:

- Max 1 DDL statement per transaction
- Cannot mix DDL and DML in the same transaction
- Max 3,000 rows mutated (cumulative across all executes)

### Migration Validation

`validateMigrations()` checks all files upfront before running any:

- Each file: max 1 DDL statement
- Each file: no DDL + DML mixing
- All statements pass `validateStatement()`

## Migration Runner

DSQL's migration runner differs from the generic one in `data-common`:

- **DDL files** run as implicit transactions (no explicit BEGIN/COMMIT) — DSQL auto-commits DDL
- **DML files** run in explicit transactions (atomic)
- `validateMigrations()` runs upfront — catches errors before any SQL executes
- Uses `gen_random_uuid()` for `_migrations.id` (no SERIAL)

## OCC Retry Logic

```typescript
async transaction<T>(fn, options?) {
  const maxAttempts = options?.retryOnConflict ? (options.maxRetries ?? 3) + 1 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await this.base.transaction(fn);
    } catch (e) {
      const isOcc = e.code === '40001' || e.name === 'SerializationFailureException';
      if (isOcc && attempt < maxAttempts) continue;
      throw e;
    }
  }
}
```

Default: no retry (honest, predictable). `retryOnConflict: true` is explicit opt-in with JSDoc warning about side effects.

## Atomic Counters

DSQL has no sequences (`SERIAL` / `BIGSERIAL` are rejected by the validator), so code that needs a monotonic sequence number is otherwise pushed into a racy `SELECT MAX(seq) + 1` read-modify-write: two concurrent callers read the same maximum and both write the same next value, producing duplicate or skipped numbers.

`db.counter(name)` replaces that pattern with a single atomic upsert against a framework-managed table:

```sql
CREATE TABLE IF NOT EXISTS _blocks_counters (name TEXT PRIMARY KEY, value BIGINT NOT NULL DEFAULT 0);

-- Counter.next(delta) — atomic read-and-increment in one statement:
INSERT INTO _blocks_counters (name, value) VALUES ($name, $delta)
  ON CONFLICT (name) DO UPDATE SET value = _blocks_counters.value + $delta
  RETURNING value;
```

- **Atomicity** — the increment is one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` statement, so there is no read-then-write window for a competing writer. It runs inside `transaction({ retryOnConflict: true })` so a DSQL OCC conflict on the row retries transparently.
- **Managed table** — `_blocks_counters` is created by the migration Lambda (admin) on every deploy, like `_migrations`. The app runtime is DML-only and never issues the DDL. Because the table is admin-owned and not named `_migrations`, `provisionAppRole` automatically grants the app role `SELECT/INSERT/UPDATE/DELETE` on it.
- **Mock parity** — `DsqlMockEngine` creates the same table inside its `withDdl` init window, so `db.counter()` behaves identically against PGlite locally.
- **Range** — values are stored as `BIGINT` and returned as `number` (exact up to 2^53 − 1).

API: `Counter.next(delta = 1)`, `Counter.current()`, `Counter.reset(value = 0)`.

## Error Translation

Happens in the engine layer (same pattern as bb-data engines):

| pg error code | DistributedDatabaseErrors name |
|---------------|------------------------|
| `40001` | `SerializationFailure` |
| `23505` | `UniqueConstraintViolation` |
| `08xxx` | `ConnectionFailed` |
| (other) | `QueryFailed` |

The `DistributedDatabase` class does not wrap errors — engines handle translation.

## Infrastructure (CDK)

| Resource | Purpose |
|----------|---------|
| `AWS::DSQL::Cluster` (CfnResource) | DSQL cluster |
| Migration Lambda (NodejsFunction) | Runs .sql files on deploy |
| CustomResource + Provider | Triggers migration on deploy |
| IAM PolicyStatement | `dsql:DbConnect` (app Lambda), `dsql:DbConnectAdmin` (migration Lambda) |
| CfnOutput | Cluster endpoint |

### Deletion Protection

`DeletionProtectionEnabled` is computed from `removalPolicy`:
- `destroy` or `sandboxMode=true` → disabled
- Otherwise → enabled

### Migration Lambda

- Connects via `pg.Client` + `DsqlSigner.getDbConnectAdminAuthToken()`
- Retries with exponential backoff on transient connection errors (cluster may take a moment after creation)
- `.sql` files bundled into the Lambda package via CDK `commandHooks`
- `migrationsHash` property triggers re-invocation when files change
- **Ensures the `_blocks_counters` table** exists (see [Atomic Counters](#atomic-counters)) — created here as admin so the DML grants below cover it
- **Provisions custom DB role** on every deploy (idempotent):
  1. `CREATE ROLE "app_role" WITH LOGIN` (if not exists)
  2. `AWS IAM GRANT "app_role" TO 'arn:aws:iam::...:role/...'` (maps IAM to DB role)
  3. Per-table `GRANT SELECT, INSERT, UPDATE, DELETE` on user-created tables

### DSQL Permission Model Limitations

- `ALTER DEFAULT PRIVILEGES` — not supported (system entity error)
- `GRANT ... ON ALL TABLES IN SCHEMA public` — not supported (`public` is a system entity)
- `GRANT USAGE ON SCHEMA public` — not supported (same reason)
- Handled by enumerating user tables via `pg_tables` and granting DML individually on each deploy

## Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| No real OCC conflicts | Single-connection PGlite has no concurrency | `simulateConflict()` test helper |
| PGlite supports JSONB columns | DSQL rejects JSONB as a column type (use JSON instead; JSONB available as runtime cast only) | Validator rejects JSONB in DDL |
| System collation vs C only | String sorting may differ | Reject explicit COLLATE |
| No 60-min connection timeout | Dev sessions are short | Document only |
| No 10 MiB / 5-min tx limits | Impractical to measure locally | Document only |
| CREATE INDEX ASYNC is synchronous | Index immediately available locally | Log warning |

## Connection Management

DSQL uses IAM token authentication:
- **App Lambda**: `DsqlSigner.getDbConnectAuthToken()` (DML only)
- **Migration Lambda**: `DsqlSigner.getDbConnectAdminAuthToken()` (DDL)
- `pg.Pool` with password callback (fresh token per connection)
- 60-min connection timeout — transparent to Lambda (short-lived)
- No secrets, no VPC, no proxy needed

## Relationship to data-common

`bb-distributed-data` uses `DatabaseBase` from `data-common` directly (no subclass). Error translation is in the engine. This is the cleaner pattern — `bb-data` subclasses `DatabaseBase` only because it adds RLS support.

Shared from `data-common`:
- `DatabaseEngine` / `DatabaseBase` / `TransactionHandle`
- `sql` / `SqlQuery` / `unwrapQuery`
- `createKyselyAdapter`
- `splitStatements`

DSQL-specific (not shared):
- `validateStatement` / `classifyStatement` / `TransactionTracker`
- `validateMigrations`
- `DsqlEngine` / `DsqlMockEngine`
- `DistributedDatabaseErrors`
- OCC retry logic
