# RDS Data API error fixtures

A corpus of RDS Data API error shapes (`name` + `message`) paired with the
`DatabaseErrors` name that `DataApiEngine` should classify each one as. The
table-driven test `src/engines/data-api-error-fixtures.test.ts` drives every
fixture through the real `DataApiEngine.execute` path and asserts the resulting
`error.name`.

## Why this exists

`DataApiEngine.translateError` classifies errors by reading `error.name` and
matching a `SQLState:` pattern in `error.message`. Both of those strings are
produced by the AWS SDK / the RDS Data API — the one thing a hand-built
`new Error(...)` in a unit test cannot reproduce faithfully. When the SDK
renames an exception or the service changes a message format, hand-built tests
keep passing while production classification silently drifts.

Keeping the corpus as data (not inline `new Error()` calls) makes that drift a
reviewable diff: regenerate the fixtures against a real cluster, and any change
to a real error's `name`/`message` shows up as a file change that either still
classifies the same way or breaks the test.

## Fixture format

Each `*.json` file is one error case:

```json
{
  "name": "ServiceUnavailableException",
  "message": "Service is unavailable. Please try again later.",
  "expected": "ConnectionFailed",
  "provenance": "..."
}
```

- `name` — the thrown error's `.name` (SDK exception name).
- `message` — the thrown error's `.message`, verbatim.
- `expected` — a key of `DatabaseErrors` (`src/errors.ts`): `QueryFailed`,
  `ConnectionFailed`, `TransactionFailed`, `UniqueConstraintViolation`, or
  `SerializationFailure`.
- `provenance` — where this `name`/`message` pair came from, so a reviewer can
  judge its fidelity.

## Fidelity status — read this

Each fixture's `provenance` field records how it was obtained. Two tiers exist:

- **Captured** — `syntax-error-42601`, `undefined-table-42p01`, and
  `unique-constraint-sqlstate-23505` are literal captures from a live Aurora
  PostgreSQL 17.7 Serverless v2 cluster over the RDS Data API (us-west-2,
  2026-08-28).
- **Constructed** — the remaining fixtures (`serialization-failure-40001`,
  `connection-failure-08006`, `unique-constraint-message`, `service-unavailable`,
  `internal-server-error`) were not provoked during that capture. They cover
  classification paths that need a specific cluster state (a serializable
  conflict, a connection drop, a service-level outage) or a no-SQLState message.
  Their `expected` mapping is exercised; their exact `name`/`message` strings are
  best-effort.

The capture already earned its keep: real statement errors arrive with
`name` **`DatabaseErrorException`** and a `Position:` segment in the message —
not the `BadRequestException` shape the first-cut fixtures assumed. Classification
is unaffected (it keys off the `SQLState:` suffix), but that is exactly the drift
a captured corpus makes visible. The constructed fixtures were updated to the
observed `DatabaseErrorException` name for consistency.

To extend or refresh the corpus, capture from a real cluster:

```
RESOURCE_ARN=arn:aws:rds:... \
SECRET_ARN=arn:aws:secretsmanager:... \
DATABASE=appdb \
AWS_REGION=... \
npx tsx scripts/capture-data-api-errors.ts
```

`scripts/capture-data-api-errors.ts` provokes each error class against the
cluster, records the raw `name`/`message`, and writes `*.captured.json` files
here for review. Some cases (e.g. a `minCapacity: 0` cluster resuming from
auto-pause) require the cluster to be in a specific state — see the script's
header for details. Once captured, promote a `*.captured.json` to the fixture it
supersedes and update its `provenance`.
