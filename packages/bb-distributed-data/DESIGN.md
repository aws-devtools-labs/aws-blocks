# DistributedDatabase — Design

Design document for the DistributedDatabase Building Block. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-distributed-data`
**Type:** Primitive (new infrastructure)
**AWS Service:** Amazon Aurora DSQL

## Architecture

```
data-common (shared abstractions)
    ├── DatabaseEngine interface
    ├── DatabaseBase class
    ├── sql tagged template + SqlQuery
    ├── Kysely adapter
    └── splitStatements()

bb-distributed-data (this package)
    ├── DsqlEngine (AWS — pg.Pool + IAM token auth)
    ├── DsqlMockEngine (local — PGlite + validation layer)
    ├── Validation layer (DSQL compatibility checks)
    ├── TransactionTracker (DDL/DML/row-limit enforcement)
    ├── DSQL-specific migration runner
    └── CDK construct (CfnResource + migration CustomResource)
```

## Why a Separate Block (Not an Engine Flag on Database)

1. **Transaction semantics differ** — OCC means callbacks may need retry. Different API contract.
2. **Feature set is a strict subset** — FK, RLS, triggers, views absent. An engine flag hides this until deploy time.
3. **Mock parity goes in opposite directions** — PGlite is too permissive for DSQL. A separate block can have a restrictive mock.
4. **"When to use" guidance is completely different** — customers shouldn't accidentally pick DSQL.
5. **Multi-region is a first-class capability** — not a bolt-on option.

## Engine Implementations

### DsqlEngine (AWS Runtime)

- `pg.Pool` with IAM token authentication via `@aws-sdk/dsql-signer`
- Password callback generates fresh tokens per connection (60-min expiry)
- Translates pg error codes to `DistributedDatabaseErrors` names
- Pool handles reconnection transparently when connections expire

### DsqlMockEngine (Local Dev)

- PGlite wrapped with a validation layer
- `validateStatement()` rejects unsupported SQL before execution
- `TransactionTracker` enforces DDL/DML separation and 3,000-row limit
- `simulateConflict()` test helper for OCC unit testing (mock-only hook, absent from the deployed AWS surface). The `40001`→409 serialization-conflict mapping is covered by translator/engine **unit tests** (mirroring `bb-data`), not an over-the-wire e2e test: `simulateConflict()` is a mock-only trigger with no counterpart on the deployed runtime, and there is no deterministic way to raise a genuine `40001` conflict over the JSON-RPC wire in local e2e. A duplicate-key `23505`→409 `UniqueConstraintViolation` conflict (not retriable) is different: the DSQL mock enforces the primary-key constraint, so it **is** deterministically inducible over the wire and is additionally covered by an over-the-wire e2e test (`test-apps/comprehensive/test/dsql.test.ts`), not a mock-only hook.
- Error translation matches production behavior

## Validation Layer

The core insight: PGlite supports everything DSQL doesn't. Without validation, code works locally but breaks in production — the worst failure mode. The mock actively restricts PGlite to match DSQL's subset.

### Statement Validation

`validateStatement(sql)` strips string literals and comments, then checks regex patterns:

| Pattern | Rejects |
|---------|---------|
| `FOREIGN KEY` / `REFERENCES` | FK constraints |
| `CREATE TRIGGER` | Triggers |
| `CREATE VIEW` | Views |
| `LANGUAGE plpgsql` | PL/pgSQL functions |
| `SERIAL` / `BIGSERIAL` | Sequences |
| `TRUNCATE` | Use DELETE FROM |
| `LISTEN` / `NOTIFY` | Async notifications |
| `CREATE EXTENSION` | Extensions |
| `ADD COLUMN ... DEFAULT` | Column default on ALTER |
| `ALTER DEFAULT PRIVILEGES` | Not supported by DSQL |
| `CREATE POLICY` / `ENABLE ROW LEVEL SECURITY` | RLS |
| `CREATE TEMP TABLE` | Temporary tables |
| `SET TRANSACTION ISOLATION LEVEL` | Fixed Repeatable Read |
| `COLLATE` | C collation only |
| `CREATE INDEX ... ASC/DESC` | Sort direction on index keys (NULLS FIRST/LAST is allowed) |
| `ALTER TABLE ... DROP [COLUMN]` | Not in DSQL's supported ALTER TABLE subset (`DROP CONSTRAINT` and `ALTER COLUMN ... DROP DEFAULT/NOT NULL/EXPRESSION/IDENTITY` are supported) |

### Transaction Tracking

`TransactionTracker` enforces per-transaction constraints:

- Max 1 DDL statement per transaction
- Cannot mix DDL and DML in the same transaction
- Max 3,000 rows mutated (cumulative across all executes)

### Migration Validation

`validateMigrations()` checks all files upfront before running any:

- Each file: max 1 DDL statement
- Each file: no DDL + DML mixing
- All statements pass `validateStatement()`

## Migration Runner

DSQL's migration runner differs from the generic one in `data-common`:

- **DDL files** run as implicit transactions (no explicit BEGIN/COMMIT) — DSQL auto-commits DDL
- **DML files** run in explicit transactions (atomic)
- `validateMigrations()` runs upfront — catches errors before any SQL executes
- Uses `gen_random_uuid()` for `_migrations.id` (no SERIAL)

## OCC Retry Logic

```typescript
async transaction<T>(fn, options?) {
  const maxAttempts = options?.retryOnConflict ? (options.maxRetries ?? 3) + 1 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await this.base.transaction(fn);
    } catch (e) {
      const isOcc = e.code === '40001' || e.name === 'SerializationFailureException';
      if (isOcc && attempt < maxAttempts) continue;
      throw e;
    }
  }
}
```

Default: no retry (honest, predictable). `retryOnConflict: true` is explicit opt-in with JSDoc warning about side effects.

## Error Translation

Happens in the engine layer (same pattern as bb-data engines):

| pg error code | DistributedDatabaseErrors name |
|---------------|------------------------|
| `40001` | `SerializationFailure` |
| `23505` | `UniqueConstraintViolation` (→ `ApiError` 409, not retriable) |
| `08xxx` | `ConnectionFailed` |
| (other) | `QueryFailed` |

The `DistributedDatabase` class does not wrap errors — engines handle translation.

## Infrastructure (CDK)

| Resource | Purpose |
|----------|---------|
| `AWS::DSQL::Cluster` (CfnResource) | DSQL cluster |
| Migration Lambda (NodejsFunction) | Runs .sql files on deploy |
| CustomResource + Provider | Triggers migration on deploy |
| IAM PolicyStatement | `dsql:DbConnect` (app Lambda), `dsql:DbConnectAdmin` (migration Lambda) |
| CfnOutput | Cluster endpoint |

### Deletion Protection

`DeletionProtectionEnabled` is computed from `removalPolicy`:
- `destroy` or `sandboxMode=true` → disabled
- Otherwise → enabled

### Migration Lambda

- Connects via `pg.Client` + `DsqlSigner.getDbConnectAdminAuthToken()`
- Retries with exponential backoff on transient connection errors (cluster may take a moment after creation)
- `.sql` files bundled into the Lambda package via CDK `commandHooks`
- `migrationsHash` property triggers re-invocation when files change
- **Provisions custom DB role** on every deploy (idempotent):
  1. `CREATE ROLE "app_role" WITH LOGIN` (if not exists)
  2. `AWS IAM GRANT "app_role" TO 'arn:aws:iam::...:role/...'` (maps IAM to DB role)
  3. Per-table `GRANT SELECT, INSERT, UPDATE, DELETE` on user-created tables

### DSQL Permission Model Limitations

- `ALTER DEFAULT PRIVILEGES` — not supported (system entity error)
- `GRANT ... ON ALL TABLES IN SCHEMA public` — not supported (`public` is a system entity)
- `GRANT USAGE ON SCHEMA public` — not supported (same reason)
- Handled by enumerating user tables via `pg_tables` and granting DML individually on each deploy

## Live Sync

`DistributedDatabase({ sync })` + `db.shape()` has the same public API as `Database`
sync (the `Shape<T>` types, the token model, read-your-writes through response hints, and the client
middleware are shared in `@aws-blocks/data-common`). The engine underneath is
different, because Aurora DSQL has no logical replication.

### Why reconcile

Aurora DSQL has strongly consistent reads that scale out and cost nothing when
idle, and CDC for every committed change. So a DSQL shape keeps **no server
state**. The client holds the rows in 256 buckets, keyed by FNV-1a of the
primary key, and a row hash per row (the server computes it: SHA-256 of the row's
text values, first 64 bits). A bucket digest is the XOR of its row hashes plus the
row count. The client keeps the digests up to date as rows change.

All requests are `POST /aws-blocks/sync/{ids}/v1/shape?token=…`, in one of these modes:

| Mode | Body | Server reads | Answer |
|---|---|---|---|
| Full reconcile | `digest`: every bucket digest | the whole shape | NDJSON: `{schema}`, then `[bucket, [[hash,row]…]]` per differing bucket, then `{more:true}` if cut at ~4 MB (Lambda's response limit is 6 MB) |
| Bell | `changed`: sealed key lists | those keys (`pk IN (…)`, untyped params so the index is used) | `rows` that match, and `recheck`: the buckets of keys that do not |
| Own write | `written`: sealed key lists from the API response's sync hint | those keys | as `changed`, but lists sealed for other tables are ignored |
| Recheck | `held`: the keys the client holds in the `recheck` buckets | those keys | `rows` still in the shape; the client drops the rest |
| Snapshot | `snapshot`: a structured `SnapshotQuery` (changes-only shapes) | `where AND compiled query ORDER BY … LIMIT … OFFSET …` | `rows`, in query order |

Every answer carries `v`, the schema version of the shape's columns (a hash of
names and types). Table metadata is re-read every 60 seconds; a new `v` makes the client drop its rows and load them again
(changes-only shapes replay their snapshot queries).

**Snapshot queries** are structured JSON, never SQL: field → value or operator
(`eq`/`ne`/`lt`/`lte`/`gt`/`gte`/`in`/`like`/`ilike`/`isNull`), `or` arrays, sort
fields, `limit` ≤ 10,000, `offset`. `compileSnapshotQuery` (data-common) accepts only
queryable columns (`queryableColumns`, default the shape's columns), binds every
value, and qualifies sort columns with the table (the select list casts columns to
text). The result is ANDed with the signed `where`.

**Changes-only shapes** start empty and never send a full digest: rows come from
snapshots and from keyed changes (a changed key that matches the filter is added
even if never loaded: every change to the shape is delivered). Where a full
shape would do a full reconcile, a changes-only shape sends its held keys (`held`,
5,000 per request) and replays its snapshot queries.

There are no handles, offsets, retention windows, or `409 must-refetch`. A client
that reconnects after any amount of time sends its digests and gets the difference.
Multi-Region clusters need nothing extra: any Region's endpoint gives the same answer.

**Sealed keys.** Bells go to every open shape on a table, and a write's sync hint
goes to the client, so keys travel encrypted: AES-256-GCM with a key derived
from the shape-token secret, the table name as associated data, at most 16 KB of
keys (more → no keys → full reconcile). The server opens them, reads those rows
through the shape's own filter, and returns only rows the shape authorizes. For a
key that is no longer in the shape, it returns only the key's bucket number (8
bits), never the key; the client then names the keys it already holds there.

**Read-your-writes.** `DistributedDatabase` tracks writes to synced tables. In
`execute()` (of the database, or of a transaction) a plain `INSERT INTO` /
`UPDATE` / `DELETE FROM` (no CTE, no own `RETURNING`, one statement) is sent as
the same statement plus `RETURNING "<pk>"::text`, rebuilt through the `sql` tag;
it returns the same `rowCount`. A write through `db.execute()` runs in its own
transaction so it is tracked the same way. After commit, the database adds a
`data/sync` RPC response hint (`addResponseHint` in `@aws-blocks/core/bb-utils`):
the shape path, the tables, the sealed keys, and `full` if any write could not be
tracked. The client middleware (`onSettled`) gives the hint to every open shape
on that database and table, and awaits them before the API call resolves:
key-level reads for the keys, a full reconcile for `full`. A rolled-back
transaction adds nothing. Hints ride in one `x-blocks-hints` header, capped at
6 KB; a larger set becomes an overflow marker and open shapes do a full reconcile.

### Subquery dependencies

`buildClaims` finds the tables a filter reads (`FROM`/`JOIN` inside it), requires
each to be in `sync.tables`, and signs them in (`d`). The shape also listens on
those tables' bells. Their keys are sealed for the other table, so the server can't
open them for this shape and answers `full`: the shape does a full reconcile (or a
changes-only re-check). Correct for any subquery; a write to the other table costs
one full reconcile per open dependent shape.

### Equality routing

A shape whose filter has a top-level
`column = $n` conjunct (only ANDs at the top level; a non-boolean value preferred)
listens on a channel for that value, `bell/<table>.<column>.<hmac(value)>`, instead
of the table's channel. The CDC consumer finds the routed columns of a table in a
route index (a `DistributedTable`, `C#<table>` → column, registered when a shape is
issued) and rings, per written row:

