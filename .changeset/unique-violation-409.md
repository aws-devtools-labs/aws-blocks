---
"@aws-blocks/bb-distributed-data": minor
"@aws-blocks/bb-data": minor
"@aws-blocks/blocks": patch
---

fix(data): map duplicate-key unique-constraint violations to JSON-RPC 409 (Conflict) instead of 500

A duplicate-key / unique-constraint violation (SQLSTATE `23505`,
`UniqueConstraintViolation`) now surfaces to clients as JSON-RPC error
**code 409 (Conflict)** instead of a generic **500**. Previously the engine
translators set `error.name` on the raw driver error and re-threw a plain named
`Error`; the JSON-RPC serializer maps any non-`ApiError` to 500, so a routine,
expected duplicate-key conflict was indistinguishable from an internal server
error. This mirrors the `40001`/OCC → 409 mapping already established for these
Blocks.

Each affected conflict is now an `ApiError` with `status: 409`, so on the client
`error.status === 409`. The structured `error.name` is preserved end-to-end, so
`isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)` (and the
`DistributedDatabaseErrors` equivalent) keeps matching by name on both server and
client; the typed error constants are unchanged.

- `@aws-blocks/bb-data` — a duplicate-key violation (SQLSTATE `23505`,
  `DatabaseErrors.UniqueConstraintViolation`) across the PGlite, pg-client, and
  Data API engines (both the SQLState-parsed and message-matched Data API paths),
  routed through a shared `uniqueConstraintConflict()` helper.
- `@aws-blocks/bb-distributed-data` — a DSQL duplicate-key violation (SQLSTATE
  `23505`, `DistributedDatabaseErrors.UniqueConstraintViolation`) in
  `translateDsqlError`, in both the mock and real engines.

The conflict is **not** flagged `retriable`: a duplicate key is deterministic, so
a blind retry of the same insert fails identically (unlike the `40001`
serialization failures, which stay retriable). The client-visible message is a
fixed, stable string; the raw driver text (which can name columns / constraints)
is retained only as `cause` for server-side diagnostics. Genuine infrastructure
errors (`ConnectionFailed`, `QueryFailed`) are unchanged and correctly stay 500,
and the `SerializationFailure`/OCC paths are untouched.

This is a `minor` bump. Both data packages are pre-1.0, where `minor` is this
repo's signal for a change that can alter existing behavior: callers that
branched on `error.status === 500` for these conflicts (or on the JSON-RPC error
code) will now see `409`. Code that matches conflicts by name via
`isBlocksError` — the documented pattern — is unaffected.

`@aws-blocks/blocks` gets a `patch` bump because it re-exports `bb-data` and
`bb-distributed-data` (satisfies the umbrella publish guard); no umbrella source
changed.

Fixes #508.
