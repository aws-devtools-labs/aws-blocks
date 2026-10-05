# @aws-blocks/bb-distributed-data

Serverless SQL database backed by Amazon Aurora DSQL. Zero-ops, instant provisioning, scale-to-zero, and optionally multi-region active-active writes.

**When to use:** Serverless apps that need to scale without ops overhead, workloads with zero idle cost requirements, multi-region active-active writes, or any SQL app where you don't need FK/RLS/triggers.

**When NOT to use:** If you need foreign keys, Row Level Security, triggers, views, or stored procedures — use `Database` (Aurora). If you need transactions that must not fail at commit under contention — use `Database`. If you're connecting to Supabase — use `Database` with `fromExisting()`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick Start

```typescript
import { DistributedDatabase, sql } from '@aws-blocks/blocks';

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
// Default: no retry. Throws SerializationFailureException (HTTP 409 Conflict, retriable) on conflict.
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

Migrations are validated at dev time — unsupported features (FK, SERIAL, TRUNCATE, etc.) are caught before deploy.

> **Set `migrationsPath` to a path relative to your project root** (e.g. `'./aws-blocks/dsql-migrations'`); it's resolved at synth from the directory you run `cdk` / `npm run deploy` in. That's the simplest reliable pattern.
>
> You don't need `fileURLToPath(import.meta.url)` for this. Your backend module runs as ESM locally but is bundled to **CommonJS** in Lambda, where `import.meta` is empty. AWS Blocks shims `import.meta.url` / `import.meta.dirname` in the bundle so it won't crash at load — but at runtime those resolve to the **bundled output** location, not your source tree. So don't use `import.meta.url` to read a file relative to your source at request time; inline the data or ship it as a Lambda asset instead.

## Live Sync (local-first reads)

Stream rows to the browser and keep them in sync. The client holds a local copy of
the rows that match a **shape** (a table, a row filter, and optional columns). Reads
are local and synchronous, so they never wait on the network. The API is the same as
`Database` sync: an app can move between the two engines without frontend changes.

```typescript
import { ApiNamespace, DistributedDatabase, sql } from '@aws-blocks/blocks';

