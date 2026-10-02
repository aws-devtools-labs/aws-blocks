# Database — Design

Design document for the Database Building Block. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-data`
**Type:** Primitive (new infrastructure)
**AWS Service:** Aurora Serverless v2 (PostgreSQL-compatible) via RDS Data API

## Architecture

```
data-common (shared abstractions)
    ├── DatabaseEngine interface
    ├── DatabaseBase class (query/execute/transaction delegation)
    ├── sql tagged template + SqlQuery branded type
    ├── Kysely adapter
    └── Migration runner

bb-data (this package)
    ├── DatabaseBase subclass (adds RLS + transaction error naming)
    ├── PGliteEngine (local dev — WASM Postgres)
    ├── DataApiEngine (AWS — RDS Data API)
    ├── PgClientEngine (external databases — pg.Pool)
    ├── CRUD handler generator
    └── RLS context injection
```

## Engine Implementations

### PGliteEngine (Local Dev)

- WASM PostgreSQL via `@electric-sql/pglite`
- Data persists in `.bb-data/{fullId}/`
- Single-connection (no real concurrency)
- Translates pg error codes to `DatabaseErrors` names

### DataApiEngine (AWS Runtime)

- Stateless HTTP calls via `@aws-sdk/client-rds-data`
- Translates `$1` placeholders to `:p1` named parameters
- Marshals JS values to/from Data API Field types
- Transaction via `BeginTransaction`/`CommitTransaction` commands

### PgClientEngine (External Databases)

- `pg.Pool` with connection string
- Used for `fromExisting()` databases (external/managed PostgreSQL providers)
- Translates pg error codes via shared `translatePgError()`

## Error Translation

Error translation happens at the engine layer, not the database layer. Each engine catches raw errors and sets standardized `error.name` values before rethrowing:

| pg error code | DatabaseErrors name |
|---------------|-------------------|
| `40001` | `SerializationFailure` (→ `ApiError` 409, retriable) |
| `23505` | `UniqueConstraintViolation` (→ `ApiError` 409, not retriable) |
| `08xxx` | `ConnectionFailed` |
| (other) | `QueryFailed` |

Data API errors that carry no SQLState are classified by their SDK exception name: `ServiceUnavailableException`, `InternalServerErrorException`, and `DatabaseResumingException` (a `minCapacity: 0` cluster waking from auto-pause) all map to `ConnectionFailed` — transient, and worth retrying. Everything else falls through to `QueryFailed`.

The `DatabaseBase` subclass only adds `TransactionFailed` naming for errors that escape the engine's transaction methods without a recognized name.

An OCC serialization failure (SQLSTATE `40001`) is translated to an `ApiError` with status **409 (Conflict)**, retriable, preserving the `SerializationFailure` name so the JSON-RPC serializer emits 409 instead of a generic 500. This mapping is verified by translator/engine **unit tests** (`pg-error-translator.test.ts`, `data-api-engine.test.ts`), not an over-the-wire e2e test: the single-connection PGlite mock has no conflict-injection hook and cannot deterministically produce a `40001` serialization conflict over the wire, so unit tests are the verification ceiling for this Block. (The same holds for DistributedDatabase: its `40001` → 409 mapping is likewise covered by translator/engine unit tests only, not an over-the-wire e2e test — consistent with `bb-distributed-data/DESIGN.md`.)

A duplicate-key unique-constraint violation (SQLSTATE `23505`) is likewise translated to an `ApiError` with status **409 (Conflict)** — via the shared `uniqueConstraintConflict()` helper across the PGlite, pg-client, and Data API engines (both the SQLState-parsed and message-matched Data API paths) — preserving the `UniqueConstraintViolation` name. It is **not** retriable: a duplicate key is deterministic, so a blind retry of the same insert fails identically. Unlike `40001`, a `23505` conflict **is** deterministically inducible in the PGlite mock (which enforces the PK constraint), so this mapping is additionally verified by an **over-the-wire e2e test** (`test-apps/comprehensive/test/database.test.ts`) asserting `error.status === 409` on the client — per AGENTS.md §11 for a serialization/behavior-affecting change. The raw driver text is retained only as `cause` (server-side); the client message is a fixed string.

## RLS Implementation

`withRLS(context)` returns an `RLSScopedDatabase` that wraps every operation in a transaction with PostgreSQL session variables (using the standard `request.jwt.claims` / role convention):

```sql
BEGIN;
SET LOCAL ROLE 'authenticated';
SELECT set_config('request.jwt.claims', '{"sub":"user-123"}', true);
-- user's query runs here --
COMMIT;
```

This enables PostgreSQL RLS policies to filter rows based on the authenticated user. The RLS-scoped database cannot be nested (`withRLS().withRLS()` throws).

## CRUD Handler Generator

`db.crud()` generates list/get/create/update/delete methods from schema metadata. All operations route through `withRLS()` for row-level isolation. The generated SQL uses parameterized queries built from the schema definition.

## Infrastructure (CDK)

| Resource | Purpose |
|----------|---------|
| Aurora Serverless v2 cluster | PostgreSQL database |
| VPC + private subnets | Network isolation |
| RDS Proxy | Connection pooling |
| Security group | No ingress — reached over the RDS Data API (HTTPS), not a socket |
| Secrets Manager secret | Auto-generated credentials |
| Migration Lambda + CustomResource | Runs .sql files on deploy (retries with exponential backoff, 1s → 30s × 8, while the cluster is unreachable — a new cluster's writer coming up, or a scale-to-zero cluster resuming from auto-pause) |
| IAM grants | `rds-data:*`, `secretsmanager:GetSecretValue` |

Removal policy: DESTROY in sandbox, RETAIN in production.

## Live Sync

`Database({ sync })` + `db.shape()` stream rows to the client. The wire protocol is
[Electric](https://electric.ax)'s HTTP shape protocol. The client reads it with
`@electric-sql/client` behind AWS Blocks' own `Shape<T>` interface (`src/sync/live-shape.ts`),
so the sync engine can change without changes to app code. `DistributedDatabase`
uses this: it implements the same `Shape<T>` on Aurora DSQL with a reconcile
protocol and CDC (see `bb-distributed-data/DESIGN.md`). The engine-agnostic parts
(the `Shape` types, shape tokens, the `ShapeStore` base class, the client middleware,
and the response-hint routing) live in `@aws-blocks/data-common`; `src/sync/shape-claims.ts`
re-exports them and adds the Electric query mapping.

### Read-your-writes

When an API method writes to a synced table (through `db.query()`, `db.execute()`,
or `db.transaction()`), the write runs in a transaction that reads
`pg_current_xact_id()` before commit. After commit, the database adds a `data/sync`
RPC response hint with the shape path, the tables, and the txid. The client
middleware awaits, for every open shape on that table, evidence of the write:
the txid in a change message's `txids`, or the txid visible
in a `snapshot-end` snapshot (`isVisibleInSnapshot`). A shape the write doesn't
touch never sees the txid, so once any shape has seen it at commit LSN L (Electric
puts `lsn` on change messages), the others count as synced when they are caught up
to L: a change with `lsn` ≥ L or an `up-to-date` with `global_last_seen_lsn` ≥ L.
A shape behind L refreshes once (`forceDisconnectAndRefresh()`, a non-live request
that ends with `up-to-date` at Electric's current LSN). If no open shape has the
write, the wait ends after 1 second and the call resolves anyway.

The writer does not send an LSN: it cannot read its own commit LSN
(`pg_current_wal_lsn()` after commit is past it; inside the transaction it is
before it). So only a shape that saw the txid can tell the others the LSN to reach.

### Progressive loading, subqueries, mapping

- **Changes-only shapes** (`mode: 'changes_only'`) pass `log=changes_only` to
  Electric (from the token, not the client) and load rows with the Electric
  client's own `requestSnapshot`, so its snapshot tracker drops live changes a
  snapshot already includes. The client sends its structured `SnapshotQuery` as
  JSON in `subset__where`; the shape endpoint compiles it (`compileSnapshotQuery`:
  queryable columns only, bound values) into Electric's `subset__where`,
  `subset__params`, `subset__order_by`, `subset__limit`, and `subset__offset`, and
  sets `queryable_columns` from the token (always including the key). No client
  SQL reaches the sync service. A `limit` without an order sorts by the key, so
  pages are stable.
- **Subqueries** in `where` are Electric's: it tracks the other tables and moves
  rows in and out. Those tables must be in `sync.tables` (they must be in the
  publication); `buildClaims` checks. Electric reports a move-out not as a delete
  per row but as a `move-out` event with tag patterns, against the `tags` it puts
  on each row's change messages (`removed_tags`, and `active_conditions` for
  filters in disjunctive normal form). `LiveShape` keeps the tags (`move-tags.ts`,
  see that file for the rules) and deletes the rows
  whose tags no longer hold; `move-in` re-activates conditions. The mock sends
  plain deletes instead.
- **Column mapping** (`columnMapping: 'snakeCamel'`) maps row keys in `LiveShape`;
  snapshot query fields are mapped to columns before sending. The Electric client's
  own `columnMapper` is not used, because it would rewrite the packed query.
- After a `must-refetch`, a changes-only shape replays its snapshot queries.

### Authorization: gatekeeper tokens

The API method that returns a shape is the only authorization point. `db.shape()`
signs a token (`@aws-blocks/data-common/sync`, re-exported by `src/sync/shape-claims.ts`) with the table, row filter (`$n`
placeholders), filter parameters, columns, key, owning Database, and expiry. The
shape endpoint verifies the HMAC-SHA256 signature and the expiry, then takes the
shape definition **only** from the token. From the client it accepts only Electric
protocol parameters (`offset`, `handle`, `live`, `cursor`, `cache-buster`,
`expired_handle`). On AWS the signing key
is derived from the Electric API secret: `HMAC(secret, "aws-blocks/data/shape-token/v1")`.

The token travels as a query parameter (`token`), not a header, so shape requests
are CORS "simple" requests and cache keys include the token. On a 401 or 403, the
hydrated `Shape` calls the API method that produced it again (client middleware
receives the originating request) and retries with the new token.

The endpoint path is `/aws-blocks/sync/{scope ids}/v1/shape`. It is built from scope
ids **without** the stack name, so the mock and AWS register the same path. The
sandbox dev server needs this to proxy the route.

### AWS

```
browser → API Gateway → app Lambda (verify token) ──SigV4──▶ HTTP API (IAM auth)
                                                          → VPC link → Cloud Map → Electric (Fargate)
                                                                                     → Aurora :5432 (logical replication)
