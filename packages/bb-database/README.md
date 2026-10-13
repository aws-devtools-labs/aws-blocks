# @aws-blocks/bb-database

`Database` gives an AWS Blocks backend a PostgreSQL schema to query with the `sql` tag. By default the block owns an Aurora DSQL cluster. It can also share an Aurora DSQL or Aurora Serverless v2 cluster with other blocks, or use a PostgreSQL you already have. The query code is the same in every case.

```sh
npm install @aws-blocks/bb-database
```

**When to use:** relational data, joins, multi-statement transactions, or an existing PostgreSQL database. Start on the default cluster and move to `type: 'provisioned'` when you need foreign keys, triggers, views, extensions, or Row Level Security.

**When not to use:** key/value lookups (use `KVStore`) or records with secondary indexes (use `DistributedTable`). Both cost nothing at rest and have no cluster to manage.

Internals and local-versus-AWS differences are in [DESIGN.md](./DESIGN.md).

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
const supabase = DatabaseCluster.fromExisting({
  connectionString: process.env.DATABASE_URL ?? '',
  ssl: { ca: process.env.DATABASE_CA_CERT }, // your provider's CA (PEM)
});
const legacy = new Database(scope, 'legacy', { cluster: supabase, schemaName: 'public' });

// 5. DSQL, shared. Same shape as 2 with the other category.
const shared = new DatabaseCluster(scope, 'shared', { type: 'distributed' });
const events = new Database(scope, 'events', { cluster: shared });
```

Create tables in a migration file, not in a handler. On a `distributed` cluster the app's database role can only read and write rows, so `CREATE TABLE` at runtime fails, locally and on AWS. Put it in `./aws-blocks/migrations/{id}/001_init.sql` (see [Migrations](#migrations)):

```sql
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL);
```

Then, in a handler:

```ts
const user = await db.queryOne<{ id: string; email: string }>(sql`SELECT id, email FROM users WHERE id = ${id}`);

