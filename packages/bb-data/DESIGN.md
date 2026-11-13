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
- An idle pooled connection dropped by the server or network (a pooler's idle
  timeout, a reset, a Lambda freeze/thaw) is discarded by `pg.Pool` and logged
  as a fixed warning; it does not crash the process. The warning never includes
  the driver's error message (it can carry server-supplied text) and includes
  the error code only when it is a SQLSTATE or a Node errno name. The pool opens
  a replacement connection when one is needed; with more than one connection,
  another healthy one may serve the next query.
- A connection dropped during a transaction (checked out by `beginTransaction`)
  is handled the same way: a warning is logged, the transaction's remaining
  queries fail, and the connection is discarded on release. Each transaction
  client carries this `'error'` listener only while checked out; `query()` and
  `execute()` rely on `pg.Pool`'s own per-query listener.
- A failed `BEGIN` releases its client with the error, so pg closes that
  connection instead of reusing it and the pool slot is freed.
- On the AWS runtime, the connection string (an AppSetting) is read once and the
  engine is cached only after a successful read. A failed read is not cached:
  the next call retries. Concurrent first calls share one read.

## Error Translation

Error translation happens at the engine layer, not the database layer. Each engine catches raw errors and sets standardized `error.name` values before rethrowing:

| pg error code | DatabaseErrors name |
|---------------|-------------------|
| `40001` | `SerializationFailure` (→ `ApiError` 409, retriable) |
| `23505` | `UniqueConstraintViolation` (→ `ApiError` 409, not retriable) |
| `42501` | `PermissionDenied` (→ `ApiError` 403, not retriable): the caller's statement hit a row-level-security `WITH CHECK` rejection or a missing grant |
| `23514` | `CheckViolation` (→ `ApiError` 400, not retriable) |
| `23502` | `NotNullViolation` (→ `ApiError` 400, not retriable) |
| `23503` | `ForeignKeyViolation` (→ `ApiError` 409, not retriable) |
| `08xxx` | `ConnectionFailed` |
| (other) | `QueryFailed` |

Data API errors that carry no SQLState are classified by their SDK exception name: `ServiceUnavailableException`, `InternalServerErrorException`, and `DatabaseResumingException` (a `minCapacity: 0` cluster waking from auto-pause) all map to `ConnectionFailed` — transient, and worth retrying. Everything else falls through to `QueryFailed`.

The four request errors (`42501`, `23514`, `23502`, `23503`) are built by the shared `requestError()` helper in `errors.ts`, used by the PGlite, pg-client and Data API engines (the Data API path parses the SQLState from the message), so all three produce an identically shaped `ApiError` with a fixed client message and the driver error kept as `cause`, whether the error is raised by a statement or at `COMMIT` (a deferred constraint). PGlite enforces every constraint and policy, and enforces grants once a statement runs under `SET ROLE` (PGlite itself runs as superuser), so these mappings are verified by engine unit tests against real PGlite and by an over-the-wire e2e test (`test-apps/comprehensive/test/database.test.ts`).

