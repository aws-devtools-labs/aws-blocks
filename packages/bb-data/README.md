# @aws-blocks/bb-data

Full PostgreSQL database — provisions Aurora Serverless v2 by default, or connects to an existing PostgreSQL database (Supabase, Neon, etc.) via `fromExisting()`. Full relational modeling with foreign keys, transactions, Row Level Security, and a type-safe Kysely query builder.

**When to use:** Complex multi-table JOINs, ACID transactions, foreign key constraints, aggregations, Row Level Security, or connecting to an existing PostgreSQL database. Use when you need the full power of PostgreSQL.

**When NOT to use:** For simple key-value lookups, use `KVStore`. For NoSQL with secondary indexes, use `DistributedTable`. For serverless SQL without FK/RLS/triggers (multi-region, instant provisioning), use `DistributedDatabase`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick Start

```typescript
import { Database, sql } from '@aws-blocks/bb-data';

const db = new Database(scope, 'main', {
  migrationsPath: './aws-blocks/migrations',
});

// Parameterized queries via sql tagged template (injection-safe)
const users = await db.query<{ id: string; name: string }>(
  sql`SELECT * FROM users WHERE active = ${true}`
);

const user = await db.queryOne<{ id: string; name: string }>(
  sql`SELECT * FROM users WHERE id = ${userId}`
);

const { rowCount } = await db.execute(
  sql`INSERT INTO users (id, name, email) VALUES (${id}, ${name}, ${email})`
);

// Transactions
await db.transaction(async (tx) => {
  await tx.execute(sql`UPDATE accounts SET balance = balance - ${100} WHERE id = ${fromId}`);
  await tx.execute(sql`UPDATE accounts SET balance = balance + ${100} WHERE id = ${toId}`);
});
```

## Migrations

Create numbered `.sql` files in a migrations directory:

```
aws-blocks/migrations/
  001_create_users.sql
  002_create_posts.sql
  003_seed_admin.sql
```

```sql
-- 001_create_users.sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Migrations run automatically:
- **Local dev:** On first query (PGlite, persists in `.bb-data/`)
- **AWS deploy:** Via a CustomResource Lambda during `cdk deploy`

Applied migrations are tracked in a `_migrations` table. Each file runs once.

> **Set `migrationsPath` to a path relative to your project root** (as in the Quick Start — `'./aws-blocks/migrations'`); it's resolved at synth from the directory you run `cdk` / `npm run deploy` in. That's the simplest reliable pattern.
>
> You don't need `fileURLToPath(import.meta.url)` for this. Your backend module runs as ESM locally but is bundled to **CommonJS** in Lambda, where `import.meta` is empty. AWS Blocks shims `import.meta.url` / `import.meta.dirname` in the bundle so it won't crash at load — but at runtime those resolve to the **bundled output** location, not your source tree. So don't use `import.meta.url` to read a file relative to your source at request time; inline the data or ship it as a Lambda asset instead.

## Kysely Query Builder

For type-safe queries without raw SQL:

```typescript
import { createKyselyAdapter } from '@aws-blocks/bb-data';

interface Schema {
  users: { id: string; email: string; name: string };
  posts: { id: string; user_id: string; title: string };
}

const kysely = createKyselyAdapter<Schema>(db);

// Type-safe SELECT
const users = await kysely
  .selectFrom('users')
  .where('email', '=', 'user@example.com')
  .selectAll()
  .execute();

// JOINs
const posts = await kysely
  .selectFrom('posts')
  .innerJoin('users', 'users.id', 'posts.user_id')
  .select(['posts.title', 'users.name'])
  .execute();

// Transactions
await kysely.transaction().execute(async (trx) => {
  await trx.insertInto('users').values({ id: '1', email: 'a@b.com', name: 'A' }).execute();
  await trx.insertInto('posts').values({ id: '1', user_id: '1', title: 'Hello' }).execute();
});
```

See [Kysely documentation](https://kysely.dev) for the full query builder API.

## Row Level Security (RLS)

Scope queries to a user context with Supabase-compatible session variables:

```typescript
const scoped = db.withRLS({ userId: 'user-123', role: 'authenticated' });

