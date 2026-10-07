# @aws-blocks/bb-database

One `Database` block for every PostgreSQL cluster kind. `DatabaseCluster` is part of this block, not a block of its own: it only exists to be passed as a `Database`'s `cluster`. Omit `cluster` and the block owns an Aurora DSQL cluster. Pass a `DatabaseCluster` to share a cluster between blocks, or `DatabaseCluster.fromExisting()` for a PostgreSQL you already have (Supabase, Neon, RDS). Everything after the constructor is the same: `query`, `queryOne`, `execute`, `transaction`, the `sql` tag, and a Kysely adapter.

**When to use:** Relational data, multi-table JOINs, transactions, or an existing PostgreSQL database. Start on the default cluster; move to `type: 'provisioned'` when you need foreign keys, triggers, views, extensions, or Row Level Security.

**When NOT to use:** For key/value lookups use `KVStore`; for records with secondary indexes use `DistributedTable`. Both cost nothing at rest and have no cluster to think about.

> Design, mock parity and the binding rule: [DESIGN.md](./DESIGN.md)

## Quick start

```ts
import { Database, DatabaseCluster, sql } from '@aws-blocks/bb-database';

// 1. Default. The block owns an Aurora DSQL cluster.
const db = new Database(scope, 'db');

// 2. Share a cluster. Pick a category, not a service.
const main = new DatabaseCluster(scope, 'main', { type: 'provisioned', minCapacity: 0.5 });
const users = new Database(scope, 'users', { cluster: main });

// 3. Several blocks on one cluster. Each gets its own schema.
const orders = new Database(scope, 'orders', { cluster: main });

// 4. A cluster you already have. Anything that speaks the PostgreSQL protocol.
const supabase = DatabaseCluster.fromExisting({ connectionString: process.env.DATABASE_URL!, ssl: { ca } });
const legacy = new Database(scope, 'legacy', { cluster: supabase, schemaName: 'public' });

// 5. DSQL, shared. Same shape as 2 with the other category.
const shared = new DatabaseCluster(scope, 'shared', { type: 'distributed' });
```

In a handler:

```ts
const user = await db.queryOne<{ id: string; email: string }>(sql`SELECT id, email FROM users WHERE id = ${id}`);

await db.transaction(async (tx) => {
  const row = await tx.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${id} FOR UPDATE`);
  if (!row) throw new Error('no such account');
  await tx.execute(sql`UPDATE accounts SET balance = ${row.balance - amount} WHERE id = ${id}`);
});
```

The two categories are `distributed` (Aurora DSQL: scales to zero, no VPC, optimistic concurrency, a subset of PostgreSQL) and `provisioned` (Aurora Serverless v2: capacity you pay for, a VPC, all of PostgreSQL).

## Options and where they go

An option goes on the cluster if it describes the server and on the block if it describes this block's data on that server. Anything that must be identical for every block on a cluster is a cluster option.

Cluster options, narrowed by `type` (an option outside its column is a compile error):

| Option | `distributed` | `provisioned` | `fromExisting()` |
|---|---|---|---|
| `type` | required | required | not present |
| `minCapacity`, `maxCapacity`, `postgresVersion`, `subnets`, `databaseName`, `storageEncryptionKeyArn`, `pointInTimeRecovery` | — | optional | — |
| `removalPolicy` | `retain` or `destroy` | `retain`, `destroy`, or `snapshot` | not present |
| `connectionString` and `ssl`, or `host`, `secretArn` and `database` | — | — | one of the two, required |

Block options:

| Option | Rule |
|---|---|
| `cluster` | A `DatabaseCluster` or the value of `fromExisting()`. Omitted means the block owns a `distributed` cluster. |
| `migrationsPath` | Defaults to `./aws-blocks/migrations/{id}`. One directory per block, always. A missing default directory is fine; an explicit path must exist. |
| `schemaName` | `public` when the block owns its cluster, otherwise the block id. Two blocks on one cluster with the same name is an error. |
| `removalPolicy` | Only when `cluster` is omitted; applies to the owned cluster. With `cluster` set it is a compile error. |
| `schema`, `rlsPolicy` | Only when the cluster is `provisioned` or external. |
| `logger` | Per block. |

Stage defaults: production clusters retain with deletion protection on, sandbox clusters destroy. Most apps never set `removalPolicy`.

## What the compiler enforces

`Database<K>` is generic over the kind of cluster it runs on, inferred from the constructor:

```ts
const a = new Database(scope, 'a');                       // Database<'distributed'>
const b = new Database(scope, 'b', { cluster: main });    // Database<'provisioned'>
const c = new Database(scope, 'c', { cluster: supabase }); // Database<'external'>

