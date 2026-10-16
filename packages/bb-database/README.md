# @aws-blocks/bb-database

`Database` is a PostgreSQL schema on an Aurora DSQL cluster that the block owns or shares with other blocks. Query it with the `sql` tag; migration files are ordinary PostgreSQL, rewritten into steps DSQL accepts. The query code is the same whichever cluster a block runs on.

```sh
npm install @aws-blocks/bb-database
```

**When to use:** relational data, joins, foreign keys, views, and multi-statement transactions, on a cluster that creates in seconds, costs nothing when idle, and needs no VPC.

**When not to use:** key/value lookups (use `KVStore`) or records with secondary indexes (use `DistributedTable`); both have no cluster to manage. Triggers, PL/pgSQL, extensions, Row Level Security on raw SQL, or transactions over 3,000 rows need all of PostgreSQL: a `provisioned` cluster (Aurora Serverless v2) is planned for this block and not yet available.

This is a preview. `@aws-blocks/bb-data` and `@aws-blocks/bb-distributed-data` are unchanged, and the umbrella package `@aws-blocks/blocks` still exports `bb-data`'s `Database`; import this block from `@aws-blocks/bb-database`. Internals and local-versus-AWS differences are in [DESIGN.md](./DESIGN.md).

## Quick start

Define the blocks in `aws-blocks/index.ts`:

```ts
import { Database, DatabaseCluster, sql } from '@aws-blocks/bb-database';

// 1. Default. The block owns an Aurora DSQL cluster.
const shop = new Database(scope, 'shop');

// 2. Several blocks on one cluster. Each gets its own schema.
const shared = new DatabaseCluster(scope, 'shared', { type: 'distributed' });
const audit = new Database(scope, 'audit', { cluster: shared });
const search = new Database(scope, 'search', { cluster: shared });
```

Create tables in a migration file, not in a handler. On a `distributed` cluster the app's database role can only read and write rows, so `CREATE TABLE` at runtime fails, locally and on AWS. Put it in `aws-blocks/migrations/shop/001_init.sql` (see [Migrations](#migrations)):

```sql
CREATE TABLE customers (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL);
CREATE TABLE orders (id SERIAL PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), total INTEGER NOT NULL);
```

Then query from an `ApiNamespace` method:

```ts
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async signUp(email: string) {
    const id = crypto.randomUUID();
    await shop.execute(sql`INSERT INTO customers (id, email) VALUES (${id}, ${email})`);
    return { id };
  },

  async placeOrder(customerId: string, total: number) {
    return shop.transaction(async (tx) => {
      const customer = await tx.queryOne<{ id: string }>(sql`SELECT id FROM customers WHERE id = ${customerId}`);
      if (!customer) throw new Error('no such customer');
      await tx.execute(sql`INSERT INTO orders (customer_id, total) VALUES (${customerId}, ${total})`);
      return tx.queryOne<{ n: number }>(sql`SELECT count(*)::int AS n FROM orders WHERE customer_id = ${customerId}`);
    });
  },
}));
```

`npm run dev` runs this with no AWS account; `npm run deploy` creates the cluster and applies the migration before the new code goes live.

## API

```ts
const db = new Database(scope, id, options?);
const cluster = new DatabaseCluster(scope, id, { type: 'distributed', removalPolicy? });
```

