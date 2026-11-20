# @aws-cdk-blocks/admin-ui

## 1.0.0-rc.1

### Minor Changes

- c42ba42: **Breaking: the hidden `.blocks/` folder is now `.cdk-blocks/`, and local data moves from `.bb-data/` to `.cdk-blocks/local/data/`.**

  To upgrade an existing app:

  1. Move the config file: `mkdir -p .cdk-blocks && git mv .blocks/config.json .cdk-blocks/config.json`. Then delete the empty `.blocks/` folder. Do not run `git mv .blocks .cdk-blocks`, because it nests the old folder inside the new one when `.cdk-blocks/` already exists.
  2. In your tsconfig `include`, change `.blocks/**/*.d.ts` to `.cdk-blocks/**/*.d.ts`. Without this change, `getSecret()` and `getConfig()` lose their key types.
  3. Run `npm run typegen` and commit `.cdk-blocks/hosting-values.d.ts`.

  Local data, the local database included, is copied to the new location the first time each block opens its store. `.bb-data/` stays in place. `.cdk-blocks/local/` ignores itself, so it needs no `.gitignore` rule.

  An app that still has `.blocks/config.json` deploys and destroys as before. The telemetry first-run notice prints once more after the upgrade. Pull request #1607 has the full notes.

### Patch Changes

- b47e4c7: Open the Dashboard block's route during local development to see configured metrics, find local observability output, and launch the Admin UI without deploying. The Admin UI starts new sessions on local data and defers AWS reads until a cloud stage is selected.

## 1.0.0-rc.0

### Major Changes

- e50b9e9: Rename every published package from the `@aws-blocks` scope to `@aws-cdk-blocks`. The umbrella package is now unscoped: `@aws-blocks/blocks` becomes `aws-cdk-blocks`.

  No export or option moved. To upgrade, replace the dependency names in `package.json` and the specifiers in every import:

  ```diff
   {
     "dependencies": {
  -    "@aws-blocks/blocks": "<your range>",
  -    "@aws-blocks/core": "<your range>"
  +    "aws-cdk-blocks": "<your range>",
  +    "@aws-cdk-blocks/core": "<your range>"
     }
   }
  ```

  ```diff
  -import { KVStore } from '@aws-blocks/blocks';
  +import { KVStore } from 'aws-cdk-blocks';

  -import { ApiNamespace } from '@aws-blocks/core';
  +import { ApiNamespace } from '@aws-cdk-blocks/core';
  ```

  Warning IDs reported at synth carry the package name, so they now start with `@aws-cdk-blocks/` instead of `@aws-blocks/`: update any `Annotations.of(stack).acknowledgeWarning('@aws-blocks/…')` call to the new prefix. An acknowledgement left on an old ID silently stops matching, the warning comes back, and `cdk synth --strict` fails on it.

  The `cdk-blocks` CLI binary, the `aws-blocks` keyword used to discover third-party blocks, and the `aws-blocks` manifest key that carries the `native` and `vendorize` declarations are all unchanged, so a published third-party block is still discovered and still loads its manifest without a republish. A block that depends on `@aws-blocks/core` brings its own copy of core alongside the app's `@aws-cdk-blocks/core`, which is two module instances; block authors should move the dependency to `@aws-cdk-blocks/core`.

  The CDK context key `@aws-blocks/bb-data:encryptStorageByDefault` keeps its name too. `LegacyDatabaseCluster` reads it out of your `cdk.json`, where apps scaffolded before the cutover already set it, and no package was ever published under a `@aws-cdk-blocks/bb-data` name. Renaming the key would leave `StorageEncrypted` unset on a cluster deployed with it on, which CloudFormation answers by replacing the cluster. Keep the key as it is.

  The old `@aws-blocks/*` packages stop receiving releases.

### Minor Changes

