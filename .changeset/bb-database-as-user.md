---
"@aws-blocks/bb-database": minor
---

`Database.asUser(user, claims?)` returns the block with every statement run as one user, for tables with Row Level Security on an `aurora` cluster. Each transaction on it starts by setting `request.jwt.claims` to `{ ...claims, sub: user.userId }` for that transaction only, so a policy such as `USING (owner_id = current_setting('request.jwt.claims', true)::jsonb ->> 'sub')` gives each user their own rows. `query`, `queryOne`, `execute`, `transaction` and Kysely (`new DatabaseDialect(db.asUser(user))`) all run as the user, locally and on AWS. The result of an auth block's `requireAuth()` passes as it is.

A write that a policy refuses fails with the new `DatabaseErrors.PermissionDenied` (HTTP 403). A statement on the block itself carries no user and reads no rows from a table whose policy compares with `sub`. `asUser()` throws `DatabaseConfigurationError` on a `dsql` cluster.

A Kysely transaction's isolation level is now set by the engine, and `BEGIN` is tried once more when its pooled connection was closed while idle.