| Method | Returns | Description |
|---|---|---|
| `query<T>(sql)` | `Promise<T[]>` | Run a query and return every row. Empty array when nothing matches. |
| `queryOne<T>(sql)` | `Promise<T \| null>` | Run a query and return the first row, or `null` when nothing matches. |
| `execute(sql)` | `Promise<{ rowCount: number }>` | Run an `INSERT`, `UPDATE`, or `DELETE` and return the rows affected. |
| `transaction(fn, options?)` | `Promise<T>` | Run `fn(tx)` in one transaction; `tx` has the three methods above. Commits when `fn` resolves, rolls back when it throws. See [Transactions](#transactions). |
| `simulateConflict()` | `void` | Local mode only: make the next commit fail with `SerializationFailure`. Throws in the Lambda runtime. |
| `db.cluster` | `{ kind, id }` | Which cluster the block runs on: `id` is `'default'` when owned, otherwise the `DatabaseCluster`'s full id. |
| `db.schemaName` | `string` | The schema this block's tables live in. |

`sql` is a tagged template: every `${value}` becomes a bound parameter, never string interpolation. Table and column names cannot be parameters.

**Runtime only.** Call the data methods inside an `ApiNamespace` method, `RawRoute` handler, job handler, or a runtime script, not at the top level of `aws-blocks/index.ts`. Top-level code also runs during CDK synth, where the block is its infrastructure construct and every data method throws `Database.query() cannot be called during CDK synth`. Constructing the block at module scope is fine; only the calls must move into handlers. Every `ApiNamespace` method is a public endpoint, so gate it with `await auth.requireAuth(context)` from an auth block.

## Options

An option goes on the cluster if every block on that cluster must share it, and on the block otherwise.

Cluster options:

| Option | Type | Description |
|---|---|---|
| `type` | `'distributed'` | Required. Aurora DSQL. The value is required so that the planned `provisioned` category adds a value without changing this line. |
| `removalPolicy` | `'retain' \| 'destroy'` | What happens to the cluster when the stack is destroyed. When omitted, the stack-wide `defaults` apply: `production` retains with deletion protection on, `sandbox` destroys. Most apps never set this. |

Block options:

| Option | Type | Description |
|---|---|---|
| `cluster` | `DatabaseCluster` | The cluster to run on. Omit it and the block owns a `distributed` cluster. |
| `migrationsPath` | `string` | Directory of `.sql` files, relative to the project root. Defaults to `./aws-blocks/migrations/{id}`; the default may be missing, an explicit path must exist. |
| `schemaName` | `string` | The PostgreSQL schema for this block's tables. `public` when the block owns its cluster, otherwise the block id. Two blocks on one cluster cannot share a schema. |
| `removalPolicy` | `'retain' \| 'destroy'` | Only when `cluster` is omitted. With a shared cluster, set it on the `DatabaseCluster`. |
| `logger` | `ChildLogger` | Logger for internal operations. Defaults to a `Logger` at error level. |

`Database` and `DatabaseCluster` ids are unique per app; a second block with the same id is an error at construction.

## Sharing a cluster

```ts
const shared = new DatabaseCluster(scope, 'shared', { type: 'distributed' });
const audit = new Database(scope, 'audit', { cluster: shared });
const search = new Database(scope, 'search', { cluster: shared });
```

The `DatabaseCluster` is the only thing that provisions: one DSQL cluster, one pair of migration Lambdas, and one database role for the app, `blocks_app_{clusterId}`. Each `Database` on it adds a schema named after its id, a custom resource that applies that block's migrations into the schema, and grants on the schema's tables. At request time each block opens its own connection pool to the same cluster as the same role, with `search_path` set to its schema, so ``audit.query(sql`SELECT * FROM events`)`` reads `audit.events` and the same text on `search` reads `search.events`. Locally the cluster is one PGlite and the blocks are two schemas in it, the same layout as on AWS.

**Isolation is by namespace, not by permission.** Both blocks connect as one role that has DML on every schema on the cluster. A query that qualifies a table name, ``sql`SELECT * FROM search.events` `` from `audit`, works, and so does a join across the two schemas in one statement. Treat the schema as a naming convention that keeps two blocks' tables apart, not as a boundary between tenants or trust levels; a block that must not see another block's data belongs on its own cluster.

**Why share on DSQL.** A DSQL cluster costs nothing when idle, so sharing saves no money, unlike Aurora where a cluster has a capacity minimum. Share when you want one migration pipeline instead of one per block, when you need to query across the blocks' tables, or to stay under the default quota of 20 clusters per account and Region, which per-developer sandboxes count against. Keep separate clusters when the blocks have different lifecycles: the removal policy is set on the cluster, blocks on one cluster migrate one at a time, and a block never moves to another cluster later (see [The binding rule](#the-binding-rule)).

## Migrations

Each block has one directory of ordinary PostgreSQL files, `./aws-blocks/migrations/{id}` unless `migrationsPath` says otherwise. Files run in name order, once each:

```
aws-blocks/migrations/
  shop/
    001_init.sql
    002_orders_customer_index.sql
  audit/
    001_events.sql
```

### What the rewriter changes

Write PostgreSQL; the block turns each file into steps a `distributed` cluster accepts.

| You write | What runs on DSQL |
|---|---|
| Several DDL statements in one file | Each DDL statement in its own transaction; the DML statements between them share one |
| `CREATE INDEX` | `CREATE INDEX ASYNC`, then a wait for the index job |
| `ALTER TABLE … ADD CONSTRAINT name CHECK (…)` or `… FOREIGN KEY (…)` | The constraint `NOT VALID`, then `ALTER TABLE ASYNC … VALIDATE CONSTRAINT name` and a wait for that job. A `REFERENCES` inside `CREATE TABLE` runs as written |
| `SERIAL`, `BIGSERIAL`, `SMALLSERIAL`, or an identity column on `integer` | `BIGINT GENERATED … AS IDENTITY (CACHE 65536)`. DSQL sequences are `bigint` and need an explicit cache of 1 or at least 65536 |
| `CREATE SEQUENCE` without a cache or on a smaller type | `… AS BIGINT … CACHE 65536` |

To see the steps without running them:

```sh
npx bb-database migrate --explain ./aws-blocks/migrations/shop
```

The output also lists every foreign key and its referential action, so a switch to `ON DELETE CASCADE` shows up in review. On DSQL the rows a cascade deletes count toward the 3,000-row transaction limit, and a delete that fans out past it fails whole; prefer `NO ACTION` or `RESTRICT` for unbounded parent-child relationships.

### What is rejected

After the rewrite, the statements are checked with [`dsql-lint`](https://github.com/awslabs/aurora-dsql-tools/tree/main/dsql-lint), the linter the Aurora DSQL team maintains. What DSQL cannot run fails at `npm run dev` and at synth, before any deploy: `CREATE TRIGGER`, `CREATE EXTENSION`, `CREATE POLICY`, `TRUNCATE`, array columns, `ADD COLUMN … DEFAULT`, `SET NOT NULL` or `TYPE` on an existing column, `ADD CONSTRAINT … UNIQUE (…)`, and so on. The error names the file, the rule, dsql-lint's suggestion, and the DSQL documentation page:

```
Migration validation failed for a 'distributed' cluster:
  001_init.sql: array_type: Column `tags` uses an array type, which is not supported in DSQL. Use a join table for relational data, or store as JSON text. Checked against https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility.html
```

Three checks are the block's own: dropping a primary-key column (seen from the `CREATE TABLE` earlier in the plan), an unnamed `ADD CHECK` / `ADD FOREIGN KEY`, which the rewriter could not validate by name, and `GRANT … ON SCHEMA public`, which dsql-lint accepts but DSQL rejects at runtime because `public` is a system schema that roles can use without a grant.

`dsql-lint` is a native binary that `@aws/dsql-lint` installs per platform as an optional dependency (macOS, Linux, and Windows on x64; macOS and Linux on arm64). It runs on your machine and at synth, never on AWS. If your package manager skipped optional dependencies, run `npm install @aws/dsql-lint --include=optional`, or point `DSQL_LINT_PATH` at a build.

### How migrations deploy

Locally, a block applies its pending files before its first query. On AWS, each block has one CloudFormation custom resource that applies its files at deploy; blocks on one cluster migrate one at a time, and every app function waits for the migrations of the blocks it uses, so new code never runs against the old schema. An index build or constraint validation is a DSQL job; the resource polls it every 30 seconds for up to two hours. Applied files are recorded in a `_migrations` table in the block's schema. If a file fails partway, the error names the failed step and the file is not recorded; fix the cause and deploy again, and the runner resumes at that step.

## Transactions

DSQL uses optimistic concurrency: a transaction never waits on a lock, and two transactions that change the same row both run to the end, after which one commit fails with `SerializationFailure` (SQLSTATE `40001`, HTTP 409, flagged retriable). `SELECT … FOR UPDATE` is supported and makes a read conflict with concurrent writes, which is how a read-modify-write stays correct.

- A single `query` or `execute` outside a transaction is retried for you, three times at 50, 100 and 200 ms.
- A `transaction()` callback is re-run only when you pass `{ retryOnConflict: true }`, because a callback may have side effects. `maxRetries` defaults to 3.
- A transaction may change at most 3,000 rows (cascaded deletes included) and 10 MiB of data; past either it fails with `TransactionRowLimitExceeded` and nothing is kept. Split bulk work into batches.
- DDL and DML never share a transaction, and only migrations run DDL.

```ts
// Safe to re-run: the callback reads, decides, writes, and has no side effects outside the database.
await shop.transaction(async (tx) => {
  const row = await tx.queryOne<{ total: number }>(sql`SELECT total FROM orders WHERE id = ${orderId} FOR UPDATE`);
  if (!row) throw new Error('no such order');
  await tx.execute(sql`UPDATE orders SET total = ${row.total + delta} WHERE id = ${orderId}`);
}, { retryOnConflict: true });
```

`shop.simulateConflict()` makes the next commit fail with `SerializationFailure` in local mode, so a test can cover the retry without a deployed cluster.

## Errors

Query and transaction failures carry a `DatabaseErrors` name. Match them with `isBlocksError(e, DatabaseErrors.X)` on the server or the client; only the name and a fixed message cross the wire, the driver error stays on the server. Setup mistakes (a duplicate id, a missing `migrationsPath`), `dsql-lint` findings (`DsqlValidationError`) and migration failures (`MigrationFailedException`) have their own names; fix those rather than catch them.

| Error | When | Retried automatically |
|---|---|---|
| `QueryFailed` | Any other SQL error, including a foreign-key or check violation | No |
| `ConnectionFailed` | Endpoint or network failure | No |
| `TransactionFailed` | The callback threw, or the commit failed for a reason other than a conflict | No |
| `UniqueConstraintViolation` | SQLSTATE `23505` (HTTP 409) | No |
| `SerializationFailure` | SQLSTATE `40001` at commit (HTTP 409, retriable) | A single `query` or `execute`: three times. A `transaction()` callback: only with `retryOnConflict: true` |
| `TransactionRowLimitExceeded` | More than 3,000 rows changed (cascades included) or more than 10 MiB written in one transaction, locally and on DSQL (SQLSTATE `54000`) | No; split the work |

DSQL's stale-schema-cache error (`OC001`) is retried once wherever it happens.

```ts
import { isBlocksError } from '@aws-blocks/core';
import { DatabaseErrors, sql } from '@aws-blocks/bb-database';

try {
  await shop.execute(sql`INSERT INTO customers (id, email) VALUES (${id}, ${email})`);
} catch (err) {
  if (isBlocksError(err, DatabaseErrors.UniqueConstraintViolation)) return { conflict: 'email already registered' };
  throw err;
}
```

## Local mode

`npm run dev` needs no AWS account. Each cluster is one PGlite (PostgreSQL compiled to WebAssembly) under `.bb-data/`, with one schema per block, as on AWS.

A `distributed` cluster adds DSQL's checks locally. Every statement a handler issues goes through `dsql-lint` first (once per distinct statement), so unsupported SQL fails on your machine instead of in production; DDL outside a migration is refused because the deployed app role can only run DML; and a transaction that changes more than 3,000 rows (cascades included) or 10 MiB fails and rolls back, as it does on DSQL.

| | Owned default | `DatabaseCluster` |
|---|---|---|
| Engine | PGlite with `dsql-lint` and the DSQL limits | One PGlite per cluster, one schema per block, same checks |
| Data | `.bb-data/{fullId}/` | `.bb-data/{clusterFullId}/` |
| Migrations | Before the block's first query | Same, per block, into its schema |

PGlite has one session, so local work on a cluster runs one statement or transaction at a time. Bugs that need two requests to overlap do not reproduce locally; `simulateConflict()` covers the retry path.

## The binding rule

A `Database` is bound to one cluster, by id and type, at its first deploy. A deploy that would change either stops:

```
Deploy stopped: Database 'app-shop' is bound to its default cluster (distributed) and cannot move to 'app-shared' (distributed).
A Database keeps its cluster for life. To change clusters: add a new Database on 'app-shared', copy the data, switch your handlers, then remove 'shop'.
Data on the default cluster is retained (removal policy: retain).
```

Production has no override. Sandbox deploys skip the check, since a sandbox stack is destroyed anyway. The dev server keeps it with a marker file at `.bb-data/{fullId}/binding.json`; delete `.bb-data` to reset it.

The guard runs before `cdk deploy` in production, as a pre-deploy hook that `npm run deploy` discovers from this package. It compares the bindings recorded in the stack's metadata with the deployed template. It also builds a change set and stops if the deploy would remove or replace a DSQL or Aurora cluster, which catches a renamed `Database` or `DatabaseCluster` id. Deleting a `Database` block is allowed: its cluster, or its schema on a shared cluster, stays under the removal policy. Deleting a block whose cluster has `removalPolicy: 'destroy'` in production is a stop, because that deploy would delete the data; deploy once with `retain` first.

**To move a block's data:**

1. Add a new `Database` with a new id on the target cluster, give it the same migrations, and deploy.
2. Copy each table from the old block's schema into the new one. On the same cluster, run `INSERT INTO new_schema.t SELECT * FROM old_schema.t`. Across clusters, export with `\copy old_schema.t TO 't.csv' CSV` and load with `\copy new_schema.t FROM 't.csv' CSV`. A `distributed` target accepts at most 3,000 rows per transaction, so load large tables in chunks of that size. Load parents before children, and end with a row-count check: an import that ignores constraint errors leaves orphans behind.
3. Check row counts on both sides.
4. Switch your handlers to the new block and deploy.
5. Remove the old block and deploy. Its data stays until you drop the schema or the cluster.

## Kysely query builder

```ts
import { createKyselyAdapter } from '@aws-blocks/bb-database';

interface Schema {
  customers: { id: string; email: string };
}
const kysely = createKyselyAdapter<Schema>(shop);
const customers = await kysely.selectFrom('customers').selectAll().where('email', 'like', '%@example.com').execute();
```

The adapter connects on its first query, so creating it at module scope is safe during synth.

## CLI

| Command | What it does |
|---|---|
| `npx bb-database migrate --explain [dir]` | Prints the migration steps and the foreign keys they define |
| `npx bb-database predeploy --project-root .` | Dry run of the production pre-deploy hooks that `npm run deploy` runs, including this block's deploy guard. Prints their notes and exits non-zero on a stop; nothing is deployed |

## What it provisions (AWS)

Per cluster, whether a block owns it or a `DatabaseCluster` declares it:

- **One Aurora DSQL cluster** (`AWS::DSQL::Cluster`). No VPC, no secret, no security group, no proxy; IAM token authentication over the public endpoint. Deletion protection follows the stack `defaults`.
- **Two migration Lambdas** built from one bundle (`onEvent` and `isComplete`), one log group, and a custom-resource provider that polls DSQL jobs every 30 seconds for up to two hours.
- **IAM:** the app's execution role gets `dsql:DbConnect` on the cluster; the migration Lambdas get `dsql:DbConnectAdmin`.
- **Config:** `BLOCKS_{clusterId}_ENDPOINT` and `BLOCKS_{clusterId}_REGION`, injected through the config bucket.

Per block: one S3 asset with its migration files and one CloudFormation custom resource that applies them. The migration Lambda also creates a per-cluster database role for the app, maps it to the execution role with `AWS IAM GRANT`, and grants it `SELECT`, `INSERT`, `UPDATE` and `DELETE` on the block's tables, `SELECT` on its views, and `USAGE` on its sequences. DDL needs the admin token, which only the migration Lambdas hold.

**Cost.** A DSQL cluster has no charge when idle; usage is billed per million request units and per GB-month, with a monthly free tier ([pricing](https://aws.amazon.com/rds/aurora/dsql/pricing/)). The migration Lambdas run only during deploys. A `Database` that owns its cluster is one cluster against the [default quota](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/CHAP_quotas.html) of 20 per account and Region; blocks on a shared `DatabaseCluster` count once.

## Access through the AWS SDK

`getSdkIdentifiers(db)` from `@aws-blocks/core` returns the block's `clusterId` and `schemaName`. In a deployed Lambda it also returns the cluster's `clusterEndpoint` and `region`, which is what a `DsqlSigner` needs to open your own `pg` connection as the same role. The umbrella's typed overloads do not know this block yet, so the result is a `Record<string, string>`.
