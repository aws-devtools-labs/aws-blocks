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
| `23505` | `UniqueConstraintViolation` |
| `08xxx` | `ConnectionFailed` |
| (other) | `QueryFailed` |

The `DatabaseBase` subclass only adds `TransactionFailed` naming for errors that escape the engine's transaction methods without a recognized name.

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
| Security group | Inbound 5432 from Lambda SG only |
| Secrets Manager secret | Auto-generated credentials |
| Migration Lambda + CustomResource | Runs .sql files on deploy |
| IAM grants | `rds-data:*`, `secretsmanager:GetSecretValue` |

Removal policy: DESTROY in sandbox, RETAIN in production.

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
| TLS cert verification default (`fromExisting` connection string) | Mock defaults to `rejectUnauthorized: false` (local/self-signed DBs); AWS runtime defaults to verifying (`PgClientEngine` → `rejectUnauthorized: true`) | Intentional. Pass `ssl` to override either layer; the `db pull`-generated wiring sets `ssl: resolveDbSsl()` for both, so the generated path is consistent. A hand-written `fromExisting({ connectionString })` with no `ssl` passes locally but verifies in AWS (pin a provider CA via `ssl.ca`). |
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
