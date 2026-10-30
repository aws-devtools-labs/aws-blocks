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

The `@aws-blocks/data-common/internal` entry also provides first-party PGlite
process helpers and `PgliteTransaction`, which adapts PGlite's callback
transactions to the engines' begin/commit/rollback handles. These helpers use
structural types and do not add a runtime dependency on PGlite. They are not
part of the public package-root API.