- f32185c: Add the Blocks Admin UI: a local dashboard a developer runs against their own Blocks application, served on `127.0.0.1` behind a session token. It shows deployments with CloudFormation root-cause drill-down, log group discovery with faceted search and live tail, a resource inventory grouped by the block that owns each resource, per-stage cost and usage, a data browser, an RPC playground, and a stage-aware settings and secrets editor. Every screen works against `local`, `sandbox` and `production`, and an empty screen states the next action rather than being a dead end.

  The package is published to npm, so `blocks dashboard` can offer to install it into an app that does not carry it yet. It is not a Building Block and stays out of the block catalog.

- 703238f: refactor: rename the scaffolded backend folder to `cdk-blocks`

  `create-blocks-app` now scaffolds the backend into `cdk-blocks/`, the folder's own package is named `cdk-blocks`, the parent lists it under `"workspaces"`, and the frontend imports it as `cdk-blocks`.

  `@aws-cdk-blocks/bb-database` moves its default migrations root with the folder: `DEFAULT_MIGRATIONS_ROOT` is now `./cdk-blocks/migrations`, and `db pull` writes `cdk-blocks/database.types.ts` by default. An app that keeps an `aws-blocks/migrations` directory finds no migrations after upgrading, so rename the directory or set an explicit migrations path.

  **Breaking: the scaffolded backend folder is `cdk-blocks/`, not `aws-blocks/`.** An existing app renames the directory, the `"workspaces"` entry that names it, the `"name"` in its `cdk-blocks/package.json`, and every `from 'aws-blocks'` import. There is no dual-name support and no compatibility shim.

  The reserved URL namespace (`/aws-blocks/api`, `/aws-blocks/auth/*`, `/aws-blocks/dashboard`) keeps its path, so deployed API Gateway routes and OAuth callback URLs already registered with an identity provider keep working.

- 45a05d1: The per-deploy state directory is now `.cdk-blocks-sandbox/`

  The directory that holds an app's per-deploy state was named `.blocks-sandbox/`. It is renamed to `.cdk-blocks-sandbox/`. The path the runtime config is served at does not change — it stays `/.blocks-sandbox/config.json` — so a frontend you have already deployed keeps resolving its API URL, and nothing has to be redeployed on account of this.

  **Your sandbox state is copied forward for you.** On the first `npm run dev`, `npm run deploy`, `npm run sandbox` or `npm run destroy` after upgrading, each state file in `.blocks-sandbox/` is copied into `.cdk-blocks-sandbox/`: `sandbox-id.txt`, `config.json`, `config.sandbox.json`, `config.production.json`, `outputs.json`, `outputs.production.json`, `last-deploy.json`, and the per-port `dev-server.<port>.pid` files. `sandbox-id.txt` is the one that matters: it names your sandbox's CloudFormation stack, and it cannot be regenerated — a lost one would send your next deploy to a different stack and leave your existing sandbox standing in your account, with `npm run sandbox:destroy` reporting there is nothing to delete.

  The copy is per file, so the CDK cloud assembly the directory also holds (`cdk.out/`, `sandbox-destroy.out/`) is left behind rather than duplicated. The old directory is copied, never moved, so an older `cdk-blocks` in the same checkout keeps working; delete `.blocks-sandbox/` yourself once you no longer need it. A file already present under the new name is never overwritten — state written since the upgrade is newer. If the copy cannot be made (a read-only project directory), the command fails and names the file, rather than continuing and generating a new sandbox id.

  **If you scaffolded a Next.js app and serve the config from its route,** keep `src/app/.blocks-sandbox/config.json/route.ts` exactly where it is — the directory name is the URL it answers, and that has not changed. Change only the path it reads, from `.blocks-sandbox/config.json` to `.cdk-blocks-sandbox/config.json`. Leaving it on the old path returns a stale `apiUrl` from the pre-upgrade file, or a 404 once that file is gone. This applies when you serve Next directly; behind the Blocks front door the hosted route is used instead.

  **If you reference the directory yourself,** update it: a `.gitignore` entry, a `cdk.json` `watch.exclude` entry, a CI step reading `.blocks-sandbox/config.sandbox.json` or `outputs.json`, or a script passing `outputsFile`. Apps scaffolded by `create-blocks-app` get the new entries; an existing app's own files are yours. `npm run migrate` skips both directory names while scanning, so it still works on an app that has not been upgraded yet.

