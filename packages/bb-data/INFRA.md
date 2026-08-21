# bb-data Infrastructure

## Current Architecture

`Database` uses different engines for local development and deployed workloads:

- **Local development:** PGlite (WASM PostgreSQL) persists data under `.bb-data/`; no AWS resources are required.
- **AWS-provisioned database:** `Database` provisions Aurora Serverless v2 and accesses it through the RDS Data API.
- **Existing database:** `Database.fromExisting({ connectionString })` uses the PostgreSQL client engine for a database the application already owns, such as Supabase or Neon.

The AWS-provisioned path is the default when no `connection` option is supplied.

## AWS-Provisioned Database

The CDK layer creates:

- Aurora Serverless v2 PostgreSQL with the RDS Data API enabled
- an isolated VPC and security group for the cluster
- a Secrets Manager secret for database credentials
- runtime configuration for the cluster ARN, secret ARN, and database name
- IAM permissions for the application execution role to use the Data API and read the generated secret

The application Lambda does not open a PostgreSQL connection to the cluster and this construct does not create an RDS Proxy. The RDS Data API manages request access to Aurora without placing the application Lambda in the database VPC.

## Migrations

When `migrationsPath` is configured, the CDK layer adds a Lambda-backed CloudFormation custom resource. It packages the SQL migration files, runs pending migrations during deploy, and records applied files in the `_migrations` table. The custom resource waits for the Aurora writer instance before it runs.

In local development, migrations run against PGlite before the first query. See [README.md](./README.md#migrations) for the migration workflow.

## Existing PostgreSQL Databases

`fromExisting({ connectionString })` is for a database managed outside this Building Block. The runtime uses the PostgreSQL client engine and the application owner remains responsible for network access, connection pooling or proxying, and the database lifecycle. TLS verification is enabled by default; see [README.md](./README.md#tls-certificate-verification) for the required CA configuration.

## Future Work

The block does not currently provision a managed direct-connection architecture such as an RDS Proxy, VPC-connected application Lambda, or `LISTEN`/`NOTIFY` support. Those would be separate capabilities from the existing Aurora Data API path.