// All queries on `scoped` run inside a transaction with SET LOCAL ROLE
// and request.jwt.claims set — PostgreSQL RLS policies are enforced.
const myPosts = await scoped.query<Post>(sql`SELECT * FROM posts`);
```

`request.jwt.claims` always carries `sub` = `userId` and `role` = the `role` you pass. Extra `claims` are merged in, but they can't override those two: a `sub` or `role` key in `claims` is ignored. Policies can therefore trust both, for example `USING (owner_id = current_setting('request.jwt.claims', true)::jsonb ->> 'sub')`. When you forward claims from an identity provider, put provider-specific values under their own keys (for example `claims: { idp_sub: token.sub }`).

> **Prerequisite (local and AWS):** `withRLS` issues `SET LOCAL ROLE <role>` (default `authenticated`). The role must exist, and the database user must be a member of it. On PostgreSQL 16 and later, which Aurora runs, the user that creates a role gets only `ADMIN` on it, not `SET`, so grant the roles explicitly. Add to your migrations:
>
> ```sql
> CREATE ROLE authenticated;
> CREATE ROLE anon;
> GRANT authenticated TO CURRENT_USER;
> GRANT anon TO CURRENT_USER;
> -- grant table privileges to these roles as needed, then define RLS policies
> ```
>
> If the role switch is refused, every `withRLS()` call fails with a 500 `QueryFailed`, and the server log names the missing `GRANT`.

## CRUD Handlers

Generate typed CRUD methods from a schema definition:

```typescript
const crud = db.crud({
  tables: ['users', 'posts'],
  // `auth` takes no arguments — close over your request context to resolve the user.
  auth: async () => {
    const user = await auth.requireAuth(context);
    return { userId: user.userId };
  },
});

// Auto-generated flat method names per table:
//   crud.listUsers(), crud.getUser(id), crud.createUser(data),
//   crud.updateUser(id, data), crud.deleteUser(id)
//   crud.listPosts(), crud.getPost(id), ...
```

## Connecting to an Existing Database

```typescript
import { Database, fromExisting } from '@aws-blocks/bb-data';

// Supabase, Neon, or any PostgreSQL-compatible database
const db = new Database(scope, 'external', {
  connection: fromExisting({ connectionString: process.env.DATABASE_URL! }),
});
```

### TLS certificate verification

The server's TLS certificate is **verified by default**. Managed providers
(Supabase, Neon, RDS) present a certificate signed by a provider-specific CA
that is not in Node's built-in trust store, so verification requires pinning
that CA. `ssl.ca` takes the certificate **contents** (a PEM string), not a path —
for Supabase, download `prod-ca-2021.crt` from your project's **Database Settings
→ SSL Configuration**:

```typescript
import { readFileSync } from 'node:fs';

const db = new Database(scope, 'external', {
  connection: fromExisting({
    connectionString: process.env.DATABASE_URL!,
    ssl: { ca: readFileSync('./supabase-ca.crt', 'utf8') },
  }),
});
```

`bb-data pull` wires this for you: it prompts for your CA certificate and commits
it to `aws-blocks/database.ca.ts` (a public, non-secret cert that is bundled into
your deployed function), so the connection is **verified by default** — including
in the deployed Lambda, with no runtime configuration. `DATABASE_CA_CERT` (inline
PEM or a file path) overrides the committed cert. If neither is available, the
generated wiring falls back to `ssl: { rejectUnauthorized: false }` (**encrypted but
unauthenticated**) in local dev only; the **deployed function fails closed**
(refuses to connect) rather than running unverified. Provide the CA for production.

## Migrating from Supabase

Already have a Supabase app? `bb-data pull` connects to your existing Supabase database and generates a complete, type-safe backend — keeping your tables, data, and RLS policies exactly as they are.

```sh
npx bb-data pull
```

What it does:
- Introspects your public-schema tables (read-only — your database is not modified)
- Generates typed definitions, CRUD operations, and a personalized migration guide
- Generates CRUD only for tables that have a primary key and **row-level security enabled**. Generated CRUD relies on RLS to decide which rows each user can access, and PostgreSQL applies no row filtering to a table without it. Tables without RLS are skipped with a warning that shows the `ALTER TABLE … ENABLE ROW LEVEL SECURITY;` to run; add policies for the table in a migration and re-run to include it. A table with RLS enabled but no policies is generated, but Postgres denies every row until it has one, so `db pull` marks it `Action required`. To share a table with every signed-in user on purpose (a lookup table, say), make that explicit with `CREATE POLICY "shared" ON public.<table> FOR ALL TO authenticated USING (true) WITH CHECK (true);`
- Stores your connection string locally as `SUPABASE_DB_URL` in `.env.local` (encrypted in SSM on deploy). Only that entry is added or updated — other settings, comments, and the file's permissions are kept; the `SUPABASE_DB_URL` line itself is rewritten whole, so a comment at the end of it is not kept. If `.env.local` can't be updated safely (for example, the change would alter how another entry is read), `db pull` stops before generating any files and asks you to set the entry by hand. Choosing "production" does the same for `.env.production`.

What it does NOT migrate: Supabase Auth, Storage, Realtime, or Edge Functions. If you use a third-party OIDC provider (Auth0, Clerk, Google, Cognito), you can wire it into Blocks — see the generated `MIGRATION_GUIDE.md#auth`.

