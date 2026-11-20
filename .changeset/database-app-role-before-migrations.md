---
"@aws-cdk-blocks/bb-database": patch
"aws-cdk-blocks": patch
---

`asRole()` now works after the first deploy of a cluster that `Database` provisions. The app's database role is created before the migration files run, so a migration can grant a role to it. Before, that grant failed with `role … does not exist`, and `asRole()` failed until a second deploy.

In a migration file, write the app role as `${app_role}`, for example `GRANT authenticated TO ${app_role} WITH INHERIT FALSE, SET TRUE;`. It resolves to the role that the app's statements run as on AWS, in local mode, and on an existing database. `getSdkIdentifiers(db)` now returns that role as `roleName` on a cluster the block provisions.