```

- **Replication.** A cluster parameter group sets `rds.logical_replication = 1`.
  It is a static parameter: a new cluster has it at creation, and an existing
  cluster needs a writer reboot. Synth prints a reminder.
- **Least privilege.** A custom resource (`src/sync-setup-lambda.ts`, Data API, admin
  secret) runs after migrations. It creates the `electric` login role (password in
  Secrets Manager, alphanumeric), grants `rds_replication`, `CONNECT`, schema
  `USAGE`, and `SELECT` on the synced tables only, sets `REPLICA IDENTITY FULL`, and
  creates or updates `electric_publication_default` with exactly `sync.tables`. Electric
  runs with `ELECTRIC_MANUAL_TABLE_PUBLISHING=true`, so it never owns tables.
- **Networking.** The app Lambda stays outside the VPC; it reaches Electric over the
  HTTP API, which accepts only SigV4 requests from the app's execution role.
  - Standalone database VPC (isolated, no NAT): Electric gets its own `10.254.0.0/24`
    VPC with public subnets, so the task pulls its image without a NAT gateway. The
    VPC is peered to the database VPC. The database VPC gains only two routes and a
    5432 ingress rule from that CIDR. Its subnets are never changed, so adding
    `sync` to an existing database cannot replace them.
  - Shared VPC (`defaults.vpc`): Electric runs in the private-with-egress subnets,
    and the cluster allows 5432 from Electric's security group.
  - The task allows inbound traffic only from the VPC link's security group.
- **Image.** By default the stack builds the pinned release in the deploying account
  (`src/sync-image.ts`). A CodeBuild project (Arm, privileged) builds from the
  GitHub source tag with base images from the ECR Public mirror of the Docker official
  `elixir` images, and pushes to a stack-owned ECR repository. A custom resource
  starts the build and polls it, so the service is created only after the image
  exists. The tag is `{version}-{hash of the Dockerfile}`, and the build skips the
  push when the tag already exists, so a deploy rebuilds only when either changes.
  The Dockerfile follows upstream's step order: `config.exs` reads
  `Electric.MixProject`, so it is added only after dependencies compile.
  `sync.electric.image` skips the build.
- **Service.** One task (`minHealthyPercent: 0`, `maxHealthyPercent: 100`): there is
  one replication slot, so the old task stops before the new one starts. Shape logs
  live on Fargate ephemeral storage, which is a cache that Electric rebuilds from
  Postgres after a deploy.
- **Proxy limits.** The app Lambda buffers each response. Live requests are long
  polls (Electric holds them for up to 20 s, which fits the 28 s HTTP deadline).
  SSE live mode is not used.

### Local (mock)

PGlite cannot be a logical-replication source. `src/sync/mock-shape-server.ts`
emulates the shape protocol instead:

- On the first shape of a table, it installs an `AFTER INSERT OR UPDATE OR DELETE`
  row trigger that appends `(table, primary key, txid)` to `_blocks_sync_changes`.
- Each distinct shape (table, filter, columns) has one in-memory log, as in Electric.
  To catch up, it reads changelog rows after the shape's position and re-runs the
  filter for just the changed keys. A key that starts or stops matching becomes an
  insert or a delete, so rows that move into or out of the filter behave as on AWS.
- Live requests poll the changelog every 100 ms for up to 20 s.

### Mock vs AWS (sync)

| Behavior | Mock | AWS | Impact |
|---|---|---|---|
| Update messages | Full row | Changed columns + key (`replica=default`) | None for `Shape<T>`; it merges updates |
| Shape log | In memory; a dev-server restart makes clients resync (409 → refetch) | On Electric's disk; a deploy makes clients resync | Same client behavior |
| Live mode | Long poll, 100 ms change detection | Long poll, change pushed by replication | Mock latency is slightly higher |
| Token key | Fixed local key | Derived from the Electric secret | Local tokens grant access only to the local dev server |
| `txids` on messages | All transaction ids in the catch-up batch | The row's transaction | Read-your-writes resolves the same way |
| `lsn` / `global_last_seen_lsn` | Changelog sequence numbers | Commit WAL positions | Same order; used only to compare positions |
| Subquery dependencies | A change to a dependency table re-checks the whole shape | Electric moves only the affected rows | Same rows in the end |
| Snapshot (`subset`) responses | Compiled the same way, run on PGlite | Run by Electric | Same `{ metadata, data }` shape |
| Primary key check | Error on the first request if `key` is not the single-column PK | Not checked; Electric needs a PK | Mock catches it earlier |

## Schema Migrations (External Databases)

The Aurora path above runs `.sql` migrations from an **in-VPC Lambda CustomResource** (Aurora is unreachable from the deploy host). **External** connection-string databases (managed PostgreSQL, via `fromExisting()`) are publicly reachable, so their migrations run **host-side** as a pre-`cdk deploy` lifecycle step — reusing the same engine-agnostic `runMigrations` + `PgClientEngine` (no new runner). Code: `src/migrations/external-migrations.ts`, `src/migrations/baseline.ts`, and the lifecycle step in `@aws-blocks/core` (`scripts/external-migrations-step.ts`).

- **Where it runs:** `npm run dev` applies pending `./migrations` to the dev DB (and refreshes generated types); `npm run sandbox` / `npm run deploy` apply to the sandbox / production DB before `cdk deploy`. `core` invokes the `bb-data` CLI as a **subprocess** (core must not depend on bb-data — the dependency runs the other way); the connection string is passed via the `BLOCKS_MIGRATE_URL` env var, never argv.
- **Session port:** the runner rewrites the stored runtime string to the **5432 session port** (`toSessionPortUrl`) — DDL, multi-statement file transactions, and a session-held advisory lock all need a stable session, which the 6543 transaction pooler doesn't guarantee.
- **Concurrency:** a **non-blocking session advisory lock** (`pg_try_advisory_lock`, keyed by stage + migrations dir, bounded retry with timeout) serializes concurrent deploys; always released in `finally`.
- **Baseline:** `db pull` generates `migrations/000_baseline.sql` via `pg_dump --schema-only --schema=public`. On a DB with no `_migrations` table the runner auto-decides (`decideBaseline`): **empty** → run the baseline; **already-populated** (all baseline tables present) → record it applied without running; **partially populated** → error. `pg_dump` is needed only at pull time to *generate* the baseline; *applying* never needs it. Caveat: `--schema=public` does not dump `CREATE EXTENSION`, so a baseline whose column defaults depend on a non-core extension must add it manually.
- **Production guard (fail-open):** `npm run dev` and `npm run sandbox` (which share `.env.local`) refuse if the target resolves to the production DB (`.env.production` and/or the production SSM parameter). The guard is **best-effort and fails OPEN** — when neither production source is resolvable, the **sandbox** apply logs a transparency note and proceeds, while the **dev loop proceeds silently** (no production configured yet is the normal local case, so a note on every `npm run dev` would be false-alarm noise). `npm run deploy` intentionally targets production and is not guarded.
- **Forward-only:** no down/rollback migrations; recover by authoring the next numbered migration.

> **Parity note:** the external migration **apply** has *no mock counterpart* by design — it is a build/deploy **lifecycle** action, not a runtime BB method — so its absence from the parity table below is intentional, not a gap.

## Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| No connection pooling | Connection exhaustion only surfaces in AWS | Sandbox testing |
| No VPC isolation | Network access control not enforced locally | Infrastructure concern |
| PGlite is single-connection | No concurrent transaction behavior | Document; load test in sandbox |
| No cold start penalty | Aurora 0-ACU cold start not simulated | Latency is a production concern |
| No RDS Proxy behavior | Connection pinning, failover not simulated | Transparent to app code |
| TLS cert verification default (`fromExisting` connection string) | Mock defaults to `rejectUnauthorized: false` (local/self-signed DBs); AWS runtime defaults to verifying (`PgClientEngine` → `rejectUnauthorized: true`) | Intentional. Pass `ssl` to override either layer; the `db pull`-generated wiring sets `ssl: resolveDbSsl()` for both, so the generated path is consistent. A hand-written `fromExisting({ connectionString })` with no `ssl` passes locally but verifies in AWS (pin a provider CA via `ssl.ca`). The mock warns once when `ssl` is omitted so this dev/prod gap surfaces locally. |
| External migration *apply* | n/a — build/deploy lifecycle step, not a runtime method | No mock needed (intentional; see Schema Migrations above) |

## Relationship to data-common

`data-common` provides the shared abstractions used by both `bb-data` and `bb-distributed-data`:

- `DatabaseEngine` interface — implemented by all engines
- `DatabaseBase` class — query/execute/transaction delegation
- `sql` tagged template — injection-safe parameterized queries
- `SqlQuery` branded type — cannot be forged outside the `sql` tag
- `createKyselyAdapter()` — Kysely backed by any DatabaseEngine
- `runMigrations()` / `loadMigrationsFromDir()` — generic migration runner
- `Transaction` / `SqlDatabase` interfaces — shared type contracts

This package (`bb-data`) extends `DatabaseBase` with RLS support and error naming, while `bb-distributed-data` uses `DatabaseBase` directly (its engines handle error translation internally).