After pulling, run `npm run dev` to start developing locally against your real database.

Once pulled, manage schema changes with version-controlled SQL migrations in `./migrations/` — applied automatically on `npm run dev` and `npm run deploy`. See the generated `MIGRATION_GUIDE.md#evolving-your-schema`.

## Error Handling

```typescript
import { DatabaseErrors } from '@aws-blocks/bb-data';
import { isBlocksError } from '@aws-blocks/core';

try {
  await db.execute(sql`INSERT INTO users (id, email) VALUES (${id}, ${email})`);
} catch (e: unknown) {
  if (isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)) {
    // Duplicate key — email already exists. Serialized as HTTP 409 (Conflict),
    // not retriable (a blind retry of the same insert fails identically).
  }
  if (isBlocksError(e, DatabaseErrors.PermissionDenied)) {
    // Your statement was refused: a row-level-security policy rejected the row
    // (for example a withRLS() user writing someone else's row), or the role has
    // no grant on the table. Serialized as HTTP 403.
  }
  if (isBlocksError(e, DatabaseErrors.CheckViolation) || isBlocksError(e, DatabaseErrors.NotNullViolation)) {
    // A value fails a CHECK constraint, or a required column is missing.
    // Serialized as HTTP 400.
  }
  if (isBlocksError(e, DatabaseErrors.ForeignKeyViolation)) {
    // The referenced row doesn't exist, or other rows still reference the one
    // being deleted. Serialized as HTTP 409 (Conflict).
  }
  if (isBlocksError(e, DatabaseErrors.QueryFailed)) {
    // General query failure (syntax error, missing table, etc.)
  }
  if (isBlocksError(e, DatabaseErrors.TransactionFailed)) {
    // Transaction could not commit
  }
  if (isBlocksError(e, DatabaseErrors.SerializationFailure)) {
    // Serializable-isolation conflict with a concurrent transaction — serialized
    // as HTTP 409 (Conflict), retriable — safe to retry
  }
  if (isBlocksError(e, DatabaseErrors.ConnectionFailed)) {
    // Cannot reach the database — includes a `minCapacity: 0` cluster resuming
    // from auto-pause, which succeeds on retry a few seconds later
  }
}
```

The client-visible message of each error is a fixed string; the driver's own
text, which names tables, columns and constraints, stays on the server as the
error's `cause`. Only `SerializationFailure` and `ConnectionFailed` are worth
retrying: the request errors (`PermissionDenied`, `CheckViolation`,
`NotNullViolation`, `ForeignKeyViolation`, `UniqueConstraintViolation`) fail the
same way every time.

Each of these errors aborts the enclosing Postgres transaction. Inside a
`db.transaction()` callback, a caught error leaves the transaction unusable: the
next statement fails as `QueryFailed`. Catch them outside `transaction()`, or
wrap the statement in a savepoint (`SAVEPOINT s` … `ROLLBACK TO SAVEPOINT s`) if
the transaction should continue.

A `ConnectionFailed` that takes about nine seconds every time, rather than once
around a rotation, means the credential is wrong rather than mid-rotation: the
engine cannot tell the two apart, so it retries both. The log line
`credential still refused after 3 attempts` names the time spent on each one.
Check that the secret belongs to this cluster, that the app's role still has
`rds-data` and `secretsmanager:GetSecretValue`, and, with a customer-managed
key, that the key policy allows the account's principals.