- the channel of its new value (from the CDC `after` image),
- the channel of its old value, from the index (`K#<table>#<column>` / key → value
  hash), so a row that moves to another value leaves the old shapes, and deletes
  (which carry only the key) reach the shapes that held the row,
- the table's `*` channel when the old value is unknown (a row last written before
  the column was routed); every routed shape also listens on `*`,
- and always the table's channel, for unrouted shapes and subquery dependents.

Then it records the new value hashes and forgets deleted keys. Channel names and the
index hold only HMACs of values. Concurrent batches on different shards can record
an index entry out of order; the next write to that row, or the 5-minute safety
reconcile, corrects it.

### Bell subscription before load

A shape subscribes to its bells first and loads once the subscriptions are confirmed
(`subscribe_success`, or a 2 s timeout), so a write between the load and the
subscription can't ring unheard. After a reconnect, the shape reconciles once the
subscription is confirmed again.

### Client performance

- `rows` is replaced, not mutated, on each change, but not rebuilt: the
  `ShapeStore` in data-common patches a copy of the previous array by position
  for updates and inserts (one `slice()` plus O(changed)). Deletes, and batches
  larger than a quarter of the rows, rebuild. The array is built on read when
  nothing is subscribed.
- Bucket digests are cached and recomputed only for changed buckets.
- A full reconcile is parsed one bucket line at a time, only rows whose hash
  changed are parsed, and the client yields to the main thread every 300 rows
  (`scheduler.yield()` or a MessageChannel hop).

