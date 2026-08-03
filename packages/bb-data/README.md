# @aws-blocks/bb-data

Full PostgreSQL database — provisions Aurora Serverless v2 by default, or connects to an existing PostgreSQL database (Supabase, Neon, etc.) via `fromExisting()`. Full relational modeling with foreign keys, transactions, Row Level Security, and a type-safe Kysely query builder.

**When to use:** Complex multi-table JOINs, ACID transactions, foreign key constraints, aggregations, Row Level Security, or connecting to an existing PostgreSQL database. Use when you need the full power of PostgreSQL.

**When NOT to use:** For simple key-value lookups, use `KVStore`. For NoSQL with secondary indexes, use `DistributedTable`. For serverless SQL without FK/RLS/triggers (multi-region, instant provisioning), use `DistributedDatabase`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick Start

```typescript
import { Database, sql } from '@aws-blocks/bb-data';

const db = new Database(scope, 'main', {
  migrationsPath: './aws-blocks/migrations',
});

// Parameterized queries via sql tagged template (injection-safe)
const users = await db.query<{ id: string; name: string }>(
  sql`SELECT * FROM users WHERE active = ${true}`
);

const user = await db.queryOne<{ id: string; name: string }>(
  sql`SELECT * FROM users WHERE id = ${userId}`
);

const { rowCount } = await db.execute(
  sql`INSERT INTO users (id, name, email) VALUES (${id}, ${name}, ${email})`
);

// Transactions
await db.transaction(async (tx) => {
  await tx.execute(sql`UPDATE accounts SET balance = balance - ${100} WHERE id = ${fromId}`);
  await tx.execute(sql`UPDATE accounts SET balance = balance + ${100} WHERE id = ${toId}`);
});
```

## Migrations

Create numbered `.sql` files in a migrations directory:

```
aws-blocks/migrations/
  001_create_users.sql
  002_create_posts.sql
  003_seed_admin.sql
```

```sql
-- 001_create_users.sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Migrations run automatically:
- **Local dev:** On first query (PGlite, persists in `.bb-data/`)
- **AWS deploy:** Via a CustomResource Lambda during `cdk deploy`

Applied migrations are tracked in a `_migrations` table. Each file runs once.

## Fluent Query Client

A typed, schema-aware client for everyday reads and writes. Table and column names are
checked against the schema generated from your migrations, so a rename that breaks a
query is a compile error rather than a runtime one.

```typescript
import { createDataClient } from '@aws-blocks/bb-data/fluent';
import { tableMeta, type TableMeta } from './schema/database.meta.js';

export const data = createDataClient<TableMeta>(db, tableMeta);

const notes = await data.from('notes')
  .select('id', 'text')          // result type narrows to { id, text }
  .eq('done', false)
  .order('created_at', 'desc')
  .limit(20);

const note = await data.from('notes').insert({ text: 'hello' });
await data.from('notes').update({ done: true }).eq('id', note.id);
await data.from('notes').delete().eq('id', note.id);
```

Both arguments come from
[`@aws-blocks/bb-data/schema-sync`](#deriving-types-from-migrations), so the types
follow your migrations with no hand-maintained interface.

**What it guarantees**

- **Values are always parameterized** and identifiers are validated against the
  schema, so nothing a caller passes can become SQL.
- **Errors throw.** No `{ data, error }` tuple that the compiler can't force you to
  check — match failures with `isBlocksError`.
- **Writes require a filter.** `update()` and `delete()` throw unless narrowed, so a
  forgotten `.eq(...)` can't rewrite or empty a table.
- **Reads that find nothing return `null`**, not an error: `first()` is ordinary
  control flow.
- Queries are real promises (`.catch()`, `.finally()`, `Promise.all` all work) and run
  once no matter how often they're awaited.

`insert()` accepts exactly what Postgres will: server-managed columns (serial,
`DEFAULT now()`) are rejected, columns with a default or that are nullable are
optional, everything else is required.

### Choosing between the three query tiers

| Use | When |
|---|---|
| Fluent client | everyday CRUD, filters, ordering, pagination |
| Kysely adapter | joins, subqueries, CTEs — anything relational |
| `sql` tag | window functions, `FILTER`, extensions, hand-tuned SQL |

All three run against the same database and can be mixed freely.

`db.crud()` (below) predates the fluent client and covers the same ground with
generated per-table method names. It remains supported; new code should prefer the
fluent client, which checks column names and narrows result types.

## Kysely Query Builder

For type-safe queries without raw SQL:

```typescript
import { createKyselyAdapter } from '@aws-blocks/bb-data';