- 1de6ea4: The framework's reserved URL prefix is now `/cdk-blocks/` (`/cdk-blocks/api`, `/cdk-blocks/auth/*`, `/cdk-blocks/settings`, `/cdk-blocks/dashboard`, ...). The old `/aws-blocks/` prefix stays served as an alias with the same handlers: the runtime (Lambda, container and dev server) treats `/aws-blocks/...` as `/cdk-blocks/...`, the shared API gateway and the Hosting front doors route both, so already-deployed clients, mobile apps and registered auth callbacks keep working. Clients, generated config and defaults use `/cdk-blocks/`.

  `BLOCKS_RPC_PREFIX` and `BLOCKS_AUTH_PREFIX` now hold the new prefix, and `canonicalBlocksPath()` maps a legacy path to its canonical one.

  **Upgrade:**

  - The default `redirects.callbackPath` of an `Auth` with `providers` becomes `/cdk-blocks/auth/callback`. An external identity provider (OIDC, Google, ...) that only allows the old `/aws-blocks/auth/callback` redirect URI must have the new one registered, or set `redirects.callbackPath: '/aws-blocks/auth/callback'` to keep the old one.
  - A custom front door or an explicit `apiPaths` that routes `/aws-blocks/*` by hand must also route `/cdk-blocks/*` (or use `cf.apiBehaviors(origins.api)`), or the upgraded frontend's API calls won't reach the backend. A custom front door that records only `/aws-blocks/*` as wired now fails synth with `ProxySameOriginApi`; one that wires only `/cdk-blocks/*` gets a warning that legacy `/aws-blocks/*` clients are not routed.
  - The built-in CloudFront front door adds one cache behavior (`/aws-blocks/*`). An app already at the distribution's cache-behavior quota (25 by default) needs to free a behavior or raise the quota, or the upgrade fails (at synth when container namespaces add direct behaviors, else at deploy).

  A sandbox `stubIdp()` issuer moves to `/cdk-blocks/auth/idp/<id>`, so its users get a new `userId`. Native clients move tokens stored under a block's old `/aws-blocks/` keys to its new keys, so an upgrade keeps their session.

  The Admin UI calls `/cdk-blocks/api` and retries at `/aws-blocks/api` only when an older dev server answers 404 without a JSON-RPC envelope, so it still works with that server and never runs a method twice.

  A `ContainerCompute` keeps the logical ID and priority of each API listener rule it deployed under `/aws-blocks/api/<name>`, so the upgrade updates the rule's path to `/cdk-blocks/api/<name>` in place rather than replacing it.

### Patch Changes

