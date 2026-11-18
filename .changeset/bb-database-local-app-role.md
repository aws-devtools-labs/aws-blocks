---
"@aws-blocks/bb-database": minor
---

Local mode runs a block's statements as a plain database role with the grants the deployed app role gets; migrations run as the admin. PostgreSQL now refuses the same statements under `npm run dev` as on AWS: DDL and `TRUNCATE` outside a migration, and reads of the migration ledger, fail with `QueryFailed`. A Row Level Security policy on a table of an `aurora` cluster applies to the block's statements locally as it does on AWS.

Changed locally: DDL in a handler fails as `QueryFailed`, the name it has on AWS, where it was `DatabasePermissionException`; the `_migrations` and `_migration_progress` tables are no longer readable from application code. An existing `.bb-data` directory needs no reset.
