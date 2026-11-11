---
"@aws-blocks/bb-data": minor
"@aws-blocks/blocks": minor
---

fix(bb-data): enforce `rlsPolicy: 'enforce'` in `db.crud()` and refuse tables without row-level security

`db.crud()` handlers run as the `authenticated` role inside `withRLS()`, so row-level security (RLS) is the only thing that limits a caller to their own rows. On a table without RLS, every signed-in user could read, change and delete every row through CRUD. `rlsPolicy: 'enforce'` was documented as applying to `db.crud()`, but no code read it.

- **`rlsPolicy: 'enforce'` now takes effect.** Before its first read or write, each CRUD handler checks the live table (once per table per connection, then cached). If RLS is not enabled, or the `authenticated` role is exempt from it (it owns the table without `FORCE ROW LEVEL SECURITY`, or has `BYPASSRLS`), the call fails with the new `DatabaseErrors.RowLevelSecurityRequired` and runs no query. The server log names the table and the `ALTER TABLE … ENABLE ROW LEVEL SECURITY;` to run; the client sees only the error name and a fixed message. The check runs the same way locally and on AWS.
- **New `rowLevelSecurity` field on `TableMetaEntry`.** `db pull` now writes it for every generated table. `true` makes CRUD check the live table as above, so a table whose RLS was disabled after the metadata was generated is refused. `false` refuses the table.
- **New `dangerouslyAllowWithoutRowLevelSecurity` option on `db.crud()`.** Lists the tables to serve without RLS on purpose; they skip the check, including under `rlsPolicy: 'enforce'`. An explicit `USING (true)` policy remains the preferred way to share a table with every signed-in user.
- **Metadata without `rowLevelSecurity` and no `rlsPolicy`** keeps working as before, and now logs a warning once per table when the live table has no RLS.
- The generated migration guide no longer mentions an `rlsPolicy: 'bypass'` value, which never existed.

**Behavior change:** an app that sets `rlsPolicy: 'enforce'` (the wiring `db pull` generates does) and serves a table without RLS through `db.crud()` now gets `RowLevelSecurityRequired` for that table. Enable RLS and add policies for it in a migration, or list it in `dangerouslyAllowWithoutRowLevelSecurity` if it is meant to be shared with every signed-in user.