interface Schema {
  users: { id: string; email: string; name: string };
  posts: { id: string; user_id: string; title: string };
}

const kysely = createKyselyAdapter<Schema>(db);

// Type-safe SELECT
const users = await kysely
  .selectFrom('users')
  .where('email', '=', 'user@example.com')
  .selectAll()
  .execute();

// JOINs
const posts = await kysely
  .selectFrom('posts')
  .innerJoin('users', 'users.id', 'posts.user_id')
  .select(['posts.title', 'users.name'])
  .execute();

// Transactions
await kysely.transaction().execute(async (trx) => {
  await trx.insertInto('users').values({ id: '1', email: 'a@b.com', name: 'A' }).execute();
  await trx.insertInto('posts').values({ id: '1', user_id: '1', title: 'Hello' }).execute();
});
```

See [Kysely documentation](https://kysely.dev) for the full query builder API.

## Deriving types from migrations

Your migrations are the source of truth; the types follow from them with no command to
run and nothing to keep fresh by hand.

```typescript
import { syncSchema } from '@aws-blocks/bb-data/schema-sync';

await syncSchema({ migrationsPath: './migrations', outDir: './lib/schema' });
```

This writes `database.types.ts` (a row interface per table) and `database.meta.ts` (the
runtime metadata the fluent client validates against). In a Next.js app,
[`@aws-blocks/nextjs`](https://www.npmjs.com/package/@aws-blocks/nextjs) runs it for
you during `next dev` and re-runs it whenever a migration changes.

Migrations are applied to a **throwaway** database rather than your dev one, for two
reasons: PGlite is single-writer per data directory, so introspecting a running dev
server's database would contend for its lock; and the types should describe what the
migrations produce, not whatever state a long-lived dev database has drifted into.

Files are only rewritten when their content changes, so this is safe to call on every
file-change event. Commit the output — a fresh clone then typechecks and editors have
types before the dev server has ever run — and consider a check that regenerates and
fails on a diff, so it can't drift.

> Temporal columns are typed as `Date`, which is what both `pg` and PGlite return.
> Note that the older `db pull` generator declares them `string`; that mapping is
> unchanged for backward compatibility.

## Browser-Direct Queries (Data API)

Lets browser code read and write tables with no endpoint written per query, while
authorization stays in the database as RLS policy.

```typescript
// server — one endpoint for every table
import { createDataApi } from '@aws-blocks/bb-data/data-api';

const dataApi = createDataApi({
  db,
  schema: tableMeta,
  tables: ['notes'],                             // opt-in only
  auth: async () => auth.requireAuth(context),   // required
});

export async function POST(request: Request) {
  return Response.json(await dataApi.execute(await request.json()));
}
```

```typescript
// browser — no URL and no API key; rides the session you already have
import { createRemoteDataClient } from '@aws-blocks/bb-data/data-api/client';

