# @aws-blocks/data-common

Shared abstractions for SQL database Building Blocks. Internal package — do not depend on this directly. Use `@aws-blocks/bb-data` or `@aws-blocks/bb-distributed-data` instead.

Provides:
- `DatabaseEngine` interface (implemented by all SQL engines)
- `DatabaseBase` class (query/execute/transaction delegation)
- `sql` tagged template (injection-safe parameterized queries)
- `SqlQuery` branded type
- `createKyselyAdapter()` (Kysely backed by any DatabaseEngine)
- `runMigrations()` / `loadMigrationsFromDir()` (generic migration runner)
- `Transaction` / `SqlDatabase` interfaces
- `classifyWrite()` (which synced table a SQL statement writes, for read-your-writes)
- Live sync (`db.shape()`), shared by `Database` and `DistributedDatabase`:
  - `Shape` / `ShapeOptions` / `ShapeDescriptor` types
  - `./sync` (Node): shape validation and signed tokens
  - `./sync-shared` (browser-safe, no side effects): `ShapeStore`, the base class of every client shape
  - `./sync-client` (browser): the response middleware that hydrates shapes (each block registers its protocol with `registerShapeProtocol()`) and hands `data/sync` response hints to open shapes before an API call resolves (read-your-writes)
