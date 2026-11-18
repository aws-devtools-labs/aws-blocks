---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

`sandbox` and `deploy` no longer copy a `*_DB_URL` or `*_CONNECTION_STRING` environment variable to the SSM parameter `/<stackName>-db-url`. `cdk-blocks db connect --stage <stage>` stores the connection string of a `Database` on an existing database, after it has checked the database; an environment value written on every deploy replaced what that command stored. A parameter that an earlier deploy wrote stays in SSM and is still read with `DatabaseCluster.fromExisting({ name: 'db-url' })`.

`ensureSecrets` is not exported from `@aws-blocks/core/scripts` and `@aws-blocks/blocks/scripts` any more.
