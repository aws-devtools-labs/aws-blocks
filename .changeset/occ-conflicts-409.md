---
"@aws-blocks/bb-kv-store": minor
"@aws-blocks/bb-distributed-table": minor
"@aws-blocks/bb-distributed-data": minor
"@aws-blocks/bb-data": minor
---

fix(data): map optimistic-concurrency conflicts to JSON-RPC 409 (Conflict) instead of 500

Optimistic-concurrency / conditional-write conflicts now surface to clients as
JSON-RPC error **code 409 (Conflict)** instead of a generic **500**. Previously
these conflicts were thrown as plain named `Error`s (or re-thrown raw driver
errors), and the JSON-RPC serializer maps any non-`ApiError` to 500 — so a
routine, expected conflict was indistinguishable from an internal server error.

Each affected conflict is now an `ApiError` with `status: 409`, so on the client
`error.status === 409`. The structured `error.name` is preserved end-to-end, so
`isBlocksError(e, ...)` keeps matching by name on both server and client, and the
existing typed error constants are unchanged:

- `@aws-blocks/bb-kv-store` — a failed `ifNotExists` / `ifExists` /
  `ifValueEquals` write or delete (`KVStoreErrors.ConditionalCheckFailed`). The
  AWS runtime now also normalizes DynamoDB's raw `ConditionalCheckFailedException`
  on both `put` and `delete`, matching the mock.
- `@aws-blocks/bb-distributed-table` — a failed `ifNotExists` / `ifExists` /
  `ifFieldEquals` condition (`DistributedTableErrors.ConditionalCheckFailed`),
  in both mock and AWS `put`/`delete`.
- `@aws-blocks/bb-distributed-data` — a DSQL serialization failure / OCC
  conflict, SQLSTATE `40001` (`DistributedDatabaseErrors.SerializationFailure`),
  in both the mock and real engines.
- `@aws-blocks/bb-data` — a serializable-isolation conflict, SQLSTATE `40001`
  (`DatabaseErrors.SerializationFailure`), across the PGlite, pg-client, and
  Data API engines.

The `retriable` flag is scoped to genuine optimistic-lock conflicts: it is
`true` for value/field-equals conflicts (`ifValueEquals` / `ifFieldEquals`) and
the 40001 serialization failures, and omitted/`false` for existence/uniqueness
assertions (`ifNotExists`, `ifExists`), where a blind identical retry would fail
identically. Status (409) and `error.name` are unchanged in every case.

This is a `minor` bump. Every package here is pre-1.0, where `minor` is this
repo's signal for a change that can alter existing behavior: callers that
branched on `error.status === 500` for these conflicts (or on the JSON-RPC error
code) will now see `409`. Code that matches conflicts by name via
`isBlocksError` — the documented pattern — is unaffected.