await b.withRLS({ userId });   // ok
await a.withRLS({ userId });   // compile error: not available on a 'distributed' cluster
```

A cluster held in a variable typed as a union lands on `Database<ClusterKind>`, on which `withRLS()` and `crud()` are unavailable. A dynamic choice gets the conservative surface, never a silent pass. At runtime every entry point checks `db.cluster.kind` as well, so the same wrong call is a dev-server error with the same message:

```
Not available on a 'distributed' cluster. Use type: 'provisioned' or DatabaseCluster.fromExisting().
```

## Migrations

One directory of ordinary PostgreSQL migration files per block, `./aws-blocks/migrations/{id}` unless `migrationsPath` says otherwise:

```
aws-blocks/migrations/
  db/
    001_users.sql
    002_users_email_index.sql
  orders/
    001_orders.sql
```

A rewriter turns the files into a plan the cluster accepts. On a `distributed` cluster:

- every DDL statement runs in its own transaction, DML in the file's transaction;
- `CREATE INDEX` becomes `CREATE INDEX ASYNC` followed by a wait on the job;
- `ALTER TABLE … ADD CONSTRAINT … CHECK` gets `NOT VALID` plus a `VALIDATE CONSTRAINT` step;
- `SERIAL`, `BIGSERIAL`, `SMALLSERIAL` become identity columns with `CACHE 65536`;
- a statement the cluster cannot run (`CREATE POLICY`, `CREATE TRIGGER`, `CREATE EXTENSION`, `REFERENCES`, `SET NOT NULL` on an existing column, …) is rejected at dev-server start with the file name and the DSQL doc page it was checked against.

On a `provisioned` or external cluster the same plan runs with the DSQL-only rewrites left out, so one set of files is portable between kinds.

```sh
npx bb-database migrate --explain ./aws-blocks/migrations/db --target distributed
```

prints the plan without running it and lists every foreign key together with its referential action.

Migrations run on the dev server at startup (first use), and at deploy from one migration Lambda per cluster, one CustomResource per block. Applied files are recorded in `_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMP)` in the block's schema. A migration that fails mid-plan is reported with the step that failed and is not recorded; fix the cause, deploy again, and the runner resumes at that step.

On `fromExisting({ connectionString })` the migrations run host-side before `cdk deploy` (`npm run sandbox` / `npm run deploy`), reading the connection string from `BLOCKS_MIGRATE_URL` or any `*_DB_URL` / `*_CONNECTION_STRING` environment variable, and locally on the dev server. Pin the provider's CA with `DATABASE_CA_CERT` so the host-side connection is verified.

## Local mode

`npm run dev` runs every block with no AWS account. Each cluster is one PGlite (WASM PostgreSQL) under `.bb-data/`, with one schema per block, exactly as on DSQL and Aurora. A `distributed` cluster adds the DSQL validation layer: unsupported SQL fails here, not in production, and DDL is refused on the app connection (deploy it through a migration, as the deployed app role can only run DML).

| | Owned default | `DatabaseCluster` | `fromExisting()` |
|---|---|---|---|
| Engine | PGlite with the DSQL validation layer | One PGlite per cluster, one schema per block; validation layer when `distributed` | A live `pg` connection to the external database |
| Data | `.bb-data/{fullId}/` | `.bb-data/{clusterFullId}/` | none; the external database is the data |
| Cluster options | ignored | ignored | `ssl` honoured |
| Migrations | dev server at startup, through the rewriter | same, per block, into its schema | host-side runner |

`db.simulateConflict()` makes the next commit raise `SerializationFailure` on every kind, so retry tests do not depend on which cluster is deployed.

## The binding rule

A `Database` is bound to one cluster, by id and type, at its first deploy. Any deploy that would change either stops:

```
Deploy stopped: Database 'app-orders' is bound to its default cluster (distributed) and cannot move to 'app-main' (provisioned).
A Database keeps its cluster for life. To change clusters: add a new Database on 'app-main', copy the data, switch your handlers, then remove 'orders'.
Data on the default cluster is retained (removal policy: retain).
```

There is no override in production. The sandbox stage skips the check (it uses the destroy policy, so iterating on `type` in a throwaway stack never meets the guard). The dev server keeps the check through a marker in `.bb-data/{fullId}/binding.json`; deleting `.bb-data` is the reset.

The CDK layer writes the record into stack metadata under `aws-blocks:bindings`. Before `cdk deploy` in production the guard fetches the deployed template, diffs the record, then creates and deletes a change set, stopping on any `Remove` or `Replace` of an `AWS::RDS::DBCluster` or `AWS::DSQL::Cluster`. Deleting a `Database` block is not a stop: its cluster, or its schema on a shared cluster, is retained under the removal policy.

**To move a block's data:**

1. Add a new `Database` with a new id on the target cluster, and deploy.
2. Copy: `pg_dump --schema=<old schema> --data-only | psql` into the new block's schema (or `COPY … TO STDOUT` / `COPY … FROM STDIN` per table on DSQL).
3. Check row counts on both sides.
4. Switch your handlers to the new block, deploy.
5. Remove the old block, deploy. Its data stays until you drop the schema or the cluster.

## Errors

Every error carries a `DatabaseErrors` name; match with `isBlocksError(e, DatabaseErrors.X)` on either side of the wire.

| Error | Kinds | When | Retry policy |
|---|---|---|---|
| `QueryFailed` | all | any SQL error | none |
| `ConnectionFailed` | `provisioned`, external | endpoint, secret, or network failure | none |
| `TransactionFailed` | all | the callback threw, or commit failed for a reason other than a conflict | none |
| `UniqueConstraintViolation` | all | SQLSTATE `23505` (HTTP 409) | none |
| `SerializationFailure` | all; `distributed` in practice | SQLSTATE `40001` at commit (HTTP 409, retriable) | a single auto-commit `query` or `execute` is retried three times at 50, 100 and 200 ms; a `transaction()` callback is re-run only with `retryOnConflict: true`; DSQL's `OC001` stale schema cache is retried anywhere |
| `TransactionRowLimitExceeded` | `distributed` | more than 3,000 rows mutated in one transaction | none; batch the work |

```ts
import { Database, DatabaseErrors, sql } from '@aws-blocks/bb-database';
import { isBlocksError } from '@aws-blocks/core';