const data = createRemoteDataClient<TableMeta>(async (query) => {
  const res = await fetch('/api/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });
  if (!res.ok) throw new Error((await res.json()).message);
  return res.json();
});

const notes = await data.from('notes').select('id', 'text').eq('done', false).limit(20);
```

The browser client mirrors the [fluent client](#fluent-query-client), so the same query
reads the same on either side of the wire.

### What protects it

- **Authentication is mandatory.** `auth` is required and must resolve a user — there is
  no anonymous mode to forget to turn off. This is the substantive difference from an
  anon-key model, where a table is world-readable until RLS is added. Callers are
  authenticated *before* validation, so an anonymous prober learns nothing about your
  schema from error messages.
- **Tables are opt-in.** A table present in the schema but absent from `tables` is
  refused.
- **The client never sends SQL.** It sends a description; the server validates it
  against the introspected schema and a closed operator set, then builds the statement
  itself. Unknown tables, columns, operators and order directions, and non-scalar filter
  values, are all rejected.
- **Every query runs under `withRLS`** with the caller's claims, so policies decide which
  rows are visible.
- **Writes are constrained.** `update` and `delete` require a filter, database-managed
  columns cannot be set, and a limit is always applied so a single request cannot pull an
  entire table.

### Let Postgres assign ownership

Give the owning column a default that reads the caller's claims:

```sql
ALTER TABLE notes ADD COLUMN owner TEXT NOT NULL
    DEFAULT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::json->>'sub', 'system');
```

Introspection then classifies `owner` as server-managed, so the data API refuses any
attempt to set it — a client cannot create a row for someone else even before the
policy's `WITH CHECK` is consulted.

> **Trusted server code bypasses RLS.** The [fluent client](#fluent-query-client) runs
> queries directly, so scope them yourself (`.eq('owner', user.userId)`) or go through
> `withRLS`. RLS is the gate for *untrusted* callers; server code is already trusted.

## Row Level Security (RLS)

Scope queries to a user context with Supabase-compatible session variables:

```typescript
const scoped = db.withRLS({ userId: 'user-123', role: 'authenticated' });

// All queries on `scoped` run inside a transaction with SET LOCAL ROLE
// and request.jwt.claims set — PostgreSQL RLS policies are enforced.
const myPosts = await scoped.query<Post>(sql`SELECT * FROM posts`);
```

> **Local (PGlite) prerequisite:** `withRLS` issues `SET LOCAL ROLE <role>` (default `authenticated`). PGlite has no such role by default, so a migration must create it or local queries fail with `role "authenticated" does not exist`. Add to your migrations:
>
> ```sql
> CREATE ROLE authenticated;
> CREATE ROLE anon;
> -- grant table privileges to these roles as needed, then define RLS policies
> ```

## CRUD Handlers

Generate typed CRUD methods from a schema definition:

```typescript
const crud = db.crud({
  tables: ['users', 'posts'],
  // `auth` takes no arguments — close over your request context to resolve the user.
  auth: async () => {
    const user = await auth.requireAuth(context);
    return { userId: user.userId };
  },
});

// Auto-generated flat method names per table:
//   crud.listUsers(), crud.getUser(id), crud.createUser(data),
//   crud.updateUser(id, data), crud.deleteUser(id)
//   crud.listPosts(), crud.getPost(id), ...
```

## Connecting to an Existing Database

```typescript
import { Database, fromExisting } from '@aws-blocks/bb-data';

// Supabase, Neon, or any PostgreSQL-compatible database
const db = new Database(scope, 'external', {
  connection: fromExisting({ connectionString: process.env.DATABASE_URL! }),
});
```

### TLS certificate verification

The server's TLS certificate is **verified by default**. Managed providers
(Supabase, Neon, RDS) present a certificate signed by a provider-specific CA
that is not in Node's built-in trust store, so verification requires pinning
that CA. `ssl.ca` takes the certificate **contents** (a PEM string), not a path —
for Supabase, download `prod-ca-2021.crt` from your project's **Database Settings
→ SSL Configuration**:

```typescript
import { readFileSync } from 'node:fs';