const db = new DistributedDatabase(scope, 'main', {
  migrationsPath: './aws-blocks/dsql-migrations',
  sync: { tables: ['todos'] },
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  // Reads: return a shape. Authorize first; the shape grants exactly these rows.
  async todos() {
    const user = await auth.requireAuth(context);
    return db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${user.userId}` });
  },

  // Writes: ordinary methods. When the call returns, open shapes have the write.
  async addTodo(title: string) {
    const user = await auth.requireAuth(context);
    await db.execute(sql`INSERT INTO todos (id, owner_id, title) VALUES (${crypto.randomUUID()}, ${user.userId}, ${title})`);
  },
}));
```

```typescript
// Frontend
import { api } from 'aws-blocks';

const todos = await api.todos();          // Shape<Todo>
await todos.ready;                        // initial rows have arrived
todos.subscribe((rows) => render(rows));  // after every change
todos.get('todo-1');                      // local lookup by primary key

await api.addTodo('Buy milk');            // resolves with the row already in `todos.rows`

// React: useSyncExternalStore(todos.subscribe, todos.getSnapshot)
```

`Shape<T>` has the same members as for `Database`: `rows`, `get(key)`, `ready`,
`isUpToDate`, `subscribe(listener)`, `getSnapshot()`, `requestSnapshot(query)`, and
`close()`. `rows` are in arrival order (not sorted: sort them to display), and
`requestSnapshot()` resolves with the loaded rows in the query's order. An API call
that writes resolves only after open shapes have the write; you do not need to do
anything in the API method or on the client.
`db.shape()` takes the same options: `table` (must be in `sync.tables`), `where` (an
`sql` tagged template; values are bound parameters; may use subqueries), `columns`
(must include the key), `key` (primary-key column, default `'id'`), `ttlSeconds`
(default 3600), `mode`, `queryableColumns`, and `columnMapping`. The row type `T`
uses the field names the client sees: with `columnMapping: 'snakeCamel'`, declare
`boardId`, not `board_id`.

Values are parsed the same way: `int2`/`int4`/`float4`/`float8`
become `number`, `int8` becomes `bigint`, `bool` becomes `boolean`,
`json`/`jsonb` become parsed JSON, one-dimensional arrays become arrays, and other
types arrive as `string`. Timestamps arrive as Postgres text, not ISO 8601:
`timestamptz` as `2026-10-05 08:08:10.572+00` (Aurora DSQL uses UTC; local dev uses
your machine's zone) and `timestamp` as `2026-10-05 08:08:10.572`. Pass them back
unchanged as snapshot-query values (`{ lt: row.created_at }`): the database compares
them as timestamps. String order is time order only when all values have the same
offset, and some browsers do not parse this form with `new Date()`. To sort or do
date math on the client, add a numeric column (for example `created_ms double
precision`, set to `Date.now()` on insert), which arrives as a `number`.

**How it works.** A shape keeps no state on the server.
- **Full reconcile** (first load, reconnect, and every 5 minutes as a safety net):
  the client groups its rows into 256 buckets by key and sends one digest per
  bucket. The server reads the shape from Aurora DSQL and returns, as NDJSON, the
  full contents of each bucket that differs. Large answers come in pages of about
  4 MB, and the client parses them one bucket at a time.
- **Changes from other clients:** Aurora DSQL
  [change data capture](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/cdc-streams.html)
  (CDC) sends every committed change to a Kinesis data stream. The app Lambda reads
  it and sends a "bell" on a WebSocket channel for each synced table that changed.
  The bell carries the changed primary keys, encrypted so that only the server can
  read them. Open shapes send the keys back, and the server reads only those rows.
  For a key that is not in the shape any more, the client sends the keys it holds
  in that key's bucket, and drops the ones that are gone. CDC delivers records out
  of order and sometimes more than once. This does not matter, because a shape
  never applies a CDC record. It always reads the current rows.
- **Your own writes:** a plain `INSERT INTO`, `UPDATE`, or `DELETE FROM` on a synced
  table (through `db.execute()`, or `tx.execute()` in a `db.transaction()`) runs with `RETURNING` its primary
  key, and after commit the written keys go back with the API response, encrypted.
  Before the call resolves, the client reads those rows into the open shapes on
  that table. Aurora DSQL reads are strongly consistent, so the read sees the
  write; no wait for CDC and no timeout. Other writes (a CTE, your own `RETURNING`,
  `db.query()`) make open shapes on the database do a full reconcile instead.
  `execute()` returns the same `rowCount` either way.

**React.** `useShape` opens a shape, re-renders on every change, and closes it when
its dependencies change or the component unmounts:

```tsx
import { useShape } from '@aws-blocks/blocks/react';

const { rows, shape, isLoading, error } = useShape(() => api.boardCards(boardId), [boardId]);
```

`rows` (`readonly T[]`) is empty until the shape has loaded. `shape` (`Shape<T> | null`)
is `null` until the API call returns; use it for `get()` and `requestSnapshot()`.
`isLoading` is `true` until the initial rows have arrived. `error` (`Error | null`) is
the error from the API call (for example a 401 from `requireAuth`) or from the
initial sync. `useShape` calls the API method once per change of `deps`, so render the
component that calls it only when the user is signed in, and give it a `key` per
user. The [`Database` README](../bb-data/README.md#live-sync-local-first-reads) has a
"load more" feed in React; it works unchanged here.

**Filters that read other tables.** A `where` may use subqueries. Rows move in and out
of the shape when the other table changes, not only when the row itself does. Every
table the filter reads must be in `sync.tables`.

Every table in `sync.tables` needs a single-column primary key, also a table that
only a subquery reads. Give a join table a surrogate key:

```sql
-- dsql-migrations/001_create_members.sql
CREATE TABLE members (
  id TEXT PRIMARY KEY,           -- for example `${boardId}:${userId}`
  board_id TEXT NOT NULL,
  user_id TEXT NOT NULL
);
```

```sql
-- dsql-migrations/002_index_members.sql
CREATE INDEX ASYNC idx_members_user ON members(user_id);
```

```typescript
const db = new DistributedDatabase(scope, 'main', {
  migrationsPath: './aws-blocks/dsql-migrations',
  sync: { tables: ['cards', 'members'] },   // both tables: the shape's and the subquery's
});

// In an ApiNamespace method, after requireAuth:
return db.shape<Card>({
  table: 'cards',
  where: sql`board_id IN (SELECT board_id FROM members WHERE user_id = ${user.userId})`,
});
// Adding the user to `members` brings that board's cards into the shape.
```

**Large shapes: load what you need.** With `mode: 'changes_only'`, a shape starts empty
(for every client, also when other clients have the same shape open).
Load rows with `requestSnapshot()` (pagination, search, "load more"); loaded rows stay
live. Every change to a row in the shape arrives from then on, also for rows that no
snapshot loaded: a new row appears in `rows` without a request. So page "load more"
from the oldest row you hold, and treat a page shorter than `limit` as the end. A snapshot query is
structured, never SQL, and is always combined with the shape's own `where`, so it can
only narrow the rows the API method authorized. Fields must be in `queryableColumns`
(default: the shape's columns).

```typescript
// Backend
return db.shape<Message>({
  table: 'messages',
  where: sql`channel_id = ${channelId}`,
  mode: 'changes_only',
  queryableColumns: ['sent_at', 'text'],
});

// Frontend
const latest = await messages.requestSnapshot({ orderBy: [{ field: 'sent_at', direction: 'desc' }], limit: 50 });
const older = await messages.requestSnapshot({ where: { sent_at: { lt: latest.at(-1)!.sent_at } }, orderBy: [{ field: 'sent_at', direction: 'desc' }], limit: 50 });
const hits = await messages.requestSnapshot({ where: { text: { ilike: '%invoice%' } }, limit: 20 });
```

Operators: a value (equality), `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `like`,
`ilike`, `isNull`, and `or: [...]`. `limit` is at most 10,000; a `limit` without
`orderBy` sorts by the key. Loaded queries are replayed when the shape has to resync.

**camelCase fields.** `columnMapping: 'snakeCamel'` maps `owner_id` to `ownerId` in rows.
`columns`, `key`, `queryableColumns`, and snapshot queries then use field names;
`where` stays SQL.

**Schema changes.** After a migration changes a synced table, open shapes drop their
rows and load them again in the new form, and changes-only shapes replay their
snapshot queries.

**Security.** Every shape is authorized by the API method that returns it. That
method signs the table, row filter, and columns into an expiring token. The client
cannot change them, so a user receives only the rows your filter allows. When the
token expires, the client calls the same API method again, which re-runs your
checks. Bells and write responses carry keys only in encrypted form (AES-GCM,
bound to the table), and the server returns only rows that match the shape's filter.
A bell does show that the table changed. Sign-out does not revoke a shape that is
already open: reload the page on sign-out.

**Cost.** When no client is connected, sync costs only the Kinesis stream: one
provisioned shard is about $11 per month in us-west-2. The Lambda consumer, the
WebSocket API, and Aurora DSQL CDC cost nothing when idle. A change costs a read of
the changed rows per open shape on the table; only a full reconcile reads the whole
shape.

**Performance.** Reads (`rows`, `get()`) are local. With 2 clients writing all the
time, lookups stay under 1 µs and the main thread is blocked for at most 0.2 ms
at p99.9, with 2,000, 10,000, or 50,000 rows. A change costs O(changed rows) in the
browser: `rows` is patched, not rebuilt.

**Requirements and limits.**
- Each table in `sync.tables` needs a single-column primary key, also a table that
  only a subquery reads.
- A full reconcile reads the whole shape. It runs on the first load, on reconnect,
  and every 5 minutes, so very large shapes (more than about 50,000 rows) make
  these slower. Use narrower filters for larger data.
- A write wakes only the shapes it can affect when their filter has a top-level
  `column = $n` term (for example `owner_id = ${user.userId}`): the bell goes to a
  channel for that value. Shapes without
  such a term, and every shape on a table a subquery reads, wake on each write to
  the table. A bell carries up to about 16 KB of keys; a larger change (for example
  a bulk insert) makes open shapes do a full reconcile.
- A change only to a table a subquery reads makes the shape do a full reconcile (or,
  changes-only, a re-check of its rows).
- One shard accepts 1,000 records per second. A larger burst of writes makes DSQL
  retry, which delays bells. Set `sync.shards` for higher write rates.
- Sync needs a Lambda compute (the app Lambda reads the CDC stream).
- The first deploy creates the CDC stream, which takes 1 to 3 minutes.

**Local dev.** The same protocol runs on PGlite. Row triggers record the changed
keys, and writes made through `db` ring the bell with them at once. There is no CDC
stream, so writes that do not go through `db` reach open shapes at the next write
through `db` or at the next safety sync. See [DESIGN.md](./DESIGN.md#live-sync).

## DSQL Limitations

DSQL is a subset of PostgreSQL. The local mock enforces these restrictions so code that works locally also works in production.

| Not Supported | Alternative |
|---------------|-------------|
| Foreign keys (`REFERENCES`) | Application-layer validation |
| JSONB columns | `JSON` type (JSONB available as `::jsonb` runtime cast) |
| Row Level Security | WHERE clause filtering in app code |
| Triggers | Event-driven logic (EventBridge, Lambda) |
| Views | CTEs or application-layer query composition |
| PL/pgSQL functions | `LANGUAGE SQL` functions or app logic |
| SERIAL / BIGSERIAL | UUIDs (`gen_random_uuid()`) |
| TRUNCATE | `DELETE FROM` |
| Temporary tables | CTEs or subqueries |
| LISTEN / NOTIFY | AppSync Events, EventBridge, or polling |
| Extensions | Not available |
| ADD COLUMN with DEFAULT | Add column without default, handle nulls in app |
| Index key sort direction (`ASC`/`DESC`) | Omit it; enforce ordering with `ORDER BY` in queries (`NULLS FIRST/LAST` is supported) |
| `ALTER TABLE DROP [COLUMN]` | Leave the column in place and stop referencing it; or rebuild the table (create new → `INSERT INTO ... SELECT` → `DROP` → `RENAME TO`, one migration file per step) |

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

The adapter is not re-exported by `@aws-blocks/blocks`: add
`@aws-blocks/bb-distributed-data` to your dependencies to use it.

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
import { DistributedDatabaseErrors, isBlocksError } from '@aws-blocks/blocks';

try {
  await db.transaction(async (tx) => { /* ... */ });
} catch (e: unknown) {
  if (isBlocksError(e, DistributedDatabaseErrors.SerializationFailure)) {
    // OCC conflict — transaction was NOT committed. Serialized as HTTP 409
    // (Conflict), retriable — safe to retry.
  }
  if (isBlocksError(e, DistributedDatabaseErrors.UniqueConstraintViolation)) {
    // Duplicate key — serialized as HTTP 409 (Conflict), not retriable
    // (a blind retry of the same insert fails identically).
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
import assert from 'node:assert';
import { DistributedDatabaseErrors, isBlocksError } from '@aws-blocks/blocks';

db.simulateConflict(); // next commit will fail with SerializationFailureException

await assert.rejects(db.transaction(fn), (e: unknown) => isBlocksError(e, DistributedDatabaseErrors.SerializationFailure));
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
- **With `sync`:** a provisioned Kinesis data stream (the CDC target), the IAM role
  Aurora DSQL assumes to write to it (write-only, on that stream), the CDC stream
  (a custom resource, because CloudFormation has no resource type for it), a
  Kinesis event source on the app Lambda, a Realtime WebSocket channel for bells,
  and an SSM SecureString for the shape-token key

No VPC, no secrets, no security groups, no proxy. DSQL uses IAM token authentication.

## Local Development

- **Engine:** PGlite (WASM PostgreSQL) wrapped with a DSQL validation layer
- **Storage:** `.bb-data/{fullId}/` — persists across restarts
- **Validation:** Unsupported features (FK, triggers, SERIAL, etc.) are rejected at query time
- **Transaction tracking:** DDL/DML mixing and 3,000-row limit enforced locally

The validation layer ensures code that works locally also works against a real DSQL cluster.

## Configuration

```typescript
interface DistributedDatabaseOptions {
  /** Path to directory containing numbered .sql migration files. */
  migrationsPath?: string;
  /** Removal policy. @default 'retain' */
  removalPolicy?: 'destroy' | 'retain';
  /** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
  logger?: ChildLogger;
  /** Live sync for `db.shape()`. See "Live Sync". */
  sync?: {
    /** Tables that `db.shape()` may stream. */
    tables: string[];
    /** Kinesis shards for the CDC stream (AWS only). @default 1 */
    shards?: number;
  };
}
```

## Package Export Conditions

```json
{
  "exports": {
    ".": {
      "browser": "./dist/index.browser.js",
      "cdk": { "types": "./dist/index.cdk.d.ts", "default": "./dist/index.cdk.js" },
      "aws-runtime": "./dist/index.aws.js",
      "types": "./dist/index.mock.d.ts",
      "default": "./dist/index.mock.js"
    },
    "./sync-client": { "types": "./dist/sync/client.d.ts", "default": "./dist/sync/client.js" }
  }
}
```

`./sync-client` is the browser middleware that hydrates shapes. The generated client
imports it when a `DistributedDatabase` has `sync`.

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
| Live sync (`db.shape()`) | Sync service on Fargate | Reconcile + CDC; ~$11/month idle (Kinesis) |