Measured locally (Chromium, 2 concurrent writers, 10 s): lookup p99 ≤ 100 ns
(the timer's resolution), main thread blocked ≤ 0.2 ms at p99.9 with 2k, 10k, and
50k rows. With 50k rows, the first load's longest slice is about 1.6 ms.

### When a shape syncs

| Trigger | Mode |
|---|---|
| First use (`ready`, `subscribe`), after the bells are confirmed | Full reconcile (empty digests get every bucket); changes-only: nothing to load |
| `requestSnapshot(query)` | Snapshot |
| An API call that wrote to the table, before it resolves | Own write, with the keys in its sync hint; full if a write was not tracked |
| Bell message | Bell, with the keys it carries; full if it carries none |
| Bell socket reconnect | Full reconcile (bells may have been missed) |
| Timer: 5 min (3 s without a bell) | Full reconcile (safety net) |

Concurrent triggers share one request: a trigger that arrives during a request queues
for the next one, which starts after the current one ends. If any queued trigger
needs a full reconcile, the next pass is a full reconcile, which covers the others.

### The bell: Aurora DSQL CDC

```
DSQL commit → CDC stream → Kinesis (1 shard) → app Lambda (event source)
            → Realtime publish  bell/{table}  { t: commitMs } → open shapes sync
```

- CDC captures every table in the cluster. `BellFolder` keeps records whose
  `source.schema`.`source.table` is in `sync.tables`, and folds one Lambda
  invocation's records into one bell per table (`BellBatcher`: core calls the handler
  per record in the same tick; all calls await one flush).
