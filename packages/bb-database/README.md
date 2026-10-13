# @aws-blocks/bb-database

`Database` is a PostgreSQL schema on an Aurora DSQL cluster that the block owns or shares with other blocks. Query it with the `sql` tag; migration files are ordinary PostgreSQL, rewritten into steps DSQL accepts. The query code is the same whichever cluster a block runs on.

```sh
npm install @aws-blocks/bb-database
```

**When to use:** relational data, joins, foreign keys, views, and multi-statement transactions, on a cluster that creates in seconds, costs nothing when idle, and needs no VPC.

**When not to use:** key/value lookups (use `KVStore`) or records with secondary indexes (use `DistributedTable`); both have no cluster to manage. Triggers, PL/pgSQL, extensions, Row Level Security on raw SQL, or transactions over 3,000 rows need all of PostgreSQL: a `provisioned` cluster (Aurora Serverless v2) is planned for this block and not yet available.

This is a preview. `@aws-blocks/bb-data` and `@aws-blocks/bb-distributed-data` are unchanged, and the umbrella package `@aws-blocks/blocks` still exports `bb-data`'s `Database`; import this block from `@aws-blocks/bb-database`. Internals and local-versus-AWS differences are in [DESIGN.md](./DESIGN.md).

## Quick start

```ts
import { Database, DatabaseCluster, sql } from '@aws-blocks/bb-database';

// 1. Default. The block owns an Aurora DSQL cluster.
const db = new Database(scope, 'db');

// 2. Several blocks on one cluster. Each gets its own schema.
const shared = new DatabaseCluster(scope, 'shared', { type: 'distributed' });
const users = new Database(scope, 'users', { cluster: shared });
const orders = new Database(scope, 'orders', { cluster: shared });
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

The cluster category:

| `type` | Service | Trade-off |
|---|---|---|
| `distributed` | Aurora DSQL | Scales to zero, no VPC, optimistic concurrency. Most of PostgreSQL: foreign keys, views, sequences, JSONB. No triggers, PL/pgSQL, extensions, or Row Level Security; 3,000 rows and 10 MiB per transaction |

`type` is required so that the planned `provisioned` category (Aurora Serverless v2, all of PostgreSQL) adds a value without changing this line.

## Options

An option goes on the cluster if every block on that cluster must share it, and on the block otherwise.

Cluster options:

| Option | Rule |
|---|---|
| `type` | Required. `'distributed'`. |
| `removalPolicy` | `retain` or `destroy`. When omitted: production clusters retain with deletion protection on, sandbox clusters are destroyed with the stack. Most apps never set this. |

Block options:

| Option | Rule |
|---|---|
| `cluster` | A `DatabaseCluster`. Omit it and the block owns a `distributed` cluster. |
| `migrationsPath` | Defaults to `./aws-blocks/migrations/{id}`, relative to the project root. The default directory may be missing; an explicit path must exist. |
| `schemaName` | `public` when the block owns its cluster, otherwise the block id. Two blocks on one cluster cannot share a schema. |
| `removalPolicy` | Only when `cluster` is omitted. With a shared cluster, set it on the `DatabaseCluster`. |
| `logger` | Per block. |

`Database` and `DatabaseCluster` ids are unique per app; a second block with the same id is an error at construction.

## What the compiler checks

`Database<K>` carries the kind of cluster it runs on, inferred from the constructor, and `db.cluster` is `{ kind, id }` at runtime:

```ts
const a = new Database(scope, 'a');                      // Database<'distributed'>, cluster { kind: 'distributed', id: 'default' }
const b = new Database(scope, 'b', { cluster: shared }); // Database<'distributed'>, cluster { kind: 'distributed', id: shared.fullId }
```

Cluster options are narrowed by `type`, so an option that belongs to another category is a compile error. With one category today, every block has the same methods; when `provisioned` arrives, methods a kind lacks will be compile errors on that kind.

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

- runs each DDL statement on its own and groups the DML statements between them into transactions;
- turns `CREATE INDEX` into `CREATE INDEX ASYNC` and waits for the index job;
- adds `NOT VALID` to `ALTER TABLE … ADD CONSTRAINT … CHECK` and `… FOREIGN KEY`, then validates the constraint with `ALTER TABLE ASYNC … VALIDATE CONSTRAINT` and waits for that job (a `REFERENCES` inside `CREATE TABLE` runs as written);
- turns `SERIAL`, `BIGSERIAL` and `SMALLSERIAL`, and identity columns on smaller integer types, into `BIGINT GENERATED … AS IDENTITY (CACHE 65536)`, and gives `CREATE SEQUENCE` the same type and cache when they are missing (DSQL sequences are `bigint` and need an explicit cache of 1 or at least 65536);
- rejects statements DSQL cannot run, such as `CREATE TRIGGER`, `CREATE EXTENSION`, `CREATE POLICY`, `TRUNCATE`, `ADD COLUMN … DEFAULT`, `SET NOT NULL` on an existing column, `ADD CONSTRAINT … UNIQUE (…)`, dropping a primary-key column, or an unnamed `ADD CHECK` / `ADD FOREIGN KEY`. The error names the file and the DSQL documentation page for the rule.

To see the steps without running them:

```sh
npx bb-database migrate --explain ./aws-blocks/migrations/db
```

The output also lists every foreign key and its referential action, so a switch to `ON DELETE CASCADE` shows up in review. On DSQL the rows a cascade deletes count toward the 3,000-row transaction limit, and a delete that fans out past it fails whole; prefer `NO ACTION` or `RESTRICT` for unbounded parent-child relationships.

Locally, a block applies its pending migrations before its first query. At deploy, each cluster has one pair of migration Lambdas and each block one CloudFormation custom resource; blocks on one cluster migrate one at a time, and every app function waits for the migrations of the blocks it uses, so new code never runs against the old schema. An index build or constraint validation is a DSQL job; the custom resource polls it every 30 seconds for up to two hours. Applied files are recorded in a `_migrations` table in the block's schema. If a file fails partway, the error names the failed step and the file is not recorded. Fix the cause and deploy again; the runner resumes at that step.

## Local mode

`npm run dev` needs no AWS account. Each cluster is one PGlite (PostgreSQL compiled to WebAssembly) under `.bb-data/`, with one schema per block, as on AWS.

A `distributed` cluster adds DSQL's rules locally. Unsupported SQL fails on your machine instead of in production; DDL outside a migration is refused because the deployed app role can only run DML; and a transaction that changes more than 3,000 rows (cascades included) or 10 MiB fails and rolls back, as it does on DSQL.

| | Owned default | `DatabaseCluster` |
|---|---|---|
| Engine | PGlite with DSQL rules | One PGlite per cluster, one schema per block, DSQL rules |
| Data | `.bb-data/{fullId}/` | `.bb-data/{clusterFullId}/` |
| Migrations | Before the block's first query | Same, per block, into its schema |

`db.simulateConflict()` makes the next commit fail with `SerializationFailure`, so you can test retry logic without a deployed DSQL cluster.

## The binding rule

A `Database` is bound to one cluster, by id and type, at its first deploy. A deploy that would change either stops:

```
Deploy stopped: Database 'app-orders' is bound to its default cluster (distributed) and cannot move to 'app-shared' (distributed).
A Database keeps its cluster for life. To change clusters: add a new Database on 'app-shared', copy the data, switch your handlers, then remove 'orders'.
Data on the default cluster is retained (removal policy: retain).
```

Production has no override. Sandbox deploys skip the check, since a sandbox stack is destroyed anyway. The dev server keeps it with a marker file at `.bb-data/{fullId}/binding.json`; delete `.bb-data` to reset it.

The guard runs before `cdk deploy` in production. It compares the bindings recorded in the stack's metadata with the deployed template. It also builds a change set and stops if the deploy would remove or replace a DSQL or Aurora cluster, which catches a renamed `Database` or `DatabaseCluster` id. Deleting a `Database` block is allowed: its cluster, or its schema on a shared cluster, stays under the removal policy. Deleting a block whose cluster has `removalPolicy: 'destroy'` in production is a stop, because that deploy would delete the data; deploy once with `retain` first.

**To move a block's data:**

1. Add a new `Database` with a new id on the target cluster, give it the same migrations, and deploy.
2. Copy each table from the old block's schema into the new one. On the same cluster, run `INSERT INTO new_schema.t SELECT * FROM old_schema.t`. Across clusters, export with `\copy old_schema.t TO 't.csv' CSV` and load with `\copy new_schema.t FROM 't.csv' CSV`. A `distributed` target accepts at most 3,000 rows per transaction, so load large tables in chunks of that size. Load parents before children, and end with a row-count check: an import that ignores constraint errors leaves orphans behind.
3. Check row counts on both sides.
4. Switch your handlers to the new block and deploy.
5. Remove the old block and deploy. Its data stays until you drop the schema or the cluster.

## Errors

Query and transaction failures carry a `DatabaseErrors` name. Match them with `isBlocksError(e, DatabaseErrors.X)` on the server or the client. Setup mistakes (a duplicate id, a missing `migrationsPath`), local DSQL rule failures (`DsqlValidationError`) and migration failures (`MigrationFailedException`) have their own names; fix those rather than catch them.

| Error | When | Retried automatically |
|---|---|---|
| `QueryFailed` | Any other SQL error, including a foreign-key or check violation | No |
| `ConnectionFailed` | Endpoint or network failure | No |
| `TransactionFailed` | The callback threw, or the commit failed for a reason other than a conflict | No |
| `UniqueConstraintViolation` | SQLSTATE `23505` (HTTP 409) | No |
| `SerializationFailure` | SQLSTATE `40001` at commit (HTTP 409, retriable) | A single `query` or `execute` outside a transaction: three times, at 50, 100 and 200 ms. A `transaction()` callback: only with `retryOnConflict: true` |
| `TransactionRowLimitExceeded` | More than 3,000 rows changed (cascades included) or more than 10 MiB written in one transaction, locally and on DSQL (SQLSTATE `54000`) | No; split the work |

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

## CLI

| Command | What it does |
|---|---|
| `npx bb-database migrate --explain [dir]` | Prints the migration steps and the foreign keys they define |
| `npx bb-database predeploy --stage production --project-root .` | Runs the guard; `npm run deploy` calls it. The sandbox stage returns at once |
| `npx bb-database guard --stack <name> --template <cdk.out/…template.json>` | Runs the guard against one synthesized template |

## Access through the AWS SDK

`getSdkIdentifiers(db)` from `@aws-blocks/blocks` returns `{ clusterId, schemaName }`. In a deployed Lambda it also returns the cluster's `clusterEndpoint` and `region`. The app connects as a per-cluster database role that holds `SELECT`, `INSERT`, `UPDATE` and `DELETE` on the block's tables, `SELECT` on its views, and `USAGE` on its sequences; DDL needs the admin token, which only the migration Lambdas have.