## What It Provisions (AWS)

- **Aurora Serverless v2** — PostgreSQL-compatible, scales 0.5-128 ACUs. Storage
  encryption at rest is an **explicit choice**, made with the
  `"@aws-blocks/bb-data:encryptStorageByDefault"` context flag in `cdk.json`, so a
  dependency upgrade never changes the encryption of an existing cluster:
  - `true` — encrypt the cluster storage with the account's AWS-managed `aws/rds`
    key. New `create-blocks-app` projects already set this.
  - `false` — keep an existing unencrypted cluster exactly as it is (the
    `StorageEncrypted` property is left unset). Synth emits a
    `@aws-blocks/bb-data:StorageEncryptionDisabled` warning pointing at
    [Enabling storage encryption on an existing database](#enabling-storage-encryption-on-an-existing-database).
  - **not set** — synth **fails** with an error asking you to choose.

  The flag also accepts `1`/`0` and the strings `"true"`/`"false"`/`"1"`/`"0"`
  (case-insensitive, e.g. from `--context`); any other value fails synth. Passing a
  `storageEncryptionKeyArn` (the ARN of a customer-managed KMS key) turns
  encryption on regardless of the flag and uses that key instead (it also encrypts
  the generated credentials secret). The key is **imported** (Blocks can't modify its policy), so its policy
  must allow the account's IAM principals to use it (the default key policy does,
  through the account root; a policy that enumerates principals must name the
  deploying principal, the app runtime's role, the migration Lambda's role and
  the rotation Lambda's role): the deploying principal needs `kms:CreateGrant` +
  `kms:DescribeKey` (RDS uses a grant to encrypt the storage volume), and Blocks
  grants `kms:Decrypt` (via Secrets Manager) to the app runtime and the
  migration Lambda, which read the credentials secret over the Data API. The app
  runtime's role is the shared Blocks execution role, which is also the container
  task role. The key must be in the **same account and region** as the cluster.
- **Automated backups** — on by default, retained **15 days**, which is also the
  point-in-time-recovery window. Controlled by the single `pointInTimeRecovery`
  option (mirrors every other Blocks block): `true` enables the 15-day window,
  `{ retentionDays: n }` pins a 1–35-day window, and `false` clamps to the 1-day
  minimum (Aurora cannot turn automated backups off). When omitted it follows the
  stack-wide `defaults.pointInTimeRecovery` (on under `production`, off under
  `sandbox` — which lands on the 1-day minimum).
- **CloudWatch log export** — the PostgreSQL engine log is exported to CloudWatch
  Logs. Log-group retention follows the stack-wide `defaults.logRetention` when
  set; otherwise it uses the account default.
- **VPC** — Private subnets (isolated, no NAT)
- **Secrets Manager** — Auto-generated credentials, **rotated automatically every
  30 days under the `production` preset** (off under `sandbox`, where a teardown
  would wait on the rotation Lambda's network interfaces and the stack would pay
  for an endpoint it never benefits from; `secretRotation: true` opts in) by
  AWS's PostgreSQL single-user rotation function (a Serverless
  Application Repository app: an AWS-maintained Lambda placed in the cluster's
  VPC). The password is rotated in place: the secret keeps its ARN, and the app
  never reads the password itself (the Data API reads the secret for it), so a
  rotation needs no redeploy. Every rotation, scheduled ones included, has a
  window in which the cluster already accepts the new password while the secret
  still holds the old one, usually 1-3 seconds and occasionally up to about 18;
  a query in that window is refused, so `Database` retries it for up to nine
  seconds, and a longer window surfaces as a retriable `ConnectionFailed`.
  Inside a transaction it is not retried, so the refusal reaches you and you
  retry the transaction.
  A credential that is wrong rather than mid-rotation looks the same, so those
  calls take the full nine seconds before failing instead of failing fast, and
  they keep paying it for as long as the credential stays wrong. A request pays
  it once however many statements it issues, because the refusal ends the
  request and statements you run together overlap; measured at 9.0 s for three
  sequential statements and 9.0 s for three parallel ones. Only a handler that
  catches each refusal and runs the next statement anyway stacks the waits, at
  27.0 s for three, which is where API Gateway's 29-second request ceiling
  comes into reach. Your app's own log says which it was: it carries one line
  per attempt and a `credential still refused` line naming the time spent.
  The first rotation runs during the deploy, which waits (up to five minutes)
  for it to finish.
  `secretRotation: { intervalDays: n }` changes the interval;
  `secretRotation: false` turns it off. The secret is encrypted with your
  `storageEncryptionKeyArn` when one is supplied; the rotation Lambda is then
  granted `kms:Decrypt`, `kms:DescribeKey` and `kms:GenerateDataKey` on that key
  (key-policy requirement as above).

  > **What rotation requires to deploy.** The rotation function comes from the
  > Serverless Application Repository, so a stack with rotation on carries the
  > `AWS::Serverless-2016-10-31` transform. CloudFormation expands it using the
  > stack's **CloudFormation execution role**, which therefore needs
  > `serverlessrepo:GetApplication` and
  > `serverlessrepo:CreateCloudFormationTemplate`: the default CDK bootstrap grants
  > both through `AdministratorAccess`, but a bootstrap narrowed with
  > `--cloudformation-execution-policies` may not, and the deploy then fails while
  > expanding the transform. You do not pass `CAPABILITY_AUTO_EXPAND` yourself —
  > the CDK CLI always sends it. The application is published in the `aws`,
  > `aws-cn` and `aws-us-gov` partitions only, so rotation cannot deploy in any
  > other partition: set `secretRotation: false` there. A stack with a concrete
  > region fails at synth with that message; an environment-agnostic stack (no
  > `env`) leaves the partition unresolved until deploy, so nothing catches it at
  > synth. The transform does not affect the sandbox dev loop: `npm run sandbox`
  > hotswaps a handler change exactly as before, because hotswap reads the
  > unexpanded template.
- **Secrets Manager VPC endpoint** — in the Database's own VPC (isolated, no NAT)
  an interface endpoint gives the rotation Lambda its only path to the Secrets
  Manager API (billed hourly per AZ, ~$7.20/month per AZ in us-east-1, two AZs).
  In a shared VPC (`defaults.vpc`), Blocks already provisions this endpoint for
  the Data API and the rotation Lambda shares it. If you manage the endpoints
  yourself (`provisionEndpoints: false`), your Secrets Manager endpoint's security
  group must allow inbound 443 from the rotation Lambda's security group; synth
  warns (`blocks:vpc:endpoint-client-unadmitted`) with the group to admit, and the
  stack outputs that group's id under a name ending in `RotationSgId` (emitted
  for any `Database` in a shared VPC, whoever owns the endpoints). The group is
  created by the first deploy, so that deploy's rotation fails and waits five
  minutes; add the rule and Secrets Manager's own reattempt then succeeds. See
  `VPC.md` for the sequence and for how to acknowledge the warning afterwards.