- **Ordering and duplicates:** CDC is unordered and at least once. A shape never
  applies a CDC record; it reads current state. A duplicate or late record only
  causes one extra sync with no difference. Last-writer-wins and tombstones are not
  needed, because DSQL itself is the source of truth.
- **Oversized records:** DSQL splits records over 9 MiB into a `chunked` main record
  and `fragment` records. The main record carries `source`, so it rings its table;
  fragments are skipped. Images are never reassembled. (A DSQL row is at most
  2 MiB, so this does not happen today.)
- **Event source:** `StartingPosition: LATEST` (older records carry nothing a client
  needs), batch size 1,000, no batching window, 2 retries, maximum record age
  5 minutes. A failure cannot block the shard for long; a lost bell is caught by the
  safety sync.
- Bells carry the commit time and the changed keys, sealed (see above). They never
  carry values, and other clients cannot read the keys. They do show that the
  table changed.
- Keys come from the record's `after` image (inserts, updates) or `before` (deletes,
  primary-key columns only), using the table's primary key from
  `information_schema`. A key JSON cannot hold exactly (an `int8` beyond 2^53) or a
  `chunked` record without inline images sends the bell without keys.

### Infrastructure

| Resource | Notes |
|---|---|
| `AWS::Kinesis::Stream` | Provisioned, `sync.shards` (default 1), 24 h retention, `aws/kinesis` key, `MaxRecordSizeInKiB: 10240` (DSQL requires it; set as a property override so older `aws-cdk-lib` versions work) |
| CDC service role | Trusts `dsql.amazonaws.com` with `aws:SourceAccount` = this account and `aws:SourceArn` = `cluster/{id}/stream/*`. Allows only `PutRecord(s)`, `DescribeStreamSummary`, `ListShards` on the one stream. No KMS grant (AWS-managed key) |
| `Custom::DsqlCdcStream` | CloudFormation has no CDC stream resource. `cdc-stream-lambda.ts` calls `CreateStream` (`UNORDERED`, `JSON`; `clientToken` from the request id; retries `ValidationException` for up to 60 s while the new role propagates) and `DeleteStream`; `isComplete` polls `GetStream` until `ACTIVE` (or gone on delete). Fails on `FAILED`/`IMPAIRED`. The creator may only `iam:PassRole` the CDC role, only to DSQL. Bundles `@aws-sdk/client-dsql`, because the Lambda runtime SDK may predate the stream APIs. Depends on the migration resource, so tables exist first |
| Kinesis event source | On the block's Lambda compute; grants read on the stream to the execution role |
| `Realtime` (`sync-bell`) | Shared per-stack WebSocket API. Channel `bell/{table}` |
| `AppSetting` (`sync-token-secret`) | SSM SecureString; the token key is derived from it (`deriveTokenKey`) |
| `RawRoute` `POST /aws-blocks/sync/{ids}/v1/shape` | Registered at synth too, so Hosting routes it |