`42501` from `withRLS()`'s own `SET LOCAL ROLE` is not a caller error: it means the database user isn't a member of the role (on PostgreSQL 16+, the role's creator gets only `ADMIN`, not `SET`), which fails every `withRLS()` call. `setRLSContext()` (`rls.ts`) catches that case and re-tags it as a 500 `QueryFailed`, logging the `GRANT <role> TO CURRENT_USER` that fixes it. Only `rls.ts` knows the statement came from the framework, which is why the classification lives there and not in the engine translators.

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
| Security groups | The cluster security group admits only the rotation Lambda's security group on the PostgreSQL port (no ingress at all with `secretRotation: false`); the app reaches the cluster over the RDS Data API (HTTPS), not a socket. The Database's own VPC adds an endpoint security group admitting 443 from the rotation Lambda's security group only. The rotation Lambda's own group is closed outbound and egresses only to the cluster's port and to 443 on the Secrets Manager endpoint, so the credential it holds has no route to the internet even where the VPC has a NAT; with `provisionEndpoints: false` the endpoint is the customer's and cannot be named, so that rule is 443 to any address |
| Secrets Manager secret + rotation | Auto-generated credentials, rotated in place every 30 days under the `production` preset and not at all under `sandbox` (`secretRotation`) by the rotation Lambda (AWS's PostgreSQL single-user rotation function, a Serverless Application Repository app) in the cluster VPC; encrypted with `storageEncryptionKeyArn` when one is supplied |
| Secrets Manager VPC endpoint | The rotation Lambda's route to the Secrets Manager API, in the Database's own VPC (isolated, no NAT); in a shared VPC the core-provisioned endpoint is reused |
| Automated backups | On by default, retained 15 days; `pointInTimeRecovery` controls the window (`true` → 15 days, `{ retentionDays: n }` → 1–35 days, `false` → clamps to the 1-day minimum since Aurora cannot disable backups); also the PITR window |
| CloudWatch log export | PostgreSQL engine log exported to CloudWatch Logs; retention follows `defaults.logRetention` when set, else the account default |
| LogRetention custom resource | Setting the engine log group's retention adds a CDK `LogRetention` custom resource — a per-stack singleton Lambda + IAM role — because RDS owns the engine log group name via a token id, so CDK can't create the `LogGroup` directly. Intended/unavoidable for this knob |
| Migration Lambda + CustomResource | Runs .sql files on deploy (retries with exponential backoff, 1s → 30s × 8, while the cluster is unreachable — a new cluster's writer coming up, or a scale-to-zero cluster resuming from auto-pause) |
| RotationWait Lambda + CustomResource | Holds the deploy until the rotation that creating the schedule (or changing its interval) started has finished, so the first queries after `cdk deploy` do not hit the rotation window; gives up after five minutes (see Rotation on deploy below) |
| IAM grants | `rds-data:*`, `secretsmanager:GetSecretValue`; with a `storageEncryptionKeyArn`, `kms:Decrypt` on that key via Secrets Manager |

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
- **`iamAuthentication` is intentionally NOT enabled.** The app reaches the
  cluster exclusively over the RDS Data API (HTTPS + Secrets Manager
  credentials), never a direct DB socket, so database-level IAM authentication
  does not apply to this access path. The one socket client, the rotation
  Lambda, signs in with the master password it is rotating.
- **The credentials secret rotates automatically** under the `production`
  preset (every 30 days; `defaults.secretRotation` is off under `sandbox`, and
  `secretRotation` on the block overrides either way). The cluster calls CDK's
  `addRotationSingleUser()`, which deploys AWS's PostgreSQL single-user rotation
  function (a Serverless Application Repository (SAR) app, not CDK's separate
  `HostedRotation`) into the cluster VPC: it generates a new password, sets it on
  the cluster as `postgres` and makes it the secret's current version. The
  rotation is in place (same secret ARN) and the runtime never reads the password
  (the Data API reads the secret for it), so a rotation needs no change or
  redeploy of the app. The RDS-managed master password
  (`manageMasterUserPassword`) was rejected: on a cluster without a
  customer-managed key it renders `MasterUsername` as a literal where today's
  template uses a Secrets Manager dynamic reference, a text change CloudFormation
  applies as a cluster **replacement** (new, empty cluster), and on every cluster
  it moves the credentials to a new, RDS-owned secret with a different ARN. While
  rotation is on, CDK attaches a resource policy to the secret denying
  `secretsmanager:DeleteSecret` to the account (`cdk destroy` still deletes it; an
  out-of-band `delete-secret` is refused). With a `storageEncryptionKeyArn` the
  rotation Lambda's SAR template grants its role `kms:Decrypt`, `kms:DescribeKey`
  and `kms:GenerateDataKey` on the key, so the key-policy requirement is the one
  the app's own reads already have (the account's IAM principals may use the key;
  a policy that enumerates principals must also name the rotation Lambda's role,
  known only after the first deploy).
- **The rotation Lambda's network path is the only socket path.** It gets its
  own security group, the only one the cluster security group admits on the
  PostgreSQL port. It reaches the Secrets Manager API through an interface
  endpoint: in the Database's own VPC (isolated, no NAT) one is created for it (a
  dedicated endpoint security group admitting 443 from the rotation Lambda's
  security group only, ~$7.20/month per AZ in us-east-1, two AZs); in a shared
  VPC core already provisions it, and the Database registers its rotation
  security group via `endpointClientSecurityGroups` so core's endpoint security
  group admits it (with `provisionEndpoints: false` core cannot, and warns with
  the security group the customer must admit; that group is created by the first
  deploy, so the first rotation cannot reach Secrets Manager and the wait below
  runs its full five minutes — on the shared-VPC path the Database outputs the
  group's id so the failing deploy also prints what to admit, and the warning's
  id is acknowledgeable, so a customer who has added the rule can silence it
  without losing the synth check).
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

### Rotation on deploy (Aurora)

The schedule rotates immediately once created (and again whenever its interval
changes: `RotateImmediatelyOnUpdate` defaults to true), so the rotation app and
the schedule depends on the writer instance, on the migration custom resource
and, in the Database's own VPC, on the Secrets Manager endpoint and the rule
admitting the rotation Lambda on it: the rotation can connect, a password swap
cannot fail a migration statement, and an endpoint whose ENIs are not ready
cannot leave the rotation without a route (CloudFormation marks the schedule
complete before the rotation runs, and on an in-place upgrade the unchanged
writer no longer delays it). In a shared VPC the Database registers the schedule
as an `endpointClientDependents` entry so `finalizeVpc` orders it the same way.
The rotation app itself waits for none of them: it only has to exist before the
schedule. Single-user rotation has a window in which the cluster already
accepts the new password while the secret's `AWSCURRENT` version still holds the
old one, so a Data API call that reads the secret then is refused with SQLState
`28P01`. Measured over 11 rotations: 1–3 s, twice 16–18 s. Every rotation has
it, scheduled ones included, so `DataApiEngine` classifies that refusal as
`ConnectionFailed` (not `QueryFailed`) and makes 3 attempts (2 retries) with a
3 s then 6 s backoff — the statement is refused before it runs, so a retry cannot
apply it twice, and 9 s stays well inside the gateway's 29 s request ceiling.
A wrong credential is indistinguishable from the gap, so it pays those 9 s too,
and the cost is per statement rather than per request: measured against a client
that always refuses, three sequential statements cost 9.0 s (the refusal ends the
request) and three parallel ones 9.0 s (they overlap), while a handler that
catches each refusal and continues costs 27.0 s and brings the 29 s ceiling into
reach. Bounding it further was rejected: a per-process give-up counter small
enough to help would open inside the 16–18 s rotations measured above and fail
calls the retry exists to carry, and the elapsed-budget guard the internal
precedents use (give up rather than sleep past a known deadline) needs a request
deadline this engine is not given.
A statement inside a transaction is not retried: every attempt would reuse one
transaction id, which the backoff can outlive, so the refusal surfaces and the
caller retries the whole transaction on a fresh one. A slower rotation exhausts
the attempts and surfaces as a connection failure, which the migration retry
helper and a caller can both retry. Secrets Manager
starts the rotation after CloudFormation has marked the schedule complete (seen
to start two minutes later), so `cdk deploy` would return into that window. A
`RotationWait` custom resource (a Lambda allowed `secretsmanager:DescribeSecret`
on the secret; depends on the schedule) polls `DescribeSecret` until the secret's
last rotation is recent and finished (no version staged `AWSPENDING` without
`AWSCURRENT`), so the deploy returns after that rotation, not during it. It gives
up after five minutes so a rotation that cannot reach Secrets Manager (see
`provisionEndpoints: false` above) does not fail the deploy; a failed
`DescribeSecret` (a throttle, or an `AccessDenied` while the role's policy
settles) is logged and polled past for the same reason. What it saw is returned as
the resource's `Rotated` attribute and published as a `RotationWaited` stack
output, because rotation being enabled proves only that a schedule exists. The
e2e lanes assert that output is `true`, so a wrong security group, subnet or key
grant cannot ship green on the path a lane deploys. Only the own-VPC path is
deployed today: the comprehensive app provides no network, and the vpc-smoke
lane that owns the shared-VPC assertion runs nothing while issue #987 is open,
so the shared-VPC endpoint admission is covered by synth tests alone.
They read the output rather than the secret because a
CI role that can describe a stack often cannot describe a secret. The wait
identifies its own rotation by the `AWSCURRENT` version id moving off the one it
saw on its first read, which no earlier rotation can satisfy. The five-minute
recency bound is the wait's own budget rather than a measured figure, because
missing the deploy's own rotation costs a full wait and a `Rotated: false` on a
healthy deploy while accepting an earlier one only leaves the transient the
engine retries; it covers only what that check cannot see, a rotation that
finished
before the first read, so a second deploy returns on the first one's rotation
only inside that window — and the consequence there is the pre-rotation
behaviour, a transient first-query failure.
In a shared VPC the Database also outputs the rotation security group's id, for
the `provisionEndpoints: false` case where the customer admits it themselves;
`VpcContext` carries no `provisionEndpoints`, so the output is emitted for every
shared VPC rather than only that one.

The rotation app also adds the `AWS::Serverless-2016-10-31` transform to the
stack, which CloudFormation expands with the stack's execution role: that role
needs `serverlessrepo:GetApplication` and
`serverlessrepo:CreateCloudFormationTemplate` (the default bootstrap grants
both). CDK publishes the app in the `aws`, `aws-cn` and `aws-us-gov` partitions
only and resolves it through a mapping on `AWS::Partition`, so any other
partition fails while expanding the transform; `materialize` throws at synth
instead when the stack has a concrete region, and the README covers the
environment-agnostic case it cannot see.

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
| Customer-managed-key Data API decrypt | No CI lane stands up a CMK cluster, so the identity-side `kms:Decrypt` grant is covered by synth assertion plus a hand-run sandbox deploy, not an automated over-the-wire test | Synth asserts the statement on both principals; re-verify by hand when the grant changes |
| `tsvector` in the select list | PGlite returns it; the RDS Data API cannot represent it and the whole query fails | Keep `tsvector` out of the select list — it is used in `WHERE` / `ORDER BY`, not read back as a value (see the "Local vs. AWS: column types" note in `README.md`) |

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