- **Migration Lambda** — Runs `.sql` files on deploy via CustomResource
- **IAM** — `rds-data:*` and `secretsmanager:GetSecretValue` granted to the app
  runtime and the migration Lambda; with a `storageEncryptionKeyArn`, also
  `kms:Decrypt` on that key, scoped to use through Secrets Manager

> **Access model:** the app reaches the database exclusively over the RDS Data API
> (HTTPS + Secrets Manager credentials), never a raw Postgres socket; the only
> socket client is the rotation Lambda, which signs in with the password it is
> rotating. Database-level IAM authentication (`iamAuthentication`) is therefore
> intentionally left off — it does not apply to the Data API access path.
>
> **Enabling encryption on an existing unencrypted cluster requires a
> replacement — and a replacement is destructive.** RDS cannot encrypt an
> already-provisioned unencrypted cluster in place, so turning storage encryption
> on (or changing the KMS key) makes CloudFormation create a **new, empty**
> encrypted cluster and repoint the stack at it. There is **no in-place path**.
> What happens to the old cluster and its data depends on the removal policy:
> - **Production (RETAIN):** the old cluster is left behind, orphaned and no
>   longer referenced by the stack. The app comes back pointed at the new **empty**
>   cluster. The migration CustomResource does **not** re-run on a cluster swap —
>   its only CloudFormation properties are the service token and the migrations
>   hash, and neither changes when the cluster is replaced, so CloudFormation never
>   invokes it. The replacement cluster therefore comes up with **no schema**;
>   migrations run only when a migration file changes (which changes the migrations
>   hash). Your data still exists on the orphaned cluster but is not restored.
> - **Sandbox (DESTROY):** the old cluster and all of its data are **deleted**.
> - **Snapshot (`removalPolicy: 'snapshot'`):** the old cluster is snapshotted as
>   it is replaced. Under production's `deletionProtection: true`, the follow-up
>   delete of the old cluster may fail and leave it in place; this cleanup path is
>   unverified on a real deploy.
>
> **The replacement is symmetric.** Flipping the flag from `true` to `false` (or
> removing `storageEncryptionKeyArn`) on a project that already deployed encrypted
> also changes the `StorageEncrypted` property, so it **likewise replaces the
> cluster** (back to unencrypted) with the same new-empty-cluster / no-schema
> outcome. Deleting the flag outright fails synth instead. Adding or changing the
> KMS key also replaces the cluster's generated credentials secret (a new logical
> id, hence a new generated password). Follow the steps below to carry data across.