await db.transaction(async (tx) => {
  const row = await tx.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${id} FOR UPDATE`);
  if (!row) throw new Error('no such account');
  await tx.execute(sql`UPDATE accounts SET balance = ${row.balance - amount} WHERE id = ${id}`);
});
```

The two cluster categories:

| `type` | Service | Trade-off |
|---|---|---|
| `distributed` | Aurora DSQL | Scales to zero, no VPC, optimistic concurrency, a subset of PostgreSQL |
| `provisioned` | Aurora Serverless v2 | All of PostgreSQL, in a VPC, with a minimum capacity you pay for |

## Options

An option goes on the cluster if every block on that cluster must share it, and on the block otherwise.

Cluster options depend on `type`. An option outside its column is a compile error.

| Option | `distributed` | `provisioned` | `fromExisting()` |
|---|---|---|---|
| `type` | required | required | not present |
| `minCapacity`, `maxCapacity`, `postgresVersion`, `subnets`, `databaseName`, `storageEncryptionKeyArn`, `pointInTimeRecovery` | not allowed | optional | not allowed |
| `removalPolicy` | `retain` or `destroy` | `retain`, `destroy`, or `snapshot` | not present |
| `connectionString` and `ssl`, or `host`, `secretArn` and `database` | not allowed | not allowed | one of the two, required |

Block options:

| Option | Rule |
|---|---|
| `cluster` | A `DatabaseCluster` or the value of `fromExisting()`. Omit it and the block owns a `distributed` cluster. |
| `migrationsPath` | Defaults to `./aws-blocks/migrations/{id}`, relative to the project root. The default directory may be missing; an explicit path must exist. |
| `schemaName` | `public` when the block owns its cluster, otherwise the block id. Two blocks on one cluster cannot share a schema. |
| `removalPolicy` | Only when `cluster` is omitted. With a shared cluster, set it on the `DatabaseCluster`. |
| `schema`, `rlsPolicy` | Only on a `provisioned` or external cluster. |
| `logger` | Per block. |

Production clusters are retained with deletion protection on; sandbox clusters are destroyed with the stack. Most apps never set `removalPolicy`.

## What the compiler checks

`Database<K>` carries the kind of cluster it runs on, inferred from the constructor:

```ts
const a = new Database(scope, 'a');                        // Database<'distributed'>
const b = new Database(scope, 'b', { cluster: main });     // Database<'provisioned'>
const c = new Database(scope, 'c', { cluster: supabase }); // Database<'external'>

await b.withRLS({ userId });   // ok
await a.withRLS({ userId });   // compile error: not available on a 'distributed' cluster
```

If the cluster comes from a variable whose type is a union of kinds, the block is `Database<ClusterKind>` and has no `withRLS()` or `crud()`. The same check runs again at runtime, so a cast that hides the mistake from the compiler still fails on the dev server:

```
Not available on a 'distributed' cluster. Use type: 'provisioned' or DatabaseCluster.fromExisting().
```

## Migrations

Each block has one directory of ordinary PostgreSQL files, `./aws-blocks/migrations/{id}` unless `migrationsPath` says otherwise:

```
aws-blocks/migrations/
  db/
    001_users.sql
    002_users_email_index.sql
  orders/
    001_orders.sql
```

A rewriter turns the files into steps the cluster accepts. On a `distributed` cluster it:

- runs each DDL statement on its own and groups the statements between them into transactions;
- turns `CREATE INDEX` into `CREATE INDEX ASYNC` and waits for the index job;
- adds `NOT VALID` to `ALTER TABLE … ADD CONSTRAINT … CHECK`, then validates the constraint in a separate step;
- turns `SERIAL`, `BIGSERIAL` and `SMALLSERIAL` into identity columns with `CACHE 65536`;
- rejects statements DSQL cannot run, such as `CREATE POLICY`, `CREATE TRIGGER`, `CREATE EXTENSION`, `REFERENCES`, or `SET NOT NULL` on an existing column. The error names the file and the DSQL documentation page for the rule.

On a `provisioned` or external cluster the files run as written, so one set of files works on every kind. To see the steps without running them:

```sh
npx bb-database migrate --explain ./aws-blocks/migrations/db --target distributed
```

The output also lists every foreign key and its referential action. `--target` defaults to `distributed`.

Locally, a block applies its pending migrations before its first query. At deploy, each cluster has one migration Lambda and each block one CustomResource. Applied files are recorded in a `_migrations` table in the block's schema. If a file fails partway, the error names the failed step and the file is not recorded. Fix the cause and deploy again; the runner resumes at that step.

For a `fromExisting({ connectionString })` block, `npm run sandbox` and `npm run deploy` apply migrations from your machine before `cdk deploy`. The connection string comes from `BLOCKS_MIGRATE_URL` or any environment variable ending in `_DB_URL` or `_CONNECTION_STRING`. Set `DATABASE_CA_CERT` to your provider's CA so that connection is verified.

## Local mode

`npm run dev` needs no AWS account. Each cluster is one PGlite (PostgreSQL compiled to WebAssembly) under `.bb-data/`, with one schema per block, as on AWS.

A `distributed` cluster adds DSQL's checks locally. Unsupported SQL fails on your machine instead of in production, and DDL outside a migration is refused because the deployed app role can only run DML.

| | Owned default | `DatabaseCluster` | `fromExisting()` |
|---|---|---|---|
| Engine | PGlite with DSQL checks | One PGlite per cluster, one schema per block; DSQL checks when `distributed` | A `pg` connection to the external database. The `host` + `secretArn` form is not reachable locally. |
| Data | `.bb-data/{fullId}/` | `.bb-data/{clusterFullId}/` | The external database |
| Cluster options | Ignored | Ignored | `ssl` applies |
| Migrations | Before the block's first query | Same, per block, into its schema | Same, against the external database |

`db.simulateConflict()` makes the next commit fail with `SerializationFailure` on any kind of cluster, so you can test retry logic without a deployed DSQL cluster.

## The binding rule

A `Database` is bound to one cluster, by id and type, at its first deploy. A deploy that would change either stops:

```
Deploy stopped: Database 'app-orders' is bound to its default cluster (distributed) and cannot move to 'app-main' (provisioned).
A Database keeps its cluster for life. To change clusters: add a new Database on 'app-main', copy the data, switch your handlers, then remove 'orders'.
Data on the default cluster is retained (removal policy: retain).
```

Production has no override. Sandbox deploys skip the check, since a sandbox stack is destroyed anyway. The dev server keeps it with a marker file at `.bb-data/{fullId}/binding.json`; delete `.bb-data` to reset it.

The guard runs before `cdk deploy` in production. It compares the bindings recorded in the stack's metadata with the deployed template. It also builds a change set and stops if the deploy would remove or replace an Aurora or DSQL cluster. Deleting a `Database` block is allowed: its cluster, or its schema on a shared cluster, stays under the removal policy.

**To move a block's data:**

1. Add a new `Database` with a new id on the target cluster, give it the same migrations, and deploy.
2. Copy each table from the old block's schema into the new one. On the same cluster, run `INSERT INTO new_schema.t SELECT * FROM old_schema.t`. Across clusters, export with `\copy old_schema.t TO 't.csv' CSV` and load with `\copy new_schema.t FROM 't.csv' CSV`. A `distributed` target accepts at most 3,000 rows per transaction, so load large tables in chunks of that size.
3. Check row counts on both sides.
4. Switch your handlers to the new block and deploy.
5. Remove the old block and deploy. Its data stays until you drop the schema or the cluster.

## Errors

Query and transaction failures carry a `DatabaseErrors` name. Match them with `isBlocksError(e, DatabaseErrors.X)` on the server or the client. Setup mistakes (a duplicate id, a missing `migrationsPath`), local DSQL check failures (`DsqlValidationError`) and migration failures have their own names; fix those rather than catch them.

| Error | Kinds | When | Retried automatically |
|---|---|---|---|
| `QueryFailed` | all | Any other SQL error | No |
| `ConnectionFailed` | all | Endpoint, secret, or network failure | No |
| `TransactionFailed` | all | The callback threw, or the commit failed for a reason other than a conflict | No |
| `UniqueConstraintViolation` | all | SQLSTATE `23505` (HTTP 409) | No |
| `SerializationFailure` | all; mostly `distributed` | SQLSTATE `40001` at commit (HTTP 409, retriable) | A single `query` or `execute` outside a transaction: three times, at 50, 100 and 200 ms. A `transaction()` callback: only with `retryOnConflict: true` |
| `TransactionRowLimitExceeded` | `distributed` | More than 3,000 rows changed in one transaction. Only the local mock raises it; deployed DSQL reports `QueryFailed` for now | No; split the work |

DSQL's stale-schema-cache error (`OC001`) is retried once wherever it happens.

```ts
import { isBlocksError } from '@aws-blocks/core';
import { Database, DatabaseErrors, sql } from '@aws-blocks/bb-database';

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

The adapter connects on its first query, so creating it at module scope is safe during synth.

## Row Level Security and CRUD

These need a `provisioned` or external cluster. Inside an `ApiNamespace` method, with an auth block in scope:

```ts
const user = await auth.requireAuth(context);
const scoped = await users.withRLS({ userId: user.userId }); // SET LOCAL ROLE + request.jwt.claims
const mine = await scoped.query<{ id: string; title: string }>(sql`SELECT id, title FROM posts`);
```

`withRLS` switches to the `authenticated` role (or `anon`) for each query. A migration must create those roles and grant them to the connecting user with `GRANT authenticated TO CURRENT_USER`. It must also grant them access to the block's schema and tables.

`crud()` generates list, get, create, update and delete handlers that run through `withRLS()`. It needs table metadata, passed to the constructor as `schema`, in the format `bb-data`'s `db pull` generates. Calling `crud()` on a block without `schema` throws.

## CLI

| Command | What it does |
|---|---|
| `npx bb-database migrate --explain [dir] [--target distributed\|provisioned\|external]` | Prints the migration steps and the foreign keys they define |
| `npx bb-database migrate [dir] --url <conn> --schema <name>` | Applies a block's migrations to an external PostgreSQL |
| `npx bb-database predeploy --stage production --project-root .` | Runs the guard and then host-side migrations; `npm run deploy` calls it |
| `npx bb-database guard --stack <name> --template <cdk.out/…template.json>` | Runs the guard against one synthesized template |

## Access through the AWS SDK

`getSdkIdentifiers(db)` from `@aws-blocks/blocks` returns `{ clusterId, schemaName }`. In a deployed Lambda it also returns the cluster's connection details: `clusterEndpoint` and `region` for `distributed`, or `clusterArn`, `secretArn` and `databaseName` for `provisioned`. A `fromExisting()` block has no connection details here.