try {
  await db.execute(sql`INSERT INTO users (email) VALUES (${email})`);
} catch (err) {
  if (isBlocksError(err, DatabaseErrors.UniqueConstraintViolation)) return { conflict: 'email already registered' };
  throw err;
}

// A read-modify-write on a distributed cluster. The callback has no side effects, so re-running it is safe.
await db.transaction(async (tx) => {
  const row = await tx.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${id} FOR UPDATE`);
  await tx.execute(sql`UPDATE accounts SET balance = ${(row?.balance ?? 0) - amount} WHERE id = ${id}`);
}, { retryOnConflict: true, maxRetries: 3 });
```

## Kysely query builder

```ts
import { createKyselyAdapter } from '@aws-blocks/bb-database';

interface Schema {
  users: { id: string; email: string };
}
const kysely = createKyselyAdapter<Schema>(db);
const users = await kysely.selectFrom('users').selectAll().where('email', 'like', '%@example.com').execute();
```

The adapter resolves the engine lazily on the first query, so creating it at module scope is safe during synth.

## Row Level Security and CRUD

Available on `Database<'provisioned' | 'external'>`:

```ts
const scoped = await users.withRLS({ userId: user.userId });   // SET LOCAL ROLE + request.jwt.claims
const mine = await scoped.query<Post>(sql`SELECT * FROM posts`);

const crud = users.crud({ tables: ['posts'], auth: async () => ({ userId: (await auth.requireAuth(context)).userId }) });
```

`withRLS` issues `SET LOCAL ROLE authenticated` (or `anon`), so a migration must create those roles and grant them to the connecting user (`GRANT authenticated TO CURRENT_USER`). `crud()` needs `schema` metadata in the constructor.

## CLI

| Command | Purpose |
|---|---|
| `npx bb-database migrate --explain [dir] [--target distributed\|provisioned\|external]` | print the plan, list foreign keys and their referential actions |
| `npx bb-database migrate [dir] --url <conn> --schema <name>` | apply a block's migrations to an external PostgreSQL |
| `npx bb-database predeploy --stage production --project-root .` | what `npm run deploy` runs: the guard, then host-side migrations |
| `npx bb-database guard --stack <name> --template <cdk.out/…template.json>` | run the guard against one template |

## Access through the AWS SDK

`getSdkIdentifiers(db)` returns `{ clusterId, schemaName }` plus the cluster's connection identifiers: `clusterEndpoint` and `region` on a `distributed` cluster, `clusterArn`, `secretArn` and `databaseName` on a `provisioned` one.