- e3b5949: Ship the LICENSE file that the package's `files` list already names.
- c67048e: feat!: `Database` from `@aws-cdk-blocks/bb-database` is the only SQL Building Block

  **Breaking change.** `aws-cdk-blocks` exports `Database`, `DatabaseCluster`, `DatabaseErrors` and `sql` from `@aws-cdk-blocks/bb-database`. The packages `@aws-blocks/bb-data`, `@aws-blocks/bb-distributed-data` and `@aws-blocks/data-common` are not part of AWS Blocks any more. There is no compatibility layer.

  ```ts
  import { Database, DatabaseCluster, sql } from "aws-cdk-blocks";

  const orders = new Database(scope, "orders"); // owns an Aurora DSQL cluster

  const cluster = new DatabaseCluster(scope, "main", { type: "aurora" }); // Aurora PostgreSQL Serverless v2
  const users = new Database(scope, "users", { cluster });
  ```

  - **`Database`** owns an Aurora DSQL cluster when it has no `cluster` option. A `DatabaseCluster` of type `'dsql'` or `'aurora'` holds several `Database` blocks, each in its own schema. Migrations are ordered `.sql` files in `cdk-blocks/migrations/<id>/`.
  - **Not exported any more:** `DistributedDatabase`, `DistributedDatabaseErrors`, `DistributedDatabaseOptions`, `Database.fromExisting()` and `ExternalDatabaseRef` (an existing PostgreSQL database is now `DatabaseCluster.fromExisting()`, passed as `cluster`). `withRLS()` is replaced by `asUser()` and `asRole()`. `crud()` has no equivalent in `@aws-cdk-blocks/bb-database`. For Kysely, use `DatabaseDialect` from `@aws-cdk-blocks/bb-database/kysely`.
  - **`getSdkIdentifiers(db)`** returns `clusterId` and `schemaName`, plus `clusterEndpoint` and `region` in a deployed Lambda. `getSdkIdentifiers(cluster)` returns `clusterEndpoint`.
  - **Data is not moved.** A `Database` that takes the place of a `Database` of `@aws-blocks/bb-data` on the same line of code is a new block with a new cluster. To keep the old cluster, make that line a `LegacyDatabaseCluster` and put a `Database` with a new id on it. A `Database` that takes the place of a `DistributedDatabase` with the same id keeps its cluster.
  - **`@aws-cdk-blocks/create-blocks-app`:** the `sql` and `demo` templates use the new `Database` on its default Aurora DSQL cluster, with migrations in `cdk-blocks/migrations/<id>/`. The templates' `cdk.json` has no `@aws-blocks/bb-data:encryptStorageByDefault` context key.
  - **`@aws-cdk-blocks/bb-database`:** the CDK `Database` records itself as the `Database` Building Block of the stack.

  **An existing PostgreSQL database.** `DatabaseCluster.fromExisting({ name, ca })` puts a `Database` on a PostgreSQL database that already exists, with its tables and data; Supabase is the tested provider. The block provisions nothing and `db.cluster.kind` is `'external'`. The connection string is never written in code: with `name` the block reads the SSM SecureString `/<stackName>-<name>` on AWS and a local value under `.bb-data/`, and `connectionString` takes your own `AppSetting` or `Secret`. The server certificate is always verified, against `ca` (PEM text) or Node's trust store, and a connection string that carries a TLS parameter is refused. Local mode connects to the real database and runs no migration file.

  Migrations on an existing database run during the deploy, in a function outside any VPC, one transaction per file; the file is recorded in that transaction. The `_migrations` table and the files of an app that used `@aws-blocks/bb-data` with `fromExisting()` continue as they are, so no file runs twice.

  **`npm run db`** runs the commands of `@aws-cdk-blocks/bb-database`. `pull` and `generate-types` are not commands any more.

  - `connect` checks an existing database (certificate, role, policies, endpoint) and stores the connection string for local mode or for a stage. The connection string is read from a hidden prompt or stdin and is never printed.
  - `migrate` applies pending files to the development database with the code a deploy uses. `migrate --mark-applied <file>` records a file as applied without running it, for a schema dump of a database that already has the schema; `--stage` records it on a stage.
  - `types` writes one `Tables` interface for Kysely. `status` lists applied and pending files.
  - `types --block <id>` writes the `Tables` interface of a block that provisions its cluster, from the block's migration files (`cdk-blocks/migrations/<id>`). It applies the files to a new local database in a temporary directory, so it needs no AWS account and does not touch `.bb-data/`. Pass `--type aurora` for a block on an `aurora` cluster.
  - `status --block <id>` lists the applied and the pending files in the block's local database; pass `--cluster <id>` for a block on a `DatabaseCluster`. It reads a copy of the database, so it is safe while `npm run dev` runs.

  On a cluster that the block owns, migrations run on the first statement in local mode and during the deploy on AWS.

  **Statements as a user or a role.** `Database.asUser(user, claims?)` returns the block with every statement run as one user, for tables with Row Level Security on an `aurora` cluster. Each transaction on it starts by setting `request.jwt.claims` to `{ ...claims, sub: user.userId }` for that transaction only, so a policy such as `USING (owner_id = current_setting('request.jwt.claims', true)::jsonb ->> 'sub')` gives each user their own rows. `query`, `queryOne`, `execute`, `transaction` and Kysely (`new DatabaseDialect(db.asUser(user))`) all run as the user, locally and on AWS. The result of an auth block's `requireAuth()` passes as it is. A statement on the block itself carries no user and reads no rows from a table whose policy compares with `sub`.

  `Database.asRole(role, claims?)` returns the block with every statement run as a database role, for Row Level Security policies written for a role (`TO authenticated`): each transaction starts with `SET LOCAL ROLE` and the claims, for that transaction only. Use it where the connection role owns the tables, since PostgreSQL does not apply policies to an owner.

  `asUser()` and `asRole()` throw `DatabaseConfigurationError` on a `dsql` cluster. A Kysely transaction's isolation level is now set by the engine, and `BEGIN` is tried once more when its pooled connection was closed while idle.

  **Errors.**

  - A write that a policy refuses fails with the new `DatabaseErrors.PermissionDenied` (HTTP 403).
  - A statement that breaks a constraint now has its own error name: `DatabaseErrors.NotNullViolation` and `DatabaseErrors.CheckViolation` (HTTP 400), and `DatabaseErrors.ForeignKeyViolation` (HTTP 409). These were `QueryFailed` before. The message has no value of the row; the server's own text stays on the server-side `cause`. None of the three is retried.
  - `ConnectionFailed` now also covers a connection that was never made (the address did not answer, the server certificate was not accepted, the login was refused); these were `QueryFailed` before. A connection that ends between two statements of a transaction no longer ends the Node process, and a connect that timed out is no longer tried a second time.

  **Local mode.** A block's statements run as a plain database role with the grants the deployed app role gets; migrations run as the admin. PostgreSQL now refuses the same statements under `npm run dev` as on AWS: DDL and `TRUNCATE` outside a migration, and reads of the migration ledger, fail with `QueryFailed`. A Row Level Security policy on a table of an `aurora` cluster applies to the block's statements locally as it does on AWS. DDL in a handler was `DatabasePermissionException` locally before; the `_migrations` and `_migration_progress` tables are no longer readable from application code. An existing `.bb-data` directory needs no reset.

  **`@aws-cdk-blocks/core`.** `npm run dev`, `sandbox` and `deploy` do not apply migrations to an external database before they run. `sandbox` and `deploy` no longer copy a `*_DB_URL` or `*_CONNECTION_STRING` environment variable to the SSM parameter `/<stackName>-db-url`. `npm run db -- connect --stage <stage>` stores the connection string of a `Database` on an existing database, after it has checked the database; an environment value written on every deploy replaced what that command stored. A parameter that an earlier deploy wrote stays in SSM and is still read with `DatabaseCluster.fromExisting({ name: 'db-url' })`. `ensureSecrets` is not exported from `@aws-cdk-blocks/core/scripts` and `aws-cdk-blocks/scripts` any more.

