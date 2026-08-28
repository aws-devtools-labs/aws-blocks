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

The seed fixtures in this directory are **transcribed** from the message/name
shapes already asserted in `src/engines/data-api-engine.test.ts` and the
documented RDS Data API error format. They are **not yet literal captures from a
live cluster** — so at this point the corpus buys structure and drift-visibility,
not higher fidelity than the tests it replaces.

To actually close the drift gap, regenerate them from a real cluster:

```
RESOURCE_ARN=arn:aws:rds:... \
SECRET_ARN=arn:aws:secretsmanager:... \
DATABASE=postgres \
AWS_REGION=... \
npx tsx scripts/capture-data-api-errors.ts
```

`scripts/capture-data-api-errors.ts` provokes each error class against the
cluster, records the raw `name`/`message`, and writes `*.captured.json` files
here for review. Some cases (e.g. a `minCapacity: 0` cluster resuming from
auto-pause) require the cluster to be in a specific state — see the script's
header for details. Once captured, promote a `*.captured.json` to the fixture it
supersedes and update its `provenance`.
