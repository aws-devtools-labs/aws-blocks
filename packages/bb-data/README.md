# @aws-blocks/bb-data

Full PostgreSQL database — provisions Aurora Serverless v2 by default, or connects to an existing PostgreSQL database (Supabase, Neon, etc.) via `fromExisting()`. Full relational modeling with foreign keys, transactions, Row Level Security, and a type-safe Kysely query builder.

**When to use:** Complex multi-table JOINs, ACID transactions, foreign key constraints, aggregations, Row Level Security, or connecting to an existing PostgreSQL database. Use when you need the full power of PostgreSQL.

**When NOT to use:** For simple key-value lookups, use `KVStore`. For NoSQL with secondary indexes, use `DistributedTable`. For serverless SQL without FK/RLS/triggers (multi-region, instant provisioning), use `DistributedDatabase`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick Start

```typescript
import { Database, sql } from '@aws-blocks/blocks';

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

For type-safe queries without raw SQL. The adapter is not re-exported by
`@aws-blocks/blocks`: add `@aws-blocks/bb-data` to your dependencies to use it.

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

## Live Sync (local-first reads)

Stream rows to the browser and keep them in sync. The client holds a local copy of
the rows that match a **shape** (a table, a row filter, and optional columns) and
applies inserts, updates, and deletes as they happen. Reads are local and
synchronous, so they never wait on the network.

```typescript
import { ApiNamespace, Database, sql } from '@aws-blocks/blocks';