### Enabling storage encryption on an existing database

If your project was deployed before it set the
`"@aws-blocks/bb-data:encryptStorageByDefault"` flag, its Aurora cluster is
unencrypted and synth now fails until you choose. You have two options.

**Option 1 — keep the existing cluster as it is.** Set the flag to `false` in
`cdk.json`. The cluster's template is unchanged (nothing is replaced) and synth
emits a warning that its storage is unencrypted. You can migrate later.

```json
{
  "context": {
    "@aws-blocks/bb-data:encryptStorageByDefault": false
  }
}
```

**Option 2 — move the data onto an encrypted cluster.** Setting the flag to `true`
on an existing unencrypted cluster replaces it with a new, empty one (see above),
so instead restore an encrypted copy yourself and point the block at it with
`fromExisting()`. Start from Option 1 (flag `false`) so deploys stay safe while you
migrate, and plan a **write freeze** from step 2 until the deploy in step 6
completes — writes made after the snapshot are not carried across.

1. **Check what a deploy would do.** `npm run deploy` runs `cdk deploy` with
   `--require-approval never`, so it will **not** prompt before replacing a
   cluster. Run `npx cdk diff` yourself before any deploy that touches the
   encryption settings and look for `AWS::RDS::DBCluster` marked as a replacement
   (`[-] AWS::RDS::DBCluster ... replace` / `may be replaced`). Find the current
   cluster identifier and credentials secret ARN from the stack:

   ```bash
   aws cloudformation describe-stack-resources --stack-name <stack> \
     --query "StackResources[?ResourceType=='AWS::RDS::DBCluster' || ResourceType=='AWS::SecretsManager::Secret'].[ResourceType,PhysicalResourceId]"
   ```

2. **Snapshot the existing cluster.**

   ```bash
   aws rds create-db-cluster-snapshot \
     --db-cluster-identifier <old-cluster-id> \
     --db-cluster-snapshot-identifier <old-cluster-id>-pre-encrypt
   aws rds wait db-cluster-snapshot-available \
     --db-cluster-snapshot-identifier <old-cluster-id>-pre-encrypt
   ```

3. **Restore the snapshot into a new, encrypted cluster.** Passing `--kms-key-id`
   restores an unencrypted snapshot as encrypted. Use `alias/aws/rds` or your
   customer-managed key ARN, the same engine version and capacity as the current
   cluster (`aws rds describe-db-clusters --db-cluster-identifier <old-cluster-id>`
   shows them), and a DB subnet group and security group **you own outside this
   stack**: once the managed `Database` leaves the template, CloudFormation removes
   the Blocks-created VPC, subnets and security group. The cluster is reached over
   the RDS Data API, so the security group needs no ingress rules.

   ```bash
   aws rds restore-db-cluster-from-snapshot \
     --db-cluster-identifier <new-cluster-id> \
     --snapshot-identifier <old-cluster-id>-pre-encrypt \
     --engine aurora-postgresql --engine-version <engine-version> \
     --kms-key-id alias/aws/rds \
     --db-subnet-group-name <your-db-subnet-group> \
     --vpc-security-group-ids <your-security-group-id> \
     --serverless-v2-scaling-configuration MinCapacity=0.5,MaxCapacity=2 \
     --deletion-protection
   ```

