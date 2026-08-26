# @aws-blocks/bb-distributed-data

Serverless SQL database backed by Amazon Aurora DSQL. Zero-ops, instant provisioning, scale-to-zero, and optionally multi-region active-active writes.

**When to use:** Serverless apps that need to scale without ops overhead, workloads with zero idle cost requirements, multi-region active-active writes, or any SQL app where you don't need FK/RLS/triggers.

**When NOT to use:** If you need foreign keys, Row Level Security, triggers, or stored procedures — use `Database` (Aurora). Also use `Database` if you need DSQL-supported SQL that the local validator does not yet accept, including JSONB columns, persistent views, standalone sequences, or `ALTER TABLE ... DROP COLUMN`. If you need transactions that must not fail at commit under contention — use `Database`. If you're connecting to Supabase — use `Database` with `fromExisting()`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick Start

```typescript
import { DistributedDatabase, sql } from '@aws-blocks/bb-distributed-data';

const db = new DistributedDatabase(scope, 'main', {
  migrationsPath: './aws-blocks/dsql-migrations',
});

// Same query API as Database — parameterized via sql tagged template
const users = await db.query<{ id: string; name: string }>(
  sql`SELECT * FROM users WHERE active = ${true}`
);

const user = await db.queryOne<{ id: string; name: string }>(
  sql`SELECT * FROM users WHERE id = ${userId}`
);

const { rowCount } = await db.execute(
  sql`INSERT INTO users (id, name, email) VALUES (${id}, ${name}, ${email})`
);
```

## Transactions (Optimistic Concurrency Control)

DSQL uses OCC — transactions may fail at commit if another transaction modified the same rows. The callback executes exactly once unless you opt into retry.

```typescript
// Default: no retry. Throws SerializationFailureException on conflict.
await db.transaction(async (tx) => {
  await tx.execute(sql`UPDATE accounts SET balance = balance - ${100} WHERE id = ${fromId}`);
  await tx.execute(sql`UPDATE accounts SET balance = balance + ${100} WHERE id = ${toId}`);
});

// Opt-in retry: callback may execute multiple times.
// ⚠️ Do NOT include external side effects (HTTP calls, emails) inside.
await db.transaction(async (tx) => {
  await tx.execute(sql`UPDATE accounts SET balance = balance - ${100} WHERE id = ${fromId}`);
  await tx.execute(sql`UPDATE accounts SET balance = balance + ${100} WHERE id = ${toId}`);
}, { retryOnConflict: true, maxRetries: 3 });
```

The second argument to `transaction()` accepts:

```typescript
interface TransactionOptions {
  /** Retry on OCC conflict. Callback may execute multiple times. @default false */
  retryOnConflict?: boolean;
  /** Max retry attempts. Only applies when retryOnConflict is true. @default 3 */
  maxRetries?: number;
}
```

## Migrations

One DDL statement per file. DML in separate files. This matches DSQL's transaction constraints.

```
aws-blocks/dsql-migrations/
  001_create_users.sql       ← single DDL
  002_create_posts.sql       ← single DDL
  003_create_index.sql       ← single DDL (CREATE INDEX ASYNC)
  004_seed_admin.sql         ← DML only
```

```sql
-- 001_create_users.sql
CREATE TABLE users (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

```sql
-- 003_create_index.sql
CREATE INDEX ASYNC idx_users_email ON users(email);
```

Migrations are checked against local compatibility rules at dev time. These rules catch common unsupported features such as foreign keys, `SERIAL`, and `TRUNCATE`, but they are not a substitute for current DSQL compatibility guidance.

> **Set `migrationsPath` to a path relative to your project root** (e.g. `'./aws-blocks/dsql-migrations'`); it's resolved at synth from the directory you run `cdk` / `npm run deploy` in. That's the simplest reliable pattern.
>
> You don't need `fileURLToPath(import.meta.url)` for this. Your backend module runs as ESM locally but is bundled to **CommonJS** in Lambda, where `import.meta` is empty. AWS Blocks shims `import.meta.url` / `import.meta.dirname` in the bundle so it won't crash at load — but at runtime those resolve to the **bundled output** location, not your source tree. So don't use `import.meta.url` to read a file relative to your source at request time; inline the data or ship it as a Lambda asset instead.

## DSQL Limitations

DSQL supports a subset of PostgreSQL. The [Aurora DSQL SQL compatibility documentation](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility.html) is the source of truth and evolves as DSQL adds PostgreSQL features. The Aurora DSQL MCP server's `dsql_lint` tool can also check migration SQL and suggest compatible rewrites.

| Not Supported | Alternative |
|---------------|-------------|
| Foreign keys (`REFERENCES`) | Application-layer validation |
| Row Level Security | WHERE clause filtering in app code |
| Triggers | Event-driven logic (EventBridge, Lambda) |
| PL/pgSQL functions | `LANGUAGE SQL` functions or app logic |
| SERIAL / BIGSERIAL | `BIGINT GENERATED BY DEFAULT AS IDENTITY (CACHE 1)` or UUIDs (`gen_random_uuid()`); `CACHE` is required for identity columns and sequences and must be `1` or `>= 65536` |
| TRUNCATE | `DELETE FROM` |
| Temporary tables | CTEs or subqueries |
| LISTEN / NOTIFY | AppSync Events, EventBridge, or polling |
| Extensions | Not available |
| ADD COLUMN with DEFAULT | Add the column without a default, backfill existing rows, then use `ALTER COLUMN ... SET DEFAULT` |
| Index key sort direction (`ASC`/`DESC`) | Omit it; enforce ordering with `ORDER BY` in queries (`NULLS FIRST/LAST` is supported) |

### Local Validation Gaps

The local PGlite validator currently rejects some SQL that DSQL supports:

| DSQL-Supported SQL | Current Local Behavior |
|--------------------|------------------------|
| JSONB columns | Rejected; use `JSON` for local parity |
| Persistent views (`CREATE VIEW`) | Rejected; use CTEs or application-layer query composition |
| `CREATE SEQUENCE` with `CACHE 1` or `CACHE >= 65536` | Rejected; use an identity column |
| `ALTER TABLE ... DROP COLUMN` for non-primary-key columns | Rejected; leave the column in place or rebuild the table |

### Transaction Constraints

| Constraint | Limit |
|-----------|-------|
| Concurrency model | OCC (may conflict at commit) |
| Isolation level | Fixed: Repeatable Read |
| Max rows mutated per transaction | 3,000 |
| Max data per transaction | 10 MiB |
| Max transaction duration | 5 minutes |
| DDL per transaction | 1 statement max |
| DDL + DML mixing | Not allowed |

## Kysely Query Builder

```typescript
import { createKyselyAdapter } from '@aws-blocks/bb-distributed-data';

