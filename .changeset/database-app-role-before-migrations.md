---
"@aws-cdk-blocks/bb-database": patch
"aws-cdk-blocks": patch
---

A migration on a cluster that `Database` provisions can now grant a role to the app's database role, so `asRole()` works after the first deploy. The migration function used to create the app role after the migration files ran, so on the first deploy of a cluster a file with `GRANT authenticated TO "blocks_app_…"` failed with `role … does not exist`, and every `asRole()` call failed with `DatabaseConfigurationError` until a second deploy. The function now creates the role and maps it to IAM before the files run, and grants it access to the block's tables, views and sequences after them. The privileges are the same as before.

A migration file names the app role with `${app_role}`. Before the file runs it is replaced with the quoted name of the role the app's statements run as: `blocks_app_{cluster}` on AWS, `blocks_app_local` in local mode, and the connection role on an existing database. One file then works in every place: `GRANT authenticated TO ${app_role};`. No other text in a file is replaced, and the file's hash is of the text as written.

`getSdkIdentifiers(db)` returns `roleName`, the PostgreSQL role the block connects as, on a cluster the block provisions. A block on `DatabaseCluster.fromExisting()` or a `LegacyDatabaseCluster` has none.

When PostgreSQL refuses the switch of `asRole()`, the function's log now names the migration to add, `GRANT "<role>" TO ${app_role};`, instead of `GRANT "<role>" TO CURRENT_USER;`, which the app cannot run and which in a migration grants to the cluster admin.