const db = new Database(scope, 'main', {
  migrationsPath: './aws-blocks/migrations',
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

| `Shape<T>` member | Description |
|---|---|
| `rows` | Current rows, in arrival order (not sorted: sort them to display). Replaced, not mutated, on each change. |
| `get(key)` | Row by primary key, or `undefined`. Local and synchronous. |
| `ready` | Resolves when the initial rows have arrived. Rejects if the shape cannot sync. |
| `isUpToDate` | `true` once the local copy has caught up. |
| `subscribe(listener)` | Call `listener(rows)` after each change. Returns an unsubscribe function. |
| `getSnapshot()` | The current `rows` array (for `useSyncExternalStore`). |
| `requestSnapshot(query)` | `'changes_only'` shapes: load the rows that match `query`; they stay live. Resolves with the loaded rows, in the query's order. |
| `close()` | Stop syncing. |

`db.shape()` options: `table` (must be in `sync.tables`), `where` (an `sql` tagged
template; values are bound parameters; may use subqueries), `columns` (must include
the key), `key` (primary-key column, default `'id'`), `ttlSeconds` (default 3600),
`mode` (`'full'` or `'changes_only'`), `queryableColumns`, and `columnMapping`.
The row type `T` uses the field names the client sees: with `columnMapping: 'snakeCamel'`,
declare `boardId`, not `board_id`.

Syncing starts on the first `ready` or `subscribe()`.

**Your own writes.** An API call that writes to a synced table resolves only after
the open shapes on that table have the write, so code after `await api.addTodo(...)`
sees the new row in `shape.rows`. The database reads the write's transaction id
before commit and sends it with the response; the client waits until each open
shape on the written table has that transaction: the transaction appears in its
changes or in a snapshot it received, or (for a shape the write doesn't touch) the
shape is caught up past it. The
wait is capped at 1 second: if no open shape contains the write, the call resolves
then. Writes through `db.query()`, `db.execute()`, and `db.transaction()` (every
`tx.execute()` in it) are covered; writes through `db.crud()` and `db.withRLS()` are
not, and reach shapes through the stream as usual. You do not need to do anything
in the API method or on the client.

**React.** `useShape` opens a shape, re-renders on every change, and closes it when
its dependencies change or the component unmounts:

```tsx
import { useShape } from '@aws-blocks/blocks/react';

const { rows, shape, isLoading, error } = useShape(() => api.boardCards(boardId), [boardId]);
```

| `useShape` result | Type | Description |
|---|---|---|
| `rows` | `readonly T[]` | The current rows, in arrival order. Empty until the shape has loaded. |
| `shape` | `Shape<T> \| null` | The open shape, for `get()` and `requestSnapshot()`. `null` until the API call returns. |
| `isLoading` | `boolean` | `true` until the initial rows have arrived. |
| `error` | `Error \| null` | The error from the API call (for example a 401 from `requireAuth`) or from the initial sync. |

`useShape` calls the API method once per change of `deps`. An API method that calls
`requireAuth` fails with a 401 for a signed-out user, so render the component that
calls `useShape` only when the user is signed in, and give it a `key` per user so
that it opens a new shape after a different user signs in.

**Filters that read other tables.** A `where` may use subqueries. Rows move in and out
of the shape when the other table changes, not only when the row itself does. Every
table the filter reads must be in `sync.tables`.

Every table in `sync.tables` needs a single-column primary key, also a table that
only a subquery reads. Give a join table a surrogate key:

```sql
-- migrations/001_create_members.sql
CREATE TABLE members (
  id TEXT PRIMARY KEY,           -- for example `${boardId}:${userId}`
  board_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  UNIQUE (board_id, user_id)
);
```

```typescript
const db = new Database(scope, 'main', {
  migrationsPath: './aws-blocks/migrations',
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

In React:

```tsx
function Feed({ channelId }: { channelId: string }) {
  const { rows, shape } = useShape(() => api.messages(channelId), [channelId]);
  const [done, setDone] = useState(false);
  const newest = [...rows].sort((a, b) => b.sent_at.localeCompare(a.sent_at));

  const loadMore = async () => {
    if (!shape) return;
    const oldest = newest.at(-1);
    const page = await shape.requestSnapshot({
      ...(oldest ? { where: { sent_at: { lt: oldest.sent_at } } } : {}),
      orderBy: [{ field: 'sent_at', direction: 'desc' }],
      limit: 50,
    });
    if (page.length < 50) setDone(true);
  };
  useEffect(() => { if (shape) void loadMore(); }, [shape]); // the first page

  return (
    <>
      {newest.map((m) => <p key={m.id}>{m.text}</p>)}
      {!done && <button onClick={loadMore}>Load more</button>}
    </>
  );
}
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
checks. Sign-out does not revoke a shape that is already open: reload the page on
sign-out.

**Value types.** Values arrive in their Postgres text form and are parsed for common
types: `int2`/`int4`/`float4`/`float8` become `number`, `int8` becomes `bigint`,
`bool` becomes `boolean`, and `json`/`jsonb` become parsed JSON. Other types
(`numeric`, `timestamptz`, `uuid`, …) arrive as `string`. Declare `T` to match.

Timestamps arrive as Postgres text, not ISO 8601: `timestamptz` as
`2026-10-05 08:08:10.572+00` (with the offset of the session time zone: UTC on AWS,
your machine's zone in local dev) and `timestamp` as `2026-10-05 08:08:10.572`.
Pass them back unchanged as snapshot-query values (`{ lt: row.sent_at }`): the
database compares them as timestamps. String order is time order only when all
values have the same offset, and some browsers do not parse this form with
`new Date()`. To sort or do date math on the client, add a numeric column, for
example `created_ms double precision DEFAULT (extract(epoch from now()) * 1000)`,
which arrives as a `number`.

**Requirements and limits.**
- Each table in `sync.tables` needs a single-column primary key, also a table that
  only a subquery reads.
- Not supported with `fromExisting()` yet.
- Not supported with `minCapacity: 0` (synth fails). Aurora does not auto-pause while
  logical replication is enabled, so the cluster always runs at least `minCapacity`
  ACUs. The default `minCapacity` is 0.5, and `BlocksPresets` do not change it.
- If you add `sync` to a cluster that is already deployed, reboot its writer once
  after the deploy. `rds.logical_replication` is a static parameter. A new cluster
  picks it up when it is created.
- In a sandbox, changing `sync.electric` (version, image, or sizing) on a deployed
  stack replaces the Electric task definition, which sandbox deploys (CloudFormation
  Express Mode, no rollback) cannot do. Run `npm run sandbox:destroy` and deploy
  again. Production deploys are not affected.

**How it runs.**
- **Local dev:** an in-process emulator of the [Electric](https://electric.ax) HTTP
  shape protocol, on top of PGlite. Row triggers capture changes. No extra setup.
- **AWS:** logical replication on the Aurora cluster, and the Electric sync service on
  Fargate. The browser calls the shape endpoint on your API. The endpoint checks the
  token and forwards the request to Electric through an IAM-authorized HTTP API.
  Electric connects as a dedicated `electric` role that can read only the synced
  tables. See [DESIGN.md](./DESIGN.md#live-sync).

## Connecting to an Existing Database

```typescript
import { Database, fromExisting } from '@aws-blocks/blocks';

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
import { DatabaseErrors, isBlocksError } from '@aws-blocks/blocks';

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

`db.shape()` throws `DatabaseErrors.ShapeInvalid` (HTTP 400) when sync is not
enabled, the table is not in `sync.tables`, a column or key name is invalid, or a
filter parameter has an unsupported type:

```typescript
try {
  return await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${userId}` });
} catch (e: unknown) {
  if (isBlocksError(e, DatabaseErrors.ShapeInvalid)) {
    // Fix the shape definition; this is a programming error, not a runtime condition
  }
  throw e;
}
```

## What It Provisions (AWS)

- **Aurora Serverless v2** — PostgreSQL-compatible, scales 0.5-128 ACUs
- **VPC** — Private subnets (isolated, no NAT)
- **RDS Proxy** — Connection pooling
- **Secrets Manager** — Auto-generated credentials, auto-rotated
- **Migration Lambda** — Runs `.sql` files on deploy via CustomResource
- **IAM** — `rds-data:*` and `secretsmanager:GetSecretValue` granted to the app Lambda

With `sync`, also:

- **Cluster parameter group** — `rds.logical_replication = 1`
- **Electric sync service** — one Arm Fargate task, registered in Cloud Map
- **Electric image build** — a CodeBuild project builds the pinned Electric release from its GitHub source tag into a stack-owned ECR repository. It runs on the first deploy and when the version changes (about 5 minutes), and uses base images from the ECR Public mirror, so it needs no registry credentials and no local Docker. Set `sync.electric.image` to run a prebuilt image instead.
- **Networking** — with the default standalone VPC, a small VPC for Electric (public subnets, no NAT) peered to the database VPC; with `defaults.vpc`, Electric runs in that VPC's private-with-egress subnets. The cluster accepts port 5432 only from Electric.
- **HTTP API** — IAM-authorized, reached over a VPC link; only the app Lambda can call it
- **Secrets Manager** — the `electric` role password and the Electric API secret
- **Setup custom resource** — creates the `electric` role, grants `SELECT` on the synced tables, sets `REPLICA IDENTITY FULL`, and creates the `electric_publication_default` publication

## Local Development

- **Engine:** PGlite (WASM PostgreSQL) — full Postgres compatibility
- **Storage:** `.bb-data/{fullId}/` — persists across restarts, wipe with `rm -rf .bb-data`
- **Migrations:** Run automatically on first query

## Configuration

```typescript
interface DatabaseOptions {
  /** Minimum Aurora capacity units. 0 lets the cluster auto-pause (not with `sync`). @default 0.5 */
  minCapacity?: number;
  /** Maximum Aurora capacity units. @default 2 */
  maxCapacity?: number;
  /** Path to directory containing numbered .sql migration files. */
  migrationsPath?: string;
  /** Connect to an existing database instead of provisioning one. */
  connection?: ExternalDatabaseRef;
  /** Schema metadata for crud() support. */
  schema?: TableSchema;
  /** Aurora PostgreSQL engine version, e.g. '16.13'. Override the Aurora engine version. @default '16.13' */
  postgresVersion?: string;
  /** Tables `db.shape()` may stream, plus Electric sizing. See "Live Sync" above. */
  sync?: { tables: string[]; electric?: { version?: string; image?: string; cpu?: number; memoryMiB?: number } };
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
imports it when a `Database` has `sync`.

## Performance

- **Query latency:** 10-50ms (warm), ~500ms cold start from 0 ACUs
- **Throughput:** Thousands of concurrent connections via RDS Proxy
- **Storage:** Up to 128 TiB, auto-scales in 10 GiB increments
- **Cost:** ~$0.12/ACU-hour + ~$0.10/GB-month storage
- **Durability:** 6 copies across 3 AZs, 99.99% availability