4. **Add a Serverless v2 writer and enable the Data API.**

   ```bash
   aws rds create-db-instance \
     --db-instance-identifier <new-cluster-id>-writer \
     --db-cluster-identifier <new-cluster-id> \
     --db-instance-class db.serverless --engine aurora-postgresql
   aws rds wait db-instance-available --db-instance-identifier <new-cluster-id>-writer
   aws rds enable-http-endpoint --resource-arn <new-cluster-arn>
   ```

5. **Copy the credentials into a secret you own — before switching.** The
   Blocks-managed credentials secret has `DeletionPolicy: Delete` (even under the
   production preset), so it is **deleted** as soon as the managed cluster leaves
   the template. The restored cluster keeps the snapshot's master password, so
   without a copy you lose its credentials.

   ```bash
   aws secretsmanager create-secret --name <app>/database-credentials \
     --secret-string "$(aws secretsmanager get-secret-value \
       --secret-id <managed-secret-arn> --query SecretString --output text)"
   ```

   Pass `--kms-key-id <your-key-arn>` too if you use a customer-managed key.

6. **Point the block at the restored cluster.** `host` is the cluster **ARN** (the
   Data API resource) and `secretArn` is the **complete** ARN of the secret from
   step 5 (including its random suffix). Remove `migrationsPath` — it can't be
   combined with `fromExisting()`, and the restored cluster already carries the
   schema. Then `npx cdk diff`, and deploy.

   ```typescript
   import { Database, fromExisting } from '@aws-blocks/bb-data';

   const db = new Database(scope, 'main', {
     connection: fromExisting({
       host: 'arn:aws:rds:<region>:<account>:cluster:<new-cluster-id>',
       database: '<database-name>',
       secretArn: 'arn:aws:secretsmanager:<region>:<account>:secret:<app>/database-credentials-AbCdEf',
     }),
   });
   ```

   The `encryptStorageByDefault` flag no longer affects this `Database` (nothing is
   provisioned for a `fromExisting()` connection). Under the production preset the
   old cluster is retained (with deletion protection on) — delete it once you've
   verified the new one. Under sandbox it is deleted by this deploy.

## Local Development

- **Engine:** PGlite (WASM PostgreSQL) — full Postgres compatibility
- **Storage:** `.bb-data/{fullId}/` — persists across restarts, wipe with `rm -rf .bb-data`
- **Migrations:** Run automatically on first query

### Local Postgres extensions (PostGIS, pgvector)

Aurora PostgreSQL supports extensions such as PostGIS and pgvector natively, but
the local PGlite engine does not load any by default — so `CREATE EXTENSION postgis`
works once deployed but fails in local dev, breaking local/production parity.

Declare the extensions your app uses and they load in local dev too:

```typescript
const db = new Database(scope, 'main', {
  extensions: ['postgis'],   // or ['pgvector'], or both
});
```

- **Local-only.** Like `postgresVersion`, `extensions` is read only by the local
  PGlite engine and ignored on AWS (Aurora loads these natively). Your app code is
  unchanged across environments.
- **Opt-in install.** Each extension ships as its own package, installed only if
  you declare it:
  - `postgis` → `npm install @electric-sql/pglite-postgis@0.2.11`
  - `pgvector` → `npm install @electric-sql/pglite-pgvector@0.0.12`

  Install the exact version shown: `bb-data` peer-pins it, and each extension
  release pins its own `@electric-sql/pglite` version, so an unpinned install can
  pull a release that conflicts with the `pglite` version `bb-data` uses.

  If a declared extension's package is missing (or the name is unknown), the
  first database interaction fails with an actionable error — the exact install
  command for a missing package, or the list of supported names.
- **Still run `CREATE EXTENSION`.** This option only makes the extension available;
  issue `CREATE EXTENSION <name>` in a migration as you would on Postgres.

Both extension packages are experimental upstream; because the install is opt-in,
that risk stays with your app rather than every `bb-data` consumer.

### Local vs. AWS: column types