### Idle cost (us-west-2)

| Part | Idle per month |
|---|---|
| Kinesis, 1 provisioned shard | ~$10.95 ($0.015/shard-hour) |
| Aurora DSQL CDC | $0 (billed in DPUs per change) |
| Lambda event source polling | $0 |
| WebSocket API, connections table | $0 |
| SSM standard parameter | $0 |

### Scale envelope

- Bells and own writes cost O(changed rows) on the server and in the browser. Full
  reconciles cost O(shape) on the server; they run on first load, reconnect, every
  5 minutes, after untracked writes, and after changes too large for a bell.
- Each write to a synced table makes every open shape on that table read the
  changed keys once (bells are per table). Many clients on per-user shapes of one
  table each pay one small keyed read per write. A future version can route bells by
  an equality term in the filter (for example `owner_id = $1`); CDC delete records
  carry only the key, so deletes would still go to the whole table.

## Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| No real OCC conflicts | Single-connection PGlite has no concurrency | `simulateConflict()` test helper |
| PGlite supports JSONB columns | DSQL rejects JSONB as a column type (use JSON instead; JSONB available as runtime cast only) | Validator rejects JSONB in DDL |
| System collation vs C only | String sorting may differ | Reject explicit COLLATE |
| No 60-min connection timeout | Dev sessions are short | Document only |
| No 10 MiB / 5-min tx limits | Impractical to measure locally | Document only |
| CREATE INDEX ASYNC is synchronous | Index immediately available locally | Log warning |
| Sync bell: app writes ring at once; no CDC stream | Local bells are immediate (AWS: ~0.5–1.5 s CDC + Kinesis poll). Row triggers on PGlite record the changed keys (DSQL has no triggers; app SQL still cannot create them). Writes that bypass `db` ring at the next write through `db` | The request modes are identical; CDC folding and key extraction have unit tests with synthetic records |
| Sync bell: no out-of-order or duplicate records | Local delivery is exact | Sync never depends on order: unit tests cover duplicates and late records |
| Mock change capture includes the full row for every write | Same as CDC (`after` for inserts/updates, key only for deletes) | Routing reads the same fields locally and on AWS |

## Connection Management

DSQL uses IAM token authentication:
- **App Lambda**: `DsqlSigner.getDbConnectAuthToken()` (DML only)
- **Migration Lambda**: `DsqlSigner.getDbConnectAdminAuthToken()` (DDL)
- `pg.Pool` with password callback (fresh token per connection)
- 60-min connection timeout — transparent to Lambda (short-lived)
- No secrets, no VPC, no proxy needed

## Relationship to data-common

`bb-distributed-data` uses `DatabaseBase` from `data-common` directly (no subclass). Error translation is in the engine. This is the cleaner pattern — `bb-data` subclasses `DatabaseBase` only because it adds RLS support.

Shared from `data-common`:
- Sync: `Shape` types, shape tokens (`@aws-blocks/data-common/sync`), `ShapeStore` (`./sync-shared`), the shape middleware and hint routing (`./sync-client`), `classifyWrite()`
- `DatabaseEngine` / `DatabaseBase` / `TransactionHandle`
- `sql` / `SqlQuery` / `unwrapQuery`
- `createKyselyAdapter`
- `splitStatements`

DSQL-specific (not shared):
- `validateStatement` / `classifyStatement` / `TransactionTracker`
- `validateMigrations`
- `DsqlEngine` / `DsqlMockEngine`
- `DistributedDatabaseErrors`
- OCC retry logic
