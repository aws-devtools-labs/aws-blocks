# Required @aws-blocks Building Blocks

All Building Blocks are imported from `@aws-blocks/blocks`. The implementation must route the task's core behavior through the real block API below — not an in-memory Map/array, a hardcoded result, or an inline stub.

- AuthOIDC — gates the app behind OIDC sign-in using the `stubIdp({ name: 'stub' })` provider and the server-redirect signin route. Expect `new AuthOIDC(scope, 'auth', { providers: [stubIdp(...)] })`, `auth.createApi()`, and `auth.requireAuth(context)` scoping the note API.
- DistributedDatabase — the SQL-over-DSQL store for per-user notes. NOTE: the block is exported as `DistributedDatabase` (there is NO `DsqlDatabase` export). Expect `new DistributedDatabase(...)` with a `.sql` migration plus **parameterized** `db.query(...)` / `db.execute(...)` built with the `sql` tagged template.