interface Schema {
  users: { id: string; email: string; name: string };
}

const kysely = createKyselyAdapter<Schema>(db);

const users = await kysely
  .selectFrom('users')
  .where('email', '=', 'user@example.com')
  .selectAll()
  .execute();
```

Do not use Kysely's `.addForeignKeyConstraint()` — it will fail on DSQL.

## Error Handling

```typescript
import { DistributedDatabaseErrors } from '@aws-blocks/bb-distributed-data';
import { isBlocksError } from '@aws-blocks/core';

try {
  await db.transaction(async (tx) => { /* ... */ });
} catch (e: unknown) {
  if (isBlocksError(e, DistributedDatabaseErrors.SerializationFailure)) {
    // OCC conflict — transaction was NOT committed. Safe to retry.
  }
  if (isBlocksError(e, DistributedDatabaseErrors.UniqueConstraintViolation)) {
    // Duplicate key
  }
  if (isBlocksError(e, DistributedDatabaseErrors.QueryFailed)) {
    // General query failure
  }
  if (isBlocksError(e, DistributedDatabaseErrors.TransactionRowLimitExceeded)) {
    // More than 3,000 rows mutated in one transaction
  }
  if (isBlocksError(e, DistributedDatabaseErrors.ConnectionFailed)) {
    // Cannot reach the DSQL cluster
  }
  if (isBlocksError(e, DistributedDatabaseErrors.TransactionFailed)) {
    // Transaction could not commit (general failure distinct from serialization/row-limit)
  }
}
```

## Testing OCC Conflicts

The mock provides a `simulateConflict()` helper for unit testing:

```typescript
db.simulateConflict(); // next commit will fail with SerializationFailureException

await expect(db.transaction(fn)).rejects.toThrow('SerializationFailureException');
```

```typescript
db.simulateConflict(); // first attempt fails, second succeeds
const result = await db.transaction(fn, { retryOnConflict: true });
```

## What It Provisions (AWS)

- **Aurora DSQL Cluster** — Serverless, no VPC required, public endpoint
- **Migration Lambda** — Runs `.sql` files on deploy via CustomResource with retry
- **IAM** — `dsql:DbConnect` (app Lambda, DML only), `dsql:DbConnectAdmin` (migration Lambda, DDL)
- **Environment variables** — `BLOCKS_{name}_ENDPOINT`, `BLOCKS_{name}_REGION`

No VPC, no secrets, no security groups, no proxy. DSQL uses IAM token authentication.

## Local Development

- **Engine:** PGlite (WASM PostgreSQL) wrapped with a DSQL validation layer
- **Storage:** `.bb-data/{fullId}/` — persists across restarts
- **Validation:** Regex-based compatibility checks run before PGlite executes a query
- **Transaction tracking:** DDL/DML mixing and 3,000-row limit enforced locally

The validation layer catches many common incompatibilities locally. Check the current DSQL documentation or use `dsql_lint` as well, especially for features listed under [Local Validation Gaps](#local-validation-gaps).

## Configuration

```typescript
interface DistributedDatabaseOptions {
  /** Path to directory containing numbered .sql migration files. */
  migrationsPath?: string;
  /** Removal policy. @default 'retain' */
  removalPolicy?: 'destroy' | 'retain';
  /** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
  logger?: ChildLogger;
}
```

## Package Export Conditions

```json
{
  "exports": {
    ".": {
      "cdk": "./dist/index.cdk.js",
      "aws-runtime": "./dist/index.aws.js",
      "default": "./dist/index.mock.js"
    }
  }
}
```

## Differences from Database (Aurora)

| Aspect | `Database` (bb-data) | `DistributedDatabase` (bb-distributed-data) |
|--------|---------------------|--------------------------|
| Engine | Aurora Serverless v2 (Data API) | Aurora DSQL (pg + IAM) |
| PostgreSQL compat | Full | Subset (no FK, RLS, triggers) |
| Transactions | Pessimistic (exactly-once) | OCC (may conflict at commit) |
| `withRLS()` | ✅ | ❌ |
| `fromExisting()` | ✅ | ❌ |
| `crud()` | ✅ | ❌ |
| Foreign keys | ✅ | ❌ |
| Multi-region | ❌ | ✅ Active-active |
| VPC required | Yes | No |
| Deploy time | ~10 min | Seconds |
| Idle cost | $0 (0 ACU) | $0 |

