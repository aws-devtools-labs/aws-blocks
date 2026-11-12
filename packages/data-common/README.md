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

`@aws-blocks/data-common/core` has every export above except `createKyselyAdapter()`. A block that imports from it does not load Kysely; `@aws-blocks/bb-database` does this.
