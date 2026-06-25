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
PEM or a file path) overrides the committed cert. If neither is available the
connection falls back to `ssl: { rejectUnauthorized: false }` — **encrypted but
unauthenticated** (exposed to man-in-the-middle). Provide the CA for production.

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