Array columns and `json` / `jsonb` columns return the same JavaScript values on
both engines. Array columns (`text[]`, `int[]`, ...) come back as JS arrays and
`json` / `jsonb` columns come back as parsed objects, whether you run locally on
PGlite or on AWS over the RDS Data API. Element representation still follows the
scalar notes below — e.g. `numeric[]` elements come back as strings over the
Data API.

Some scalar numeric types can still differ in representation between the two
engines: `numeric` / `decimal` comes back as a string over the Data API, and
`bigint` / `int8` comes back as a JS `number` over the Data API while the `pg` /
PGlite driver returns it as a string by default. Cast or parse these explicitly
if you need identical values across both engines.

One Postgres type the RDS Data API cannot return is `tsvector`: selecting a
`tsvector` column directly (for example `select *` on a table with a generated
`search tsvector` column) fails on AWS. Exclude it from the select list — a
`tsvector` is normally only used in a `WHERE` / `ORDER BY` full-text predicate,
not read back as a value.

## Configuration

```typescript
interface DatabaseOptions {
  /** Path to directory containing numbered .sql migration files. */
  migrationsPath?: string;
  /** Connect to an existing database instead of provisioning one. */
  connection?: ExternalDatabaseRef;
  /** Schema metadata for crud() support. */
  schema?: TableSchema;
  /** Aurora PostgreSQL engine version, e.g. '16.13'. Override the Aurora engine version. @default '16.13' */
  postgresVersion?: string;
  /**
   * Postgres extensions to load in the LOCAL PGlite engine, by name
   * (e.g. ['postgis'] or ['pgvector']). Local-only, mirroring postgresVersion:
   * ignored on Aurora, which supports these natively. Supported: 'postgis',
   * 'pgvector'. See "Local Postgres extensions" below. @default []
   */
  extensions?: string[];
  /**
   * ARN of a customer-managed KMS key for the cluster's storage-at-rest encryption
   * (also encrypts the auto-generated credentials secret). Supplying it turns
   * storage encryption on regardless of the `@aws-blocks/bb-data:encryptStorageByDefault`
   * context flag (and satisfies synth even when the flag is absent). When omitted,
   * encryption follows that flag — on with the account's AWS-managed `aws/rds` key
   * when `true`, left unset (with a synth warning) when `false`, and synth fails
   * when the flag is not set. The key is
   * imported, so its policy must allow the account's IAM principals to use it
   * (the default key policy does): the deploying principal needs `kms:CreateGrant`
   * + `kms:DescribeKey`, and Blocks grants `kms:Decrypt` to the principals reading
   * the credentials secret; it must be in the same account + region.
   */
  storageEncryptionKeyArn?: string;
  /**
   * Automated-backup retention, which is also the point-in-time-recovery (PITR)
   * window. `true` enables the 15-day window; `{ retentionDays: n }` pins a
   * 1–35-day window; `false` clamps to the 1-day minimum (Aurora cannot disable
   * automated backups). When omitted, follows `defaults.pointInTimeRecovery`.
   */
  pointInTimeRecovery?: boolean | { retentionDays: number };
  /**
   * Automatic rotation of the credentials secret. `true` rotates every 30 days;
   * `{ intervalDays: n }` every n days (1–1000, the upper bound being Secrets
   * Manager's limit rather than a recommendation); `false` turns it off. When
   * omitted, follows `defaults.secretRotation` (on under `production`, off
   * under `sandbox`).
   */
  secretRotation?: boolean | { intervalDays: number };
}
```

## Package Export Conditions

```json
{
  "exports": {
    ".": {
      "cdk": "./dist/index.cdk.js",
      "aws-runtime": "./dist/index.aws.js",
      "default": "./dist/index.mock.js"
    }
  }
}
```

## Performance

- **Query latency:** 10-50ms (warm), ~500ms cold start from 0 ACUs
- **Throughput:** Requests go over the RDS Data API (HTTPS) rather than pooled database connections, so there is no connection-pool ceiling or RDS Proxy; concurrency is bounded by the Data API request limits and the cluster's ACU scaling.
- **Storage:** Up to 128 TiB, auto-scales in 10 GiB increments
- **Cost:** ~$0.12/ACU-hour + ~$0.10/GB-month storage
- **Durability:** 6 copies across 3 AZs, 99.99% availability