const db = new Database(scope, 'external', {
  connection: fromExisting({
    connectionString: process.env.DATABASE_URL!,
    ssl: { ca: readFileSync('./supabase-ca.crt', 'utf8') },
  }),
});
```

`bb-data pull` wires this for you: it prompts for your CA certificate and commits
it to `aws-blocks/database.ca.ts` (a public, non-secret cert that is bundled into
your deployed function), so the connection is **verified by default** — including
in the deployed Lambda, with no runtime configuration. `DATABASE_CA_CERT` (inline
PEM or a file path) overrides the committed cert. If neither is available, the
generated wiring falls back to `ssl: { rejectUnauthorized: false }` (**encrypted but
unauthenticated**) in local dev only; the **deployed function fails closed**
(refuses to connect) rather than running unverified. Provide the CA for production.

## Migrating from Supabase

Already have a Supabase app? `bb-data pull` connects to your existing Supabase database and generates a complete, type-safe backend — keeping your tables, data, and RLS policies exactly as they are.

```sh
npx bb-data pull
```

What it does:
- Introspects your public-schema tables (read-only — your database is not modified)
- Generates typed definitions, CRUD operations, and a personalized migration guide
- Stores your connection string locally (encrypted in SSM on deploy)

What it does NOT migrate: Supabase Auth, Storage, Realtime, or Edge Functions. If you use a third-party OIDC provider (Auth0, Clerk, Google, Cognito), you can wire it into Blocks — see the generated `MIGRATION_GUIDE.md#auth`.

After pulling, run `npm run dev` to start developing locally against your real database.

Once pulled, manage schema changes with version-controlled SQL migrations in `./migrations/` — applied automatically on `npm run dev` and `npm run deploy`. See the generated `MIGRATION_GUIDE.md#evolving-your-schema`.

## Error Handling

```typescript
import { DatabaseErrors } from '@aws-blocks/bb-data';
import { isBlocksError } from '@aws-blocks/core';

try {
  await db.execute(sql`INSERT INTO users (id, email) VALUES (${id}, ${email})`);
} catch (e: unknown) {
  if (isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)) {
    // Duplicate key — email already exists
  }
  if (isBlocksError(e, DatabaseErrors.QueryFailed)) {
    // General query failure (syntax error, missing table, etc.)
  }
  if (isBlocksError(e, DatabaseErrors.TransactionFailed)) {
    // Transaction could not commit
  }
  if (isBlocksError(e, DatabaseErrors.SerializationFailure)) {
    // Serializable-isolation conflict with a concurrent transaction — safe to retry
  }
  if (isBlocksError(e, DatabaseErrors.ConnectionFailed)) {
    // Cannot reach the database
  }
}
```

## What It Provisions (AWS)

- **Aurora Serverless v2** — PostgreSQL-compatible, scales 0.5-128 ACUs
- **VPC** — Private subnets (isolated, no NAT)
- **RDS Proxy** — Connection pooling
- **Secrets Manager** — Auto-generated credentials, auto-rotated
- **Migration Lambda** — Runs `.sql` files on deploy via CustomResource
- **IAM** — `rds-data:*` and `secretsmanager:GetSecretValue` granted to the app Lambda

## Local Development

- **Engine:** PGlite (WASM PostgreSQL) — full Postgres compatibility
- **Storage:** `.bb-data/{fullId}/` — persists across restarts, wipe with `rm -rf .bb-data`
- **Migrations:** Run automatically on first query

## Configuration

```typescript
interface DatabaseOptions {
  /** Path to directory containing numbered .sql migration files. */
  migrationsPath?: string;
  /** Connect to an existing database instead of provisioning one. */
  connection?: ExternalDatabaseRef;
  /** Schema metadata for crud() support. */
  schema?: TableSchema;
  /** Aurora PostgreSQL engine version, e.g. '16.13'. Override the Aurora engine version. @default '16.13' */
  postgresVersion?: string;
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

## Performance

- **Query latency:** 10-50ms (warm), ~500ms cold start from 0 ACUs
- **Throughput:** Thousands of concurrent connections via RDS Proxy
- **Storage:** Up to 128 TiB, auto-scales in 10 GiB increments
- **Cost:** ~$0.12/ACU-hour + ~$0.10/GB-month storage
- **Durability:** 6 copies across 3 AZs, 99.99% availability