- 8894669: **Breaking: telemetry now follows your CDK CLI telemetry setting, and the AWS Blocks opt-out is removed.** `AWS_BLOCKS_DISABLE_TELEMETRY`, the `cdk-blocks telemetry` command, the `blocks-telemetry` binary and the `telemetry.enabled` key in `.blocks/config.json` are gone, with no fallback and no migration, so if you opted out that way you are opted back in until you opt out through CDK.

  Opt out with `CDK_DISABLE_CLI_TELEMETRY` set to `1` or `true`, with `cdk cli-telemetry --disable`, or with `cli-telemetry: false` in the `context` of `cdk.json` or `~/.cdk.json`. CDK documents those settings at https://docs.aws.amazon.com/cdk/v2/guide/cli-telemetry.html#telemetry-opt-out. The values are matched exactly as the CDK CLI matches them, so `TRUE` and `yes` are not an opt-out. `CDK_BLOCKS_DISABLE_TEMPLATE_METADATA`, which governs the `AWSToolsMetrics` entry in the CloudFormation template, is a separate switch and is unchanged.

- d46dfaf: fix(core,blocks,create-blocks-app): a deploy no longer points the local dev loop at AWS

  Every deploy rewrote `.cdk-blocks-sandbox/config.json` with its AWS `apiUrl`. The Node.js client reads that file, while the browser gets its config from the running dev server, so after `npm run deploy` or `npm run sandbox:deploy` with `npm run dev` running, `npm run test:e2e` signed up users and wrote items in the deployed stack, production included, and a Next.js Server Component rendered from the production Lambda, with nothing pointing at it.

  - `deploy()` records its API URL in `.cdk-blocks-sandbox/config.production.json`, and a sandbox deploy in `.cdk-blocks-sandbox/config.sandbox.json`, both `{apiUrl, environment}`. Neither writes `config.json` any more: only a dev server does, with its own local URL.
  - The dev server sets `BLOCKS_API_URL` to its own front door on the frontend command it runs (Vite, `next dev`), so server-side frontend code calls the local server. In sandbox mode that is the local front door, which proxies to the sandbox.
  - The template e2e tests set `BLOCKS_API_URL` to the dev server on `blocks.dev.port` before they load the client. Set `TEST_URL` to the URL a deployed app's API is under to run them against it; they then start no dev server.
  - `npm run spec` takes the spec's `servers` entry from the dev server's `config.json`, or from `config.<stage>.json` when `BLOCKS_SPEC_STAGE` is `sandbox` or `production`.
  - `npm run destroy` and `npm run sandbox:destroy` also remove the destroyed stage's `config.<stage>.json`.
  - An app deployed before this release still has the deploy's AWS URL in `config.json`. The Node.js client refuses such a file (`environment` `production`, or `sandbox` with an `https:` URL, which no dev server writes) with an error that says to start the dev server or set `BLOCKS_API_URL`, instead of calling the deployed stack. `npm run dev` rewrites the file, and `deploy`, `sandbox deploy` and both destroys first move it to `config.<stage>.json`.
  - The Admin UI's RPC playground falls back to the stage's `config.<stage>.json` when the stack publishes no `ApiUrl` output. It no longer reads `config.json`, which now holds a dev server's local URL.

  Scripts that read a deployed URL from `config.json` after a deploy should read `config.sandbox.json` or `config.production.json`, or `npm run -s sandbox:deploy -- --query apiUrl`.

  **After upgrading:** an app that was deployed with an earlier version may still have a deployed URL in `.blocks-sandbox/config.json`. A Node.js script, an e2e test or an SSR host that reads that file then fails with the error above, until you run `npm run dev`, `npm run deploy`, `npm run sandbox:deploy` or a destroy once, or set `BLOCKS_API_URL`. The client itself can't move the file: it is also the browser and React Native entry, and it reads the file only.

