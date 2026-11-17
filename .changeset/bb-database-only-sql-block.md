---
"@aws-blocks/blocks": minor
"@aws-blocks/bb-database": minor
"@aws-blocks/core": minor
"@aws-blocks/create-blocks-app": minor
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-auth": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/admin-ui": patch
---

feat!: `Database` from `@aws-blocks/bb-database` is the only SQL Building Block

**Breaking change.** `@aws-blocks/blocks` exports `Database`, `DatabaseCluster`, `DatabaseErrors` and `sql` from `@aws-blocks/bb-database`. The packages `@aws-blocks/bb-data`, `@aws-blocks/bb-distributed-data` and `@aws-blocks/data-common` are not part of AWS Blocks any more. There is no compatibility layer.

```ts
import { Database, DatabaseCluster, sql } from '@aws-blocks/blocks';

const orders = new Database(scope, 'orders'); // owns an Aurora DSQL cluster

const cluster = new DatabaseCluster(scope, 'main', { type: 'aurora' }); // Aurora PostgreSQL Serverless v2
const users = new Database(scope, 'users', { cluster });
```

- **`Database`** owns an Aurora DSQL cluster when it has no `cluster` option. A `DatabaseCluster` of type `'dsql'` or `'aurora'` holds several `Database` blocks, each in its own schema. Migrations are ordered `.sql` files in `aws-blocks/migrations/<id>/`.
- **Not exported any more:** `DistributedDatabase`, `DistributedDatabaseErrors`, `DistributedDatabaseOptions`, `fromExisting` (external PostgreSQL), `ExternalDatabaseRef`. `withRLS()`, `crud()` and the `bb-data` command line tool have no equivalent in `@aws-blocks/bb-database`. For Kysely, use `DatabaseDialect` from `@aws-blocks/bb-database/kysely`.
- **`cdk-blocks db`** is not a command any more. Migrations run on the first statement in local mode and during the deploy on AWS.
- **`getSdkIdentifiers(db)`** returns `clusterId` and `schemaName`, plus `clusterEndpoint` and `region` in a deployed Lambda. `getSdkIdentifiers(cluster)` returns `clusterEndpoint`.
- **Data is not moved.** A `Database` in an app that upgrades is a new block with a new cluster. Export the data of the old cluster before you deploy.
- **`@aws-blocks/core`:** `npm run dev`, `sandbox` and `deploy` do not apply migrations to an external database before they run.
- **`@aws-blocks/create-blocks-app`:** the `sql` and `demo` templates use the new `Database` on its default Aurora DSQL cluster, with migrations in `aws-blocks/migrations/<id>/`. The templates' `cdk.json` has no `@aws-blocks/bb-data:encryptStorageByDefault` context key.
- **`@aws-blocks/bb-database`:** the CDK `Database` records itself as the `Database` Building Block of the stack.
