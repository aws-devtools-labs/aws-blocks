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
- On the AWS runtime, reports the block's BB user-agent chain as the Postgres
  `application_name` (`Scope.formatUserAgentString()`, e.g.
  `aws-blocks/<core> bb/Database/<version>`), visible in `pg_stat_activity` on
  servers that expose it and in provider dashboards (Supabase, Neon). Supplied
  as pg's `fallback_application_name`, so an `application_name` from the
  caller's connection string or `PGAPPNAME` wins. Capped at the Postgres
  63-byte limit, dropping whole parent entries rather than truncating
  mid-token. Attribution only — no query-behavior impact. Not set on the
  `DataApiEngine` path (RDS Data API is HTTP, not a pg wire connection).

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
| Aurora Serverless v2 cluster | PostgreSQL database. Storage encryption at rest is **opt-in**: emitted (`storageEncrypted: true`) only when the `@aws-blocks/bb-data:encryptStorageByDefault` context flag is set (new `create-blocks-app` projects set it) or a `storageEncryptionKeyArn` is supplied; otherwise the `StorageEncrypted` property is left unset so existing clusters are not replaced. Uses the AWS-managed `aws/rds` key by default, or a customer-managed key via `storageEncryptionKeyArn` |
| VPC + private subnets | Network isolation |
| Security group | No ingress — reached over the RDS Data API (HTTPS), not a socket |
| Secrets Manager secret | Auto-generated credentials; encrypted with `storageEncryptionKeyArn` when one is supplied |
| Automated backups | On by default, retained 15 days; `pointInTimeRecovery` controls the window (`true` → 15 days, `{ retentionDays: n }` → 1–35 days, `false` → clamps to the 1-day minimum since Aurora cannot disable backups); also the PITR window |
| CloudWatch log export | PostgreSQL engine log exported to CloudWatch Logs; retention follows `defaults.logRetention` when set, else the account default |
| LogRetention custom resource | Setting the engine log group's retention adds a CDK `LogRetention` custom resource — a per-stack singleton Lambda + IAM role — because RDS owns the engine log group name via a token id, so CDK can't create the `LogGroup` directly. Intended/unavoidable for this knob |
| Migration Lambda + CustomResource | Runs .sql files on deploy (retries with exponential backoff, 1s → 30s × 8, while the cluster is unreachable — a new cluster's writer coming up, or a scale-to-zero cluster resuming from auto-pause) |
| IAM grants | `rds-data:*`, `secretsmanager:GetSecretValue` |

Removal policy: DESTROY in sandbox, RETAIN in production.

### Security posture (Aurora)

- **Encryption at rest** is **opt-in**, gated so new projects are secure by
  default without replacing an existing cluster. The CDK layer emits
  `storageEncrypted: true` only when the `@aws-blocks/bb-data:encryptStorageByDefault`
  context flag is set (the `create-blocks-app` templates set it) or a
  customer-managed key is supplied; otherwise it leaves the `StorageEncrypted`
  property unset — CloudFormation renders no key, and an explicit `false` is never
  emitted, because either would be a template change that forces a destructive
  replacement of an existing, implicitly-unencrypted cluster. A synth warning
  (`@aws-blocks/bb-data:StorageEncryptionOptIn`) fires when neither is set. A
  customer-managed KMS key, when supplied, encrypts both the storage volume and
  the auto-generated credentials secret and forces encryption on regardless of the
  flag.
- **`iamAuthentication` is intentionally NOT enabled.** The cluster is reached
  exclusively over the RDS Data API (HTTPS + Secrets Manager credentials), never a
  direct DB socket, so database-level IAM authentication does not apply to this
  access path.
- **Automatic secret rotation is a deliberate follow-up**, not implemented here.
  Rotation requires a rotation Lambda wired into the cluster VPC — a larger change
  than this hardening pass. Supplying a `storageEncryptionKeyArn` does encrypt the
  generated secret today.
- **Upgrade note (destructive replacement):** RDS cannot encrypt an
  already-provisioned, unencrypted cluster in place, so enabling storage
  encryption (or changing the key) makes CloudFormation create a **new, empty**
  encrypted cluster and repoint the stack. There is no in-place path. The
  migration CustomResource does **not** re-run on a cluster swap — its only
  CloudFormation properties are the service token and the migrations hash, and
  neither changes when the cluster is replaced, so CloudFormation never invokes
  it; the replacement cluster comes up with **no schema**, and migrations run only
  when a migration file changes (which changes the migrations hash). Under
  production (RETAIN) the old cluster is orphaned/unreferenced; under sandbox
  (DESTROY) the old cluster and its data are deleted; under `removalPolicy:
  'snapshot'` the old cluster is snapshotted as it is replaced, though under
  production's `deletionProtection: true` the follow-up delete may fail and leave
  it in place (this cleanup path is unverified on a real deploy). Adding or
  changing the key also replaces the generated credentials secret (new logical id,
  new generated password). The replacement is symmetric: removing the flag (or
  `storageEncryptionKeyArn`) from a project that already deployed encrypted —
  deleting the `cdk.json` line, a merge dropping it — also changes
  `StorageEncrypted` and so **likewise replaces the cluster** (back to
  unencrypted), with the same new-empty-cluster / no-schema outcome. The only safe
  route is to snapshot the existing cluster, restore it with encryption enabled,
  then cut over. Review the diff and snapshot first.

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
| No Data API request limits | Mock has no per-request throttling; the AWS Data API enforces request-rate/size limits | Sandbox testing |
| No VPC isolation | Network access control not enforced locally | Infrastructure concern |
| PGlite is single-connection | No concurrent transaction behavior | Document; load test in sandbox |
| No cold start penalty | Aurora 0-ACU cold start not simulated | Latency is a production concern |
| TLS cert verification default (`fromExisting` connection string) | Mock defaults to `rejectUnauthorized: false` (local/self-signed DBs); AWS runtime defaults to verifying (`PgClientEngine` → `rejectUnauthorized: true`) | Intentional. Pass `ssl` to override either layer; the `db pull`-generated wiring sets `ssl: resolveDbSsl()` for both, so the generated path is consistent. A hand-written `fromExisting({ connectionString })` with no `ssl` passes locally but verifies in AWS (pin a provider CA via `ssl.ca`). The mock warns once when `ssl` is omitted so this dev/prod gap surfaces locally. |
| External migration *apply* | n/a — build/deploy lifecycle step, not a runtime method | No mock needed (intentional; see Schema Migrations above) |
| `application_name` on the pg connection | Not reported by the mock/local engine; the AWS `PgClientEngine` path reports the BB user-agent chain (see above) | Intentional. Attribution-only. Unset on the RDS Data API path. |

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
