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

> **Set `migrationsPath` to a path relative to your project root** (as in the Quick Start — `'./aws-blocks/migrations'`); it's resolved at synth from the directory you run `cdk` / `npm run deploy` in. That's the simplest reliable pattern.
>
> You don't need `fileURLToPath(import.meta.url)` for this. Your backend module runs as ESM locally but is bundled to **CommonJS** in Lambda, where `import.meta` is empty. AWS Blocks shims `import.meta.url` / `import.meta.dirname` in the bundle so it won't crash at load — but at runtime those resolve to the **bundled output** location, not your source tree. So don't use `import.meta.url` to read a file relative to your source at request time; inline the data or ship it as a Lambda asset instead.

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
    // Duplicate key — email already exists. Serialized as HTTP 409 (Conflict),
    // not retriable (a blind retry of the same insert fails identically).
  }
  if (isBlocksError(e, DatabaseErrors.QueryFailed)) {
    // General query failure (syntax error, missing table, etc.)
  }
  if (isBlocksError(e, DatabaseErrors.TransactionFailed)) {
    // Transaction could not commit
  }
  if (isBlocksError(e, DatabaseErrors.SerializationFailure)) {
    // Serializable-isolation conflict with a concurrent transaction — serialized
    // as HTTP 409 (Conflict), retriable — safe to retry
  }
  if (isBlocksError(e, DatabaseErrors.ConnectionFailed)) {
    // Cannot reach the database — includes a `minCapacity: 0` cluster resuming
    // from auto-pause, which succeeds on retry a few seconds later
  }
}
```

## What It Provisions (AWS)

- **Aurora Serverless v2** — PostgreSQL-compatible, scales 0.5-128 ACUs. Storage
  encryption at rest is **opt-in via a context flag** so new projects are secure by
  default without replacing an existing cluster. New `create-blocks-app` projects
  set `"@aws-blocks/bb-data:encryptStorageByDefault": true` in `cdk.json`, which
  turns on encryption with the account's AWS-managed `aws/rds` key. Passing a
  `storageEncryptionKeyArn` (the ARN of a customer-managed KMS key) also turns
  encryption on regardless of the flag and uses that key instead (it also encrypts
  the generated credentials secret). When neither the flag nor a key is set, the
  cluster is synthesized without the `StorageEncrypted` property (an existing,
  unencrypted cluster is left untouched) and a synth warning explains how to opt
  in. The key is **imported** (Blocks can't modify its policy), so its policy
  must already grant the deploying principal `kms:CreateGrant` + `kms:DescribeKey`
  (RDS uses a grant to encrypt the storage volume) and grant `kms:Decrypt` to the
  principal that reads the credentials secret over the Data API. The key must be in
  the **same account and region** as the cluster.
- **Automated backups** — on by default, retained **15 days**, which is also the
  point-in-time-recovery window. Controlled by the single `pointInTimeRecovery`
  option (mirrors every other Blocks block): `true` enables the 15-day window,
  `{ retentionDays: n }` pins a 1–35-day window, and `false` clamps to the 1-day
  minimum (Aurora cannot turn automated backups off). When omitted it follows the
  stack-wide `defaults.pointInTimeRecovery` (on under `production`, off under
  `sandbox` — which lands on the 1-day minimum).
- **CloudWatch log export** — the PostgreSQL engine log is exported to CloudWatch
  Logs. Log-group retention follows the stack-wide `defaults.logRetention` when
  set; otherwise it uses the account default.
- **VPC** — Private subnets (isolated, no NAT)
- **RDS Proxy** — Connection pooling
- **Secrets Manager** — Auto-generated credentials. Automatic rotation is not yet
  wired up (a rotation Lambda in the cluster VPC is a planned follow-up); the
  secret is encrypted with your `storageEncryptionKeyArn` when one is supplied.
- **Migration Lambda** — Runs `.sql` files on deploy via CustomResource
- **IAM** — `rds-data:*` and `secretsmanager:GetSecretValue` granted to the app Lambda

> **Access model:** the database is reached exclusively over the RDS Data API
> (HTTPS + Secrets Manager credentials), never a raw Postgres socket. Database-level
> IAM authentication (`iamAuthentication`) is therefore intentionally left off — it
> does not apply to the Data API access path.
>
> **Enabling encryption on an existing unencrypted cluster requires a
> replacement — and a replacement is destructive.** RDS cannot encrypt an
> already-provisioned unencrypted cluster in place, so turning storage encryption
> on (or changing the KMS key) makes CloudFormation create a **new, empty**
> encrypted cluster and repoint the stack at it. There is **no in-place path**.
> What happens to the old cluster and its data depends on the removal policy:
> - **Production (RETAIN):** the old cluster is left behind, orphaned and no
>   longer referenced by the stack. The app comes back pointed at the new **empty**
>   cluster. The migration CustomResource does **not** re-run on a cluster swap —
>   its only CloudFormation properties are the service token and the migrations
>   hash, and neither changes when the cluster is replaced, so CloudFormation never
>   invokes it. The replacement cluster therefore comes up with **no schema**;
>   migrations run only when a migration file changes (which changes the migrations
>   hash). Your data still exists on the orphaned cluster but is not restored.
> - **Sandbox (DESTROY):** the old cluster and all of its data are **deleted**.
> - **Snapshot (`removalPolicy: 'snapshot'`):** the old cluster is snapshotted as
>   it is replaced. Under production's `deletionProtection: true`, the follow-up
>   delete of the old cluster may fail and leave it in place; this cleanup path is
>   unverified on a real deploy.
>
> The only safe route is to carry the data across yourself: **snapshot** the
> existing cluster, **restore** that snapshot into a new cluster with encryption
> enabled, then cut over to it. Review the CloudFormation diff and take a snapshot
> before deploying this change to any cluster whose data you need. Adding or
> changing the KMS key also replaces the cluster's generated credentials secret (a
> new logical id, hence a new generated password), so record the existing
> credentials — or reset the master password on the old cluster — if you still
> need access to the orphaned cluster.

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
  /**
   * ARN of a customer-managed KMS key for the cluster's storage-at-rest encryption
   * (also encrypts the auto-generated credentials secret). Supplying it turns
   * storage encryption on regardless of the `@aws-blocks/bb-data:encryptStorageByDefault`
   * context flag. When omitted, encryption follows that flag — on with the
   * account's AWS-managed `aws/rds` key when set, otherwise left unset. The key is
   * imported, so its policy must already grant the deploying principal
   * `kms:CreateGrant` + `kms:DescribeKey` and grant `kms:Decrypt` to the principal
   * reading the credentials secret; it must be in the same account + region.
   */
  storageEncryptionKeyArn?: string;
  /**
   * Automated-backup retention, which is also the point-in-time-recovery (PITR)
   * window. `true` enables the 15-day window; `{ retentionDays: n }` pins a
   * 1–35-day window; `false` clamps to the 1-day minimum (Aurora cannot disable
   * automated backups). When omitted, follows `defaults.pointInTimeRecovery`.
   */
  pointInTimeRecovery?: boolean | { retentionDays: number };
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


