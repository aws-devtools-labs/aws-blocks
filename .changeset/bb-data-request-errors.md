---
"@aws-blocks/bb-data": minor
---

`Database` now reports request errors as named 4xx errors instead of a generic 500 `QueryFailed`, on the local (PGlite), `pg` and Data API engines:

| Postgres error | SQLSTATE | Error | HTTP status |
|---|---|---|---|
| Row-level-security rejection, or no grant for the role | `42501` | `DatabaseErrors.PermissionDenied` | 403 |
| Check constraint | `23514` | `DatabaseErrors.CheckViolation` | 400 |
| Not-null constraint | `23502` | `DatabaseErrors.NotNullViolation` | 400 |
| Foreign key | `23503` | `DatabaseErrors.ForeignKeyViolation` | 409 |

Match them with `isBlocksError(e, DatabaseErrors.PermissionDenied)` and so on, on the server or the client. Each carries a fixed message; the driver text stays on the server as `cause`. None is retriable.

If your code matched these failures with `isBlocksError(e, DatabaseErrors.QueryFailed)`, match the new names instead.