- 6d3077e: The data browser reads the `KVStore` data file of this release (`.bb-data/<fullId>/store.json`, `{ "version": 2, "items": [...] }`): the string key or the declared key fields, the value, and an expiry that the store keeps outside the value. Local record writes work on that file for a store with declared key fields, and keep the key and the expiry of the record they replace. A store directory that has both `store.json` and `data.json` is read from `store.json`, as the `KVStore` mock does. The session store of `Auth` (`<fullId>-session-store`) sorts with the other auth stores.
- e1e4844: Run AWS Blocks tasks with your app's package manager. New apps define tasks in `package.json` without generating launcher files or installing the `cdk-blocks` executable. Look up documentation with `npm run docs KVStore`, read the API signatures with `npm run docs:api KVStore`, or search with `npm run docs:search "partition key"`.

  Structured task results print text in a terminal and JSON on a pipe or redirect. Use `npm run -s docs KVStore` for clean JSON without npm's banner, or `npm run -s docs -- KVStore --output text` to pipe Markdown. Scripts that previously invoked `cdk-blocks` must switch to package tasks; scripts calling the programmatic `aws-cdk-blocks/scripts` entry remain supported.

  If your app's scripts call `cdk-blocks`, upgrade `aws-cdk-blocks` first. From the app directory, preview the migration without relying on the removed executable:

  ```sh
  node --input-type=module -e "import 'aws-cdk-blocks/run'" -- migrate --dry-run
  ```

  Review the plan, then run the same command without `--dry-run` from a clean Git working tree. The migration rewrites recognized generated scripts and reports custom wrappers that need manual changes.
