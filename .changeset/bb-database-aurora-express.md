---
"@aws-blocks/bb-database": minor
---

`DatabaseCluster` gains `type: 'aurora'`: Aurora PostgreSQL Serverless v2 created with the express configuration. The cluster is created in seconds together with its writer instance, runs outside any VPC behind an internet access gateway, scales to zero (`minCapacity: 0`, the default) and is reached with IAM authentication only; the master user has no password and the app connects as its own database role with a short-lived token. `minCapacity` and `maxCapacity` set the ACU range, `pointInTimeRecovery` the backup window, and `removalPolicy` accepts `'snapshot'`.

Blocks on an `aurora` cluster get all of PostgreSQL: triggers, PL/pgSQL, extensions, Row Level Security, transactions of any size. Their migration files are PostgreSQL and run as written, one transaction per file; `dsql-lint` and the DSQL transaction limits apply to `dsql` clusters only, locally and on AWS. An `aurora` migration file that carries a DSQL-only form (`ASYNC`, `sys.wait_for_job()`) is stopped before it runs, with a message that names the file and what to change; the error for a rejected migration file is now `MigrationValidationError` for both kinds. `npm run dev` prints one line per migration run that applied files, naming the schema and the data directory. `db.cluster.kind` is now `'dsql' | 'aurora'`. `DsqlDatabaseOptions` is renamed `SharedDatabaseOptions`.

Storage is encrypted with an AWS-owned key; the express configuration accepts no customer managed KMS key.
