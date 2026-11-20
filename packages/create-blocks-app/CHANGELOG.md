# @aws-blocks/create-blocks-app

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

- e9c1bd4: The `nextjs` template's `tsconfig.json` now includes the `ESNext` library, so a backend that lists items with `Array.fromAsync(...)`, as the Building Block docs do, type-checks in `next build`. It stopped at `ES2022`, and `next build` failed with `TS2550: Property 'fromAsync' does not exist on type 'ArrayConstructor'`.
- b47e4c7: Open the Dashboard block's route during local development to see configured metrics, find local observability output, and launch the Admin UI without deploying. The Admin UI starts new sessions on local data and defers AWS reads until a cloud stage is selected.
- c9d73a8: fix(create-blocks-app): a new app now installs one copy of `@aws-cdk-blocks/core`.

  The templates declared `@types/node` `^20.19.43`, which made npm install a separate copy of `core` under each block. The copies did not share state, so `getSdkIdentifiers()` returned `{}` and app code could not import `@aws-cdk-blocks/core`. The templates now declare `@types/node` `^22.12.0`.

  To fix an existing app, make the same change in its `package.json` and run `npm install`.

- e529b00: fix(blocks): client code can now import the block error constants, `isBlocksError`, and `ApiError` from `aws-cdk-blocks`. Before, `import { KVStoreErrors } from 'aws-cdk-blocks'` type-checked and then failed in the browser with `does not provide an export named 'KVStoreErrors'`. The Building Block classes and `sql` are still server-only, so browser code uses `import type` for their types. `aws-cdk-blocks` now also exports `RealtimeErrors`.

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

- 8894669: **Breaking: telemetry now follows your CDK CLI telemetry setting, and the AWS Blocks opt-out is removed.** `AWS_BLOCKS_DISABLE_TELEMETRY`, the `cdk-blocks telemetry` command, the `blocks-telemetry` binary and the `telemetry.enabled` key in `.blocks/config.json` are gone, with no fallback and no migration, so if you opted out that way you are opted back in until you opt out through CDK.

  Opt out with `CDK_DISABLE_CLI_TELEMETRY` set to `1` or `true`, with `cdk cli-telemetry --disable`, or with `cli-telemetry: false` in the `context` of `cdk.json` or `~/.cdk.json`. CDK documents those settings at https://docs.aws.amazon.com/cdk/v2/guide/cli-telemetry.html#telemetry-opt-out. The values are matched exactly as the CDK CLI matches them, so `TRUE` and `yes` are not an opt-out. `CDK_BLOCKS_DISABLE_TEMPLATE_METADATA`, which governs the `AWSToolsMetrics` entry in the CloudFormation template, is a separate switch and is unchanged.

- 184df0b: feat(create-blocks-app): typecheck the backend with Node types and the browser code without them

  The frontend imports the backend (`import { api } from 'cdk-blocks'`), so its `tsconfig` typechecked the backend source with the frontend's settings. The templates passed because their one `tsconfig.json` made Node types global, which also let browser code use `process` or `Buffer` without an error, and a frontend `tsconfig` with `"types": ["vite/client"]`, as create-vite's has, failed with `TS2591: Cannot find name 'process'` in `cdk-blocks/`.

  - The Vite templates (`default`, `bare`, `react`, `auth`, `agent`, `demo`) now check the browser and the backend as separate TypeScript projects, the way create-vite's `react-ts` template does: `tsconfig.app.json` checks `src/` without Node types and reads the backend through a project reference to `cdk-blocks/tsconfig.json`, which checks every backend file with Node types. `npm run typecheck` is `tsc -b --force`, and `npm run build` is `tsc -b --force && vite build`. A Node global in `src/` is now a type error.
  - `nextjs` and the backend-only templates keep one `tsconfig.json` with Node types: `next build` ignores project references, and backend-only apps run all their code on Node.
  - Adding AWS Blocks to an existing project writes `cdk-blocks/tsconfig.json` (except in a Next.js project) and prints how to reference it. It never edits the project's `tsconfig`.
  - Apps scaffolded before this change keep working as they are. To move one to the new layout, see [Keep Node types out of the frontend](https://github.com/aws-devtools-labs/aws-blocks/blob/main/docs/guides/upgrading-older-apps.md#keep-node-types-out-of-the-frontend). `TROUBLESHOOTING.md` in `aws-cdk-blocks` lists the TypeScript errors of the layout and their fixes.

  The decision and the alternatives considered are recorded as D-028 in `docs/DECISIONS.md`.

- ba80bbd: Generated apps keep their existing npm lifecycle script names without generating `cdk-blocks/scripts/*.ts` wrappers. Backend-only templates default to port 3001 with `blocks.dev.frontend` disabled; frontend templates default to frontend port 3100 and detect their frontend from dependencies. Override the ports with `npm run dev -- --port 4000 --frontend-port 4100`. Existing `blocks.dev` settings are preserved when adding AWS Blocks to an existing project. Amplify keeps its own sandbox and client generation. Generated guidance documents npm scripts, structured results, and non-interactive confirmations. Scaffold next steps quote paths with spaces and give backend-only apps their correct API URL. `--template=<name>` and `--template <name>` are both accepted. `npm run cleanup` stops only dev sessions recorded for this app. Production destroy requires confirmation in a terminal or `npm run destroy -- --yes` in automation. End-to-end tests reuse the configured dev port. Generate hosting types with `npm run typegen` before enabling `npm run typegen -- --check` in CI. The local realtime WebSocket uses `BLOCKS_DEV_HOST` to opt into a different host.

  Scaffold guidance redirects background dev-server output to a log, and generated gitignore files ignore `*.log`. Stop a server started on another port with `npm run dev:stop -- --port <n>`, or stop the app's recorded sessions with `npm run cleanup`. Sandbox destruction prompts in a terminal; `npm run sandbox:destroy -- --yes` skips that prompt, while non-interactive sandbox destruction retains its existing behavior. The backend README identifies the JSON-RPC namespace by its exported variable and uses `http://localhost:3001/cdk-blocks/api`. SQL guidance uses `npm run db -- types --block <id>` and `npm run db -- status --block <id>`.

- 5f55dac: New apps now create a user pool where users sign in with their email address, matched ignoring case: every template that constructs `Auth` passes `users: { signInWith: ['email'], caseSensitive: false }`. Cognito fixes both settings when the pool is created, and this is the pool shape Amplify's client libraries expect, so an app can add an Amplify frontend later without a new pool. The email is now the username: sign-up asks for an email address and no separate username, and the UI shows the user's email. The scaffolded `AGENTS.md` explains the shape and that it can't change after the pool exists.
- 5f55dac: New apps now use the unified `Auth` block. Every template that signs users in (`default`, `react`, `demo`, `api-only`, `sql` and the auth template) now uses `Auth` from `aws-cdk-blocks` instead of `AuthBasic` or `AuthCognito`. The block id stays `'auth'`.

  **Sign-up now needs the emailed code.** A new account confirms its email address with a 6-digit code, then the user is signed in automatically, with no second password entry. With `AuthBasic`, users were signed in as soon as they signed up. When you run locally (`npm run dev`), no email is sent: the code is printed in the terminal, and each template's e2e tests read it from `.bb-data/`. Once deployed, Amazon Cognito emails the code. Its default sender is limited to 50 emails a day.

  **The `auth-cognito` template is now `auth`.** There is one auth block now, so the template is named for what it shows: email sign-up with a code, groups with `requireRole`, profile attributes, password change and sign-out everywhere. `--template auth-cognito` still works and scaffolds `auth`. The template now signs in with email + password instead of a passwordless email code, because Cognito can only send that code through Amazon SES, which a user pool created by the block doesn't have.

  The `amplify` overlay's token verifier now implements the `BlocksAuth` interface and throws the same error names as `Auth` (`NotAuthenticatedException`, `NotAuthorizedException`), and its `requireGroup()` is now `requireRole()`. The `AGENTS.md` scaffolded into every app explains how to configure `Auth`, gate methods with `requireAuth` / `requireRole`, and where the `Auth` docs live.

- f32185c: Add the `blocks dashboard` command, which starts the Blocks Admin UI against the app it is run from on a free loopback port and opens it with a session token. `blocks dashboard doctor` diagnoses the app and prints a report instead, for when the server will not start. Accepts `--port`, `--profile`, `--region`, `--project`, `--allow-origin` and `--json`, and rejects a flag whose value is another flag rather than silently accepting it.

  The dashboard is opt-in: `@aws-cdk-blocks/admin-ui` is resolved from the app and offered for install when missing, so an app that never runs it carries none of its dependencies. The default template gains an `npm run dashboard` script.

- 6d3077e: feat(templates): scaffold data models on `KVStore` with a `schema` and a `key`

  The default, react, api-only, auth-cognito, demo and bare templates and the scaffolded `AGENTS.md` now use `KVStore` with a declared key for records that an app lists or queries as a collection, in place of `DistributedTable`. Calls are key first (`todos.put({ userId, todoId }, todo)`), and `query` yields `{ key, value }` entries.

- e1e4844: Run AWS Blocks tasks with your app's package manager. New apps define tasks in `package.json` without generating launcher files or installing the `cdk-blocks` executable. Look up documentation with `npm run docs KVStore`, read the API signatures with `npm run docs:api KVStore`, or search with `npm run docs:search "partition key"`.

  Structured task results print text in a terminal and JSON on a pipe or redirect. Use `npm run -s docs KVStore` for clean JSON without npm's banner, or `npm run -s docs -- KVStore --output text` to pipe Markdown. Scripts that previously invoked `cdk-blocks` must switch to package tasks; scripts calling the programmatic `aws-cdk-blocks/scripts` entry remain supported.

  If your app's scripts call `cdk-blocks`, upgrade `aws-cdk-blocks` first. From the app directory, preview the migration without relying on the removed executable:

  ```sh
  node --input-type=module -e "import 'aws-cdk-blocks/run'" -- migrate --dry-run
  ```

  Review the plan, then run the same command without `--dry-run` from a clean Git working tree. The migration rewrites recognized generated scripts and reports custom wrappers that need manual changes.

- 8894669: **Breaking: the `telemetry` app task is gone.** A scaffolded app no longer gets a `"telemetry"` package script, and `npm run migrate` no longer adds one, so `npm run telemetry` in a new or migrated app fails with npm's "Missing script" error.

  The task ran the `telemetry` command, which is removed along with `AWS_BLOCKS_DISABLE_TELEMETRY`, the `blocks-telemetry` binary and the `telemetry.enabled` key in `.blocks/config.json`. Telemetry now follows your CDK CLI telemetry setting: opt out with `CDK_DISABLE_CLI_TELEMETRY` set to `1` or `true`, with `cdk cli-telemetry --disable`, or with `cli-telemetry: false` in the `context` of `cdk.json` or `~/.cdk.json`.

  13 of the 14 `create-blocks-app` templates shipped the script and no longer do, and the example `package.json` in the create-blocks-app README no longer lists it. The `amplify` template is an overlay and defines no `scripts` of its own, so it never had it. An existing app keeps the script it was scaffolded with; `npm run migrate` does not remove it.

### Patch Changes

- d18846c: feat: add an `agent` template with a deterministic e2e test

  `npx @aws-cdk-blocks/create-blocks-app my-app --template agent` scaffolds an AI Agent
  with a tool and `Auth`-gated chat. Locally it runs on the built-in
  `canned` provider, a deterministic fake model that needs no AWS account and no
  LLM, so the shipped e2e test drives a plain-text turn and a tool-calling turn
  over the real RPC boundary and checks the tool's side effect landed.

- 4ff7fd3: The `AGENTS.md` that `create-blocks-app` adds to every new app now covers facts that coding agents often missed in the block docs:

  - **Namespaces:** a requested call such as `orders.create(...)` maps to an exported `orders` namespace.
  - **Errors:** a named `ApiError` reaches the client with its status and name, while a plain `Error` becomes an unnamed `500`.
  - **Client-side imports:** browser code and tests import `ApiError` and `isBlocksError` from `aws-cdk-blocks/client`, because `aws-cdk-blocks` exports nothing under the browser condition. Check `instanceof ApiError` before reading `.status`.
  - **Missing items:** `get()` returns `null` for a missing item, and `FileBucket.getUrl()` does not check that the file exists.

  The Quick Reference now lists which imports come from `aws-cdk-blocks` and which from `aws-cdk-blocks/client`. The workflow explains how `npm run test:e2e` starts and stops its own dev server on the configured port.

- cef2f8c: Docs: refer to the project as AWS CDK Blocks in AGENTS.md.
- 1ff5bcc: docs: tell agents to read a block's README first in the generated `AGENTS.md`

  The docs bullet and the matching rule no longer ask agents to read `API.md` and `DESIGN.md` whenever they exist. Agents read the block's `README.md` first, open `API.md` only for an exact signature or type, and open `DESIGN.md` only when they are stuck or need implementation details.

- d46dfaf: fix: the Amplify overlay keeps its own `cdk-blocks/client.js` under `npm run dev`

  - create-blocks-app's Amplify overlay now writes `"generateClient": false` in `package.json#blocks.dev`, next to `"port": 3001` and `"frontend": false`. Without it, the dev server replaced the overlay's committed `client.js`, which reads the API URL from `amplify_outputs.json` and adds the Cognito token, with the generic client.
  - `npm run migrate` adds the same `"generateClient": false` when it moves the Amplify overlay's generated `server.ts` to `blocks.dev`. Other templates are unchanged.
  - `npm run migrate` sets `blocks.dev` to `{"port": 3001, "frontend": false, "generateClient": false}` for an Amplify overlay from create-blocks-app 0.1.0 to 0.1.15 too, which has no `server.ts`, unless `blocks.dev` already exists. Migrate tells such an app by its generated `cdk-blocks/scripts/generate-client.ts`.

- dc5dbdb: The `api-only` template now ships a public `GET /healthz` `RawRoute` that answers load balancers and uptime monitors with a plain, uncached JSON response, since those probes can't send JSON-RPC. Its e2e tests call the route over HTTP, so the template suite now covers `RawRoute` too.
- 2eb62fa: The `hasAuthError` example in the `@aws-cdk-blocks/core` README and JSDoc now submits the action with `submitAuthAction` from `aws-cdk-blocks/ui` and imports `hasAuthError` from `aws-cdk-blocks/client`. The old example called `authApi.setAuthState()` directly, which signs the user in but never notifies `onAuthChange` or `AuthenticatedContent`, so a custom form built from it stayed on the sign-in screen. The `installCookieJar` documentation from `aws-cdk-blocks/utils` now shows up in editors, because it is attached to the function instead of an internal variable.

  The `AGENTS.md` that `create-blocks-app` adds to new apps now says that `onAuthChange` fires for sign-ins and sign-outs made through `Authenticator` or `submitAuthAction`, lists `submitAuthAction` for custom auth forms, and warns that a direct `authApi.setAuthState()` call notifies nothing on the page.

- 5f55dac: The sign-in UI now shows a signed-in user's email address instead of a generated id. When users sign in with their email or phone number (`users: { signInWith: ['email'] }`), Amazon Cognito gives each user a generated username (a UUID), and the `Authenticator` and `AccountMenuBar` showed that UUID ("Signed in as: 815424a9-…").

  `AuthState.user` now has an optional `displayName`, which `Auth` sets in the signed-in state:

  - a username the user chose stays as it is;
  - otherwise it is the user's email address, then their phone number (each skipped if the session's ID token marks it unverified, as it does for an email the user changed with `updateUserAttributes` and hasn't confirmed yet), then `preferred_username`, then the username.

  The `Authenticator` and `AccountMenuBar` show `displayName`, and fall back to `username` when it is absent. `displayName` is for display only, so keep keying data on `userId` / `userSub`. Only the signed-in caller's own state carries it, never a signed-out or mid-sign-in state. Users returned by `requireAuth()` and `getCurrentUser()` don't have it; read `user.attributes.email` on the server instead.

  The `auth` template's status line now shows `displayName` directly.

- a139031: New `auth-oidc` template: sign-in through an OpenID Connect provider with `Auth`'s `store: 'builtin'`, so your backend verifies each sign-in and no Cognito user pool is created. Locally and on sandboxes it signs in through `stubIdp()`, and production uses a `type: 'oidc'` entry you point at your own provider.

  Its e2e drives the full authorize → callback → session flow over HTTP and checks that a protected call then succeeds.

- dabb3f2: The `auth-oidc` template now ships a favicon, its cdk watch ignores the generated `cdk-blocks/client.js`, and its e2e test runs against a deployed app when you set `TEST_URL`, calling the dev server it starts or reuses otherwise, never a URL a deploy recorded.
- 5f55dac: feat(bb-auth): `Auth` options: a block-level `store` and one `providers` map

  `Auth` options start with where your users live. A block-level `store` picks it, and every sign-in provider goes in one `providers` map, keyed by provider id and tagged with its `type`:

  ```ts
  // The default store (omit `store`): users live in a Cognito user pool.
  const auth = new Auth(scope, "auth", {
    providers: {
      google: {
        type: "google",
        clientId: "your-google-client-id",
        clientSecret: googleSecret,
      },
      entra: {
        type: "oidc",
        issuer: "https://login.microsoftonline.com/<tenant>/v2.0",
        clientId: "entra-client-id",
        clientSecret: entraSecret,
      },
      corp: {
        type: "saml",
        metadataUrl: "https://idp.example.com/saml/metadata",
      },
    },
  });

  // store: 'builtin': no user pool; your backend verifies each provider itself.
  const sso = new Auth(scope, "sso", {
    store: "builtin",
    providers: {
      okta: {
        type: "oidc",
        issuer: "https://dev-12345.okta.com",
        clientId: "0oa-your-client-id",
      },
      github: github({ clientId: "Iv1.abc", clientSecret: githubSecret }),
    },
    // Both blocks have providers, so this one gets its own sign-in routes.
    redirects: {
      callbackPath: "/cdk-blocks/auth/sso/callback",
      signOutPath: "/cdk-blocks/auth/sso/signout",
    },
  });
  ```

  - **`store: 'cognito'`** (the default, so `new Auth(scope, 'auth')` needs no options): email + password, `mfa`, `passkeys`, `admin`, `userPool`, `email`, and `providers` of `type: 'google' | 'facebook' | 'amazon' | 'apple' | 'saml' | 'oidc'`. A `type: 'oidc'` entry federates through Cognito and requires `clientSecret`. A social entry is keyed by its type (`google: { type: 'google', … }`).
  - **`store: 'builtin'`**: no user pool. Users live at their identity provider, and the block keeps only its session table. `providers` of `type: 'oidc'` (`clientSecret` optional, so public PKCE-only clients work), `github()` / `customOauth2()` (`type: 'oauth2'`) and `stubIdp()` (`type: 'stub'`). `users` takes only `groups`, `allowBearerAuth: true` accepts the provider's access token, and `validateUser` runs at sign-in only. `emailPassword` (other than `false`), `mfa`, `passkeys`, `admin`, `userPool` and `codeDelivery` don't apply, and the signed-in user's `signInProvider` is one of the block's provider ids (never `'password'`).
  - **One block holds one kind of user.** A block cannot mix email + password users with backend-verified OIDC users. Use two `Auth` blocks, each with its own session cookie and `createApi()`, and let the frontend pick one per sign-in. When both have `providers`, give the second its own `redirects.callbackPath` / `signOutPath`, as `sso` above does.
  - **Checked at compile time, and again at runtime.** A wrong combination is a compile error. Most name the fix in their type, such as `ERROR_needs_store_cognito<'emailPassword'>` under `store: 'builtin'`. `stubIdp()`, `github()` or `customOauth2()` on the default store is a compile error too (`'"stub"' is not assignable to '"oidc"'`): add `store: 'builtin'`. The constructor rejects the same combinations with a readable message in `npm run dev`, at synth and in Lambda. It also rejects what the compiler can't see, such as options built from JSON, a `providers` value that isn't an object of provider entries, or a social entry keyed differently from its type. A default-store block with `emailPassword: false` and no provider fails in `npm run dev`, at synth and in Lambda.
  - **Editor help on a `'builtin'` block.** The options it refuses (`mfa`, `admin`, `userPool`, `users.signInWith`, …) are marked `@deprecated`, so completions list them last and struck through; `emailPassword` stays unmarked, since `false` is allowed. `allowBearerAuth: { clientIds }` there names the fix (`ERROR_needs_store_cognito<'allowBearerAuth (object form)'>`). A `providers` map picked per environment (`isProd ? { okta: … } : { local: stubIdp() }`) keeps both provider ids narrow for `getSignInUrl()` and `requireRole()`.
  - **Checked at synth.** On both stores, synth checks `redirects` (`callbackPath` / `signOutPath` must be explicit paths under `/cdk-blocks/auth/`, not the bare prefix) and `postSignInPath` / `postSignOutPath`, and rejects a provider id containing `/`. Two blocks of one backend that would mount the same sign-in or sign-out routes (both with `providers` on the default `redirects`), or two `stubIdp()` providers under the same key, fail synth naming both blocks, and at runtime the stub case names the fix rather than a bare `DuplicateRouteException`. A plain string as a `'builtin'` provider's `clientSecret` is refused at construction. On the default store, a `type: 'oidc'` entry with an empty or falsy `clientSecret` (`''`, `0`, `false`), or an `attributesRequestMethod` other than `'GET'` / `'POST'`, is refused at construction in `npm run dev`, at synth and in Lambda.
  - **Docs and messages.** `allowBearerAuth` and `validateUser` say that a bearer token is verified per request and does not run `validateUser`, so gate per request when you rely on it. An option error never echoes a string value longer than 8 characters, including a `store` or a provider `type` (a misplaced token prints as `a string (40 characters)`). A provider whose id names an `Object.prototype` member (such as `constructor`) gets the default label "Sign in with Constructor".
  - **`bb-auth migrate`** rewrites `AuthBasic`, `AuthCognito` and `AuthOIDC` blocks to this shape. A block constructed from a class the app re-exports through its own module (`export { AuthBasic } from '@aws-blocks/bb-auth-basic'`, `export *` of an old package) gets the same option mapping, kept defaults and TODOs as a direct import. `AuthBasic` blocks keep their password policy: each character class it left unset is written as `false` (`Auth` requires all four by default). A local `export { AuthCognitoErrors }` of a renamed import becomes `export { AuthErrors as AuthCognitoErrors }`. An `AuthOIDC` `providers` array with a spread is kept as is, with a TODO. Each moved `stubIdp()` gets a TODO that `Auth` refuses it on a production deployment, and `stubIdp({ name: 'dev' })` becomes `stubIdp()`. A provider factory called outside the block, a `require()` of an old package, and an `AuthBasicUser` import in a project that never reads `createdAt` get accurate TODOs (none, for the last). `migrate <path>` with a path that doesn't exist exits 2.
  - **Stable identifiers.** Construct ids, user-id formats (`userId` / `userSub` for pool users, `` `${issuer}:${sub}` `` for `'builtin'` users), the session format, and the client-side provider ids and routes (`getSignInUrl(context, '<id>')`, `signIn:<id>`) depend on the provider keys and block ids, not on how the options are written. An `AuthCognito` app keeps its construct ids, so nothing deployed is replaced.

  Also updated: the umbrella README's sign-in method guide (`aws-cdk-blocks`), the `Auth` snippet and RLS notes in the generated `MIGRATION_GUIDE.md` from `db pull` (`@aws-blocks/bb-data`), the `Secret` README's provider-secret note (`@aws-cdk-blocks/bb-secret`), the scaffolded `AGENTS.md` (`@aws-cdk-blocks/create-blocks-app`), and the `AuthAction.unavailable` example (`@aws-cdk-blocks/auth-common`), whose hint reads "…or use stubIdp() in a store: 'builtin' block locally."

- 5f55dac: `Auth` has `protect()`, for an API namespace that is deny by default. `auth.protect(scope, 'notesApi', { public: (context) => ({ ...methods }), methods: (context, user) => ({ ...methods }) })` returns an ordinary `ApiNamespace`. For each call to one of its `methods`, the session is checked first, and only then is the `methods` factory called, once, with the signed-in user, typed by the block's options (`AuthenticatedUser<O>`). So nothing in it runs for a signed-out caller, and a forgotten guard, or one called without `await`, can't leave a method open. A signed-out call to any name that isn't a `public` method gets 401 `NotAuthenticatedException`, whether or not the method exists, so the protected methods can't be listed without a session; a signed-in caller gets "method not found" for an unknown name. `public` methods (optional) run as in a plain `ApiNamespace`. A name defined in both is a compile error. With `{ role: 'admin' }` as the last argument, every protected method also requires that group, as `requireRole` does (401 first, then 403 `NotAuthorizedException`); `compute` and every other `ApiNamespace` option go in the same object and are passed on to the namespace. It works the same locally and on AWS, and the frontend calls every method like any other namespace. Existing `ApiNamespace` code is unchanged.

  The OpenRPC spec (`blocks-generate-spec`) describes every method of a `protect()` namespace, public and protected, and warns, naming the namespace, if it can't list them. It also now describes the parameters of a namespace typed through a mapped type, such as one returned by a factory, by name and type, instead of as a single `args` parameter.

  The `Auth` README has a "Protect every method" recipe. The `ApiNamespace` docs and the scaffolded `AGENTS.md` now recommend `auth.protect` for namespaces with signed-in methods, and say that a guard which isn't awaited protects nothing. The templates don't add a floating-promise lint rule: Biome's `noFloatingPromises` doesn't flag an un-awaited `requireAuth` / `requireRole` call, so `protect` is the safeguard.

- d46dfaf: fix: the auth template's e2e tests pin the client to the dev server or TEST_URL

  - The auth template's `test/e2e.test.ts` now sets `BLOCKS_API_URL` to the dev server (or `TEST_URL`) before it imports `cdk-blocks`, reads `TEST_URL`, and starts no dev server when `TEST_URL` names a deployed app — the same guard every other template got, so `npm run test:e2e` after a deploy never signs up users in the deployed stack.
  - The template guard in `cli.test.ts` anchors on the awaited `import('cdk-blocks')`, not a `typeof import(…)` type annotation, so a template that declares its module type inline is still checked.

- a0bc7ec: The `auth` template now turns on optional MFA with an authenticator app (TOTP): a user who sets one up is asked for its code at sign-in, and everyone else signs in with their password as before. Locally the template checks those codes as Cognito does, and its end-to-end tests cover setting up an authenticator app and signing in with it.
- 5f55dac: fix(create-blocks-app): show todo and last-code errors in the `auth` template

  In the `auth` template, a failed toggle, priority change, title edit or delete previously did nothing visible, and a failed title edit left the unsaved text in the input. These now reload the list, so the row shows the saved value again, and report the failure in the existing todo status line. A failed "Show last code" lookup now shows an error instead of an unhandled rejection.

- 684e22d: feat(blocks): `npm run dev` starts the Nuxt and Astro dev servers

  Without a `frontendCommand`, `npm run dev` and `npm run sandbox` now detect `nuxt` and `astro` in the app's dependencies, as they detect `next` and `vite`, and start `npx nuxt dev --host 127.0.0.1 --port <frontendPort> --strictPort` or `npx astro dev --host 127.0.0.1 --port <frontendPort>`. Before, a Nuxt or Astro app without `blocks.dev.frontendCommand` got the backend only, and every page answered 404.

  The first match wins, in the order `next`, `nuxt`, `astro`, `vite`, so a Nuxt or Astro app that also lists `vite` now runs its own dev server instead of `npx vite`. A SvelteKit app lists `vite`, and is started with it as before. To keep a Nuxt or Astro app backend-only, set `"blocks": { "dev": { "frontend": false } }` in `package.json` or pass `--no-frontend`; a `frontendCommand` you set still wins over detection.

  Upgrade note: an app that runs `npm run dev` for the backend only and starts `nuxt dev` or `astro dev` itself (for example through `concurrently`) now gets a second frontend dev server for the same project on `frontendPort`. Two Nuxt dev servers in one project write the same `.nuxt` directory. Remove the app's own frontend process, or set `"blocks": { "dev": { "frontend": false } }`.

  Every detected command, `vite` included (now `npx vite --host 127.0.0.1 --port <frontendPort> --strictPort`), binds `127.0.0.1` explicitly, so a `HOST` variable in the environment or a `host` setting in the framework's config does not expose the frontend dev server to the network. Vite and Nuxt 4 exit when `frontendPort` is taken. Nuxt 3 and Astro move to another port, which they print, and the app answers 502 until the port is free or you choose another with `--frontend-port`.

  `npm run migrate` still leaves `frontendCommand` out of `blocks.dev` for a generated `server.ts` whose dev server `npm run dev` detects from the app's dependencies, although the detected `vite` command now adds `--host 127.0.0.1`.

- 792e269: Migration moves recognized generated script wrappers to package tasks and carries generated dev settings into `package.json#blocks.dev`. It keeps customized wrappers and wrappers still referenced by app or workspace automation, and does not overwrite concurrent `package.json` changes. Preview the plan with `--dry-run`; migration requires a clean tracked working tree unless forced. The structured result lists rewrites, removed and retained wrappers, and dev configuration.
- 041af90: Scaffolded apps now pin every `@aws-cdk-blocks/*` dependency to a caret range on the release line this CLI version was tested with (for example `"aws-cdk-blocks": "^0.9.0"`) instead of `"*"`. This covers fresh projects from every template, the `cdk-blocks/` workspace added to an Amplify Gen 2 project, and adding AWS Blocks to an existing project. A clean reinstall now stays on the release line the app was created with and picks up later releases on that line; moving to a new (pre-1.0: breaking) release line is your choice. A range your existing project already lists in `dependencies` is kept.

  `@aws-cdk-blocks/create-blocks-app` is now released with every `aws-cdk-blocks` release and has the same version number, so this release skips ahead to blocks' version. The latest CLI therefore starts a new app on the latest `aws-cdk-blocks` release.

  The `cdk-blocks/` workspace added to an Amplify Gen 2 project now imports `KVStore` from `aws-cdk-blocks` and no longer lists `@aws-cdk-blocks/bb-kv-store` as a dependency of its own.

  Apps scaffolded with an earlier version still declare `"*"`, so their next clean install can pull a breaking release. To pin yours, replace each `"*"` for an `@aws-cdk-blocks/*` package in `package.json` (and in `cdk-blocks/package.json`, if present) with a caret range for the version you have installed, for example `"^0.9.0"` (`npm ls aws-cdk-blocks` shows it), then run `npm install`.

- 02c1589: fix(create-blocks-app): gate the remaining public template methods and git-ignore secrets when adding Blocks to an existing project

  - The `api-only` template's `createUploadUrl` / `createDownloadUrl` now call
    `auth.requireAuth(context)` and scope the path to the caller, so a signed-out
    caller can no longer mint presigned URLs to read or write any file in the
    bucket.
  - The `demo` template's SQL ledger methods (`openAccount`, `balanceOf`,
    `transfer`) now call `auth.requireAuth(context)`, and accounts belong to the
    signed-in user (a new `owner` column in `accounts`), so a caller can only
    read and move money between their own accounts. `transfer` declines a
    non-positive amount, which previously slipped past the overdraft guard, and
    an amount that is not a finite number (a numeric string passed `> 0`).
  - The `demo` template's `searchDocs` now calls `auth.requireAuth(context)`: on
    deploy each query is a billed Bedrock retrieval.
  - The `demo` and `auth-cognito` templates' `updateTodo` copies only `completed`,
    `priority` and `title` from `updates`. It spread the whole argument, so a
    caller could set the owner key and write a todo into another user's list.
  - Adding Blocks to an existing project (or an Amplify Gen 2 app) now appends
    `.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key`, `*.p12`,
    `credentials` files (not `credentials/` directories), and `.aws/` to its
    `.gitignore`, the same patterns the templates ship. Entries are compared as
    whole lines, so an existing `.env.local` no longer stops `.env` being added.
    The `.env.example` / `credentials/` exceptions are left out when the project's
    own `.gitignore` could already ignore those names, so they never un-ignore them.
    A project that un-ignores `.env` (`!.env`) gets `.env` ignored again, and
    `.env.*` also ignores new `.env.development` / `.env.production` files (files
    git already tracks stay tracked). The plan and the `Modified .gitignore` line
    now list the entries added, and a CRLF `.gitignore` keeps CRLF line endings.
  - The `api-only` and `demo` templates keep FileBucket versioning on (the
    default), so an overwritten or deleted file can be restored, and the
    `api-only` template's `createUploadUrl` and the `demo` template's
    `getUploadSlot` sign only an explicit list of content types
    (`ALLOWED_UPLOAD_TYPES`).

- a34c850: AWS Blocks app documentation tasks read the documentation shipped with the installed version of `aws-cdk-blocks`, including in hoisted workspaces. Run `npm run docs` to list blocks and guides, `npm run docs KVStore` to read a block README, `npm run docs:api KVStore` for API details, or `npm run docs:search KVStore` to search the installed docs. Use `npm run docs:api Auth.protect` to find inherited members and their declarations. Lookups use installed declarations and report unknown names with suggestions. Paths like `bb-cron-job/DESIGN.md` select a specific document without referring to `node_modules`.

  Documentation lookups include typed imports, declarations, README context, inherited members, section headings, and installed declaration files omitted from API reports. Export discovery covers the umbrella package and its client, UI, utils, server, and theme entries. Unknown names, sections, and files give usage errors with suggestions; searches with no matches exit 1. Structured results include document paths and Markdown text, not paths inside node_modules. Terminal output is readable text; pipes and redirects default to JSON. Use `npm run -s docs KVStore` for clean JSON, or `npm run -s docs -- KVStore --output text` to pipe Markdown.

- 5938d8b: CLI output now names the project AWS CDK Blocks: `create-blocks-app` progress and help text, the `blocks` CLI errors, status lines and docs output, and the first-run telemetry notice. The `.gitignore` section that `create-blocks-app` adds to an existing project is headed `# AWS CDK Blocks`.
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

- d46dfaf: fix(core,create-blocks-app): `npm run deploy` works while `npm run sandbox` watches the same app

  `npm run deploy` failed every time `npm run sandbox` watch ran in the app, with `Another CLI (PID=…) is currently synthing to cdk.out`: the deploy regenerates `cdk-blocks/client.js`, the sandbox's `cdk watch` saw the change and started a synth, and both used `./cdk.out`. Nothing said that the other CLI was the sandbox.

  - The sandbox's `cdk watch` now synthesizes into `.cdk-blocks-sandbox/cdk.out` (`--output`), as its first deploy does, never into the `./cdk.out` of `npm run deploy`.
  - The templates' `cdk.json` `watch.exclude` lists `cdk-blocks/client.js`, which the deployed backend doesn't use, so regenerating it starts no watch deploy. Existing apps can add `"cdk-blocks/client.js"` to `watch.exclude` in their `cdk.json`.
  - A sandbox deploy or a sandbox destroy (`npm run sandbox:deploy`, a second `npm run sandbox`, `npm run sandbox:destroy`) refuses to start while a `npm run sandbox` of the app is running, before it reaches AWS: `A \`npm run sandbox\` is running in this app (pid …, dev server on :3000), and its cdk watch deploys every change to the sandbox. Stop it first, with Ctrl-C in its terminal or \`npm run dev:stop -- --port 3000\`, then re-run …`. New exports: `assertNoRunningSandbox()`from the sandbox module, and`liveSandboxSession()`from`@aws-cdk-blocks/core/scripts/dev-pidfile`.

- cd533c0: A stack name that starts with `aws` in any letter case is now an error at synth, for `BlocksStack` and for a `BlocksBackend` inside such a stack. The message names the stack, the two AWS Resource Groups that AWS Blocks names after it, and the fix: use a name that does not start with `aws`; in a scaffolded app, change `stackId` in `.blocks/config.json`. Before, `cdk deploy` failed in CloudFormation with `Group name must not start with 'AWS'` after other resources were created. `cdk synth`, `cdk diff` and `cdk deploy` stop on the error. `cdk destroy` and `cdk ls` do not, so a stack that such a deploy left behind can still be removed. A `stackId` written by hand is never changed.

  The `AGENTS.md` that `create-blocks-app` adds to new apps states the rule.

- 5f55dac: The `auth` template's `api` namespace is now defined with `auth.protect`: its signed-in methods run only after the session check, with the signed-in user, and `ping` and `getLastCode` are its `public` methods. The frontend and the scaffolded e2e tests call it as before. One behaviour change: `signOutEverywhere` now needs a session, so an anonymous call answers `401 NotAuthenticatedException` instead of clearing the cookie and returning `{ success: true }`. The template's frontend calls it only from the signed-in UI.
- 5f55dac: The e2e tests of new apps now use the new `getLastAuthCode` and `createTestClient` helpers from `aws-cdk-blocks/utils`.

  - Tests read each sign-up code with `getLastAuthCode`. Previously they read `.bb-data/my-app-auth/last-code.json` directly, a path that breaks when the scope or the block is renamed.
  - The "another user can neither see nor change them" tests keep two users signed in at once, instead of signing out and back in.

- 5f55dac: The `auth` template's role-gated section now shows the `npx @aws-cdk-blocks/bb-auth users add-to-group` command.
- ba80bbd: fix(create-blocks-app): fail on a failed install, and fix scaffolds that did not work

  - `create-blocks-app` exits 1 when a step such as `npm install` fails, instead of printing the error and exiting 0, so `npx @aws-cdk-blocks/create-blocks-app app && cd app` stops at the failed scaffold.
  - The `nextjs` template's `.gitignore` ignores `.open-next/` (the deploy's build output) and `*.tsbuildinfo` (written by `next build`).
  - Adding AWS Blocks to an existing project adds `zod` to its dependencies, at the template's version, when the copied `cdk-blocks/` backend imports it. Before, `zod` resolved only when another package happened to hoist it.
  - Scaffolding into a workspace of an npm workspaces monorepo stops before it writes anything, unless the monorepo root also lists the app's `cdk-blocks/` folder, and prints the `"workspaces"` entry to add; once the root lists it, `npm install` runs at the root, where npm links the app's `cdk-blocks` package. npm installs a workspace's dependencies at the root and ignores the app's nested `"workspaces": ["aws-blocks"]`, so before this the scaffold reported success with an app that could not import `cdk-blocks`.
  - To find that root, `create-blocks-app` reads each `"workspaces"` glob as npm does, with `minimatch`: a brace glob such as `"{apps,packages}/*"` includes `apps/web`, and an entry such as `"!packages/legacy"` leaves that folder out of the workspaces, unless a later entry lists it again, so an app there installs in its own folder.
  - `npm run test:e2e` can run again and again against one running dev server, as `AGENTS.md` suggests: it exits when the tests finish (`--test-force-exit`) instead of hanging on the realtime client's open socket, and the `default` and `react` tests sign up a new user each run instead of a fixed `testuser@example.com`, which the persisted local auth store already had on the second run.
  - The scaffolded `AGENTS.md` matches the app's dev server: its local API URLs use the `package.json` `"blocks.dev.port"` (3001 in the backend-only `api-only`, `backend` and `sql` templates, instead of 3000), and a backend-only app's workflow no longer tells the agent to edit a frontend in `src/`.
  - Every template that has `npm run secret` also has `npm run config` (`npm run config`), which the release notes promised, and its README lists it.

- cd533c0: `create-blocks-app` no longer writes a `stackId` that starts with `aws` to `.blocks/config.json`. A name that starts with `aws` in any letter case, such as a directory named `aws-demo` or a package named `AWS-Shop`, now gets the prefix `app-`, as a name that starts with a digit does: `aws-demo` gives `app-aws-demo-9f3a2b`. Before, the deploy of such an app failed in CloudFormation after other resources were created, because AWS Resource Groups refuses a group name that starts with `AWS` and each stack names two groups after itself. A name that does not start with `aws` gives the same `stackId` as before. Existing apps are not changed.
- 5f55dac: Scaffolded apps no longer describe the removed `AuthBasic` block: the generated `AGENTS.md` said that `AuthBasic` without `codeDelivery` signs the user in at sign-up, and now says that every sign-up confirms its email with a code and `codeDelivery` only receives the code locally. The templates no longer use `any`: the React template infers its `User` type from the backend's `authApi` and types its realtime subscription, the demo template exposes its page handlers with `Object.assign(window, …)` and reads caught errors through `isBlocksError` and `Error`, and the Amplify overlay types the backend it receives. A new test fails when a template or resource names a removed auth block or uses `: any` / `as any`.
- 05a88e1: When AWS denies the credential check before `npm run deploy` and `npm run sandbox`, for example when a profile's role cannot be assumed, the warning now says so instead of reporting an unverified check, and says whether an AWS Organizations policy (a service control policy or a resource control policy) explicitly denied the request. It still does not stop the command, and it never includes the error's account IDs, ARNs or policy IDs.

  A credential failure message now names the profile and the deployment Region. When the fix is `aws login` and the profile has no Region or a different one, the message first prints `aws configure set region <region> --profile <name>`, so that the sign-in uses the Region you deploy to, and says to sign in again after a later Region change. If the profile's Region is set in the AWS credentials file, which overrides the config file that `aws configure set` writes, the message asks you to change it there instead. When `AWS_REGION` or `AWS_DEFAULT_REGION` names another Region than the deployment, which the AWS CLI would use instead, the `aws login` command includes `--region <region>`.

- 9009efa: feat: add a `cron` template with scheduled CronJobs

  `npx @aws-cdk-blocks/create-blocks-app my-app --template cron` scaffolds a
  backend-only app with a `CronJob` that runs every minute and records each run
  in a `KVStore`, plus a disabled job that shows `enabled: false`. The shipped
  e2e test waits for the first scheduled run and checks that the disabled job
  never fires.

- a63c3a5: fix(create-blocks-app): keep todo errors visible in the demo template

  In the demo template, a failed toggle, priority change or title edit showed its error and then reloaded the list, and the reload cleared the error straight away. The list now reloads first and the error is shown afterwards, so it stays on screen.

- d01c34c: docs: fix two stale references

  - The FileBucket README's access-control examples construct `new Auth(scope, 'auth')` (from `@aws-cdk-blocks/bb-auth`) instead of the removed `AuthBasic`.
  - The scaffolded `AGENTS.md` no longer says to import `ApiError` and the typed client from `aws-cdk-blocks`, whose browser build exports nothing: `ApiNamespace` comes from `aws-cdk-blocks` in the backend, and `ApiError` / `isBlocksError` from `aws-cdk-blocks/client` in frontend code and tests.

- 0ff1e1f: docs: the `auth` template README states that `--template auth-cognito` is an alias for `auth`
- 450e25f: `EmailClient` now warns at synth when `fromAddress` is on a reserved domain that SES can never verify (`example.com`, `example.net`, `example.org` and their subdomains, or anything under `.test`, `.example`, `.invalid` or `.localhost`), since every send from such an address fails once deployed. The warning id is `@aws-cdk-blocks/bb-email-client:UnverifiableSender`, raised in sandbox and production, and can be acknowledged. A `replyTo` address on a reserved domain gets `@aws-cdk-blocks/bb-email-client:UndeliverableReplyTo`. For a reserved sender, this warning replaces the generic "must be verified in SES" console notice, so synth prints one message. The demo template no longer sends from `noreply@example.com`: its sender is an `EMAIL_SENDER` constant with a `.invalid` placeholder to replace with a verified SES identity before deploying to production.
- c3aecc5: Adding AWS Blocks to an existing project now makes sure `node_modules` is git-ignored. The CLI adds dependencies, so a project with no `.gitignore`, or one that did not ignore `node_modules`, had the directory staged by the next `git add -A` after `npm install`. A `.gitignore` that already ignores it with a literal line (`node_modules`, `node_modules/`, `/node_modules`, `node_modules/*`, `**/node_modules`, or `*`) is left as it is, and so is one that explicitly un-ignores it (`!node_modules`). Any other form gets the line added; a duplicate does no harm.
- c6a59f4: chore(hosting,create-blocks-app): build Next.js with OpenNext 4.1

  - The Next.js adapter is verified against `@opennextjs/aws` `>=3.10.0 <3.11.0 || >=4.0.0 <4.2.0`, so 4.1.x no longer prints the out-of-range warning.
  - An app that doesn't declare `@opennextjs/aws` builds with 4.1.14 instead of 4.0.3. Its `next` peer range is `>=15.5.28 <16 || >=16.4.1`, so the build warns for `next` versions below that.
  - The `create-blocks-app` `nextjs` template declares `@opennextjs/aws` `~4.1.14`.

- 2b144de: feat: add an `observability` template with Logger, Metrics, Tracer and Dashboard

  `npx @aws-cdk-blocks/create-blocks-app my-app --template observability` scaffolds a
  backend-only app whose `placeOrder` method, gated by `Auth`, writes a
  structured log line, emits an `OrdersPlaced` metric and runs inside a trace
  segment, with a CloudWatch
  Dashboard over the metric. The shipped e2e test checks all four locally: the
  log and EMF metric lines in the dev server's output, the saved trace, and the
  dashboard route.

- 5a31d94: The `react` template's e2e now checks that creating, reprioritizing and deleting a todo each reach a live Realtime subscriber. The `demo` template's EmailClient e2e now checks the sent mail's recipient, sender, subject and body in the local outbox, and that an invalid address is rejected.
- 42b84b2: feat(bb-realtime): add `getChannel(namespace, channel, { scope: 'exact' })` and validate channel names

  A channel handle's token authorizes its channel and every `/`-separated sub-channel under it, so a handle for `tenants/acme` also opens `tenants/acme/billing`. This was not documented, so a naming scheme that nests one principal's channels under another's could hand out more access than intended.

  - **`getChannel()` takes an optional `{ scope }`.** `'subtree'` is the default and keeps today's behaviour. `{ scope: 'exact' }` mints a token that authorizes the channel only; a subscribe to any sub-channel with it is rejected. `GetChannelOptions` is exported from `@aws-cdk-blocks/bb-realtime` and `aws-cdk-blocks`.
  - **Tokens stay compatible.** The default token is byte-for-byte the format issued before, so tokens from an older deployment keep validating with the same scope. An exact token carries its channel under a new `exact` key instead of `channel`, so a deployment from before this release refuses it (the handle stops working) rather than granting it sub-channel access, for example on a warm container during an update or after a rollback. Native clients pass tokens through unchanged.
  - **Channel names are validated.** `publish()`, `subscribe()` and `getChannel()` now throw `RealtimeErrors.ValidationFailed` for a channel name that is empty, starts or ends with `/`, contains an empty segment (`a//b`), or has a `.` or `..` segment, and for a channel that isn't a string or a number (`undefined`, `null`, an object). `/` between non-empty segments is still allowed, and a number is validated as its string form. If your app builds channel names from user input, check that the result can't be empty or contain these segments.
  - **bb-agent `stream()` and `resume()`** throw `AgentErrors.InvalidUsage` before dispatching a turn when the `channelId` and `userId` don't form a valid channel name (for example a `channelId` of `a//b` or a `userId` of `..`), instead of returning a stream whose chunks all fail to publish.
  - **The `default` and `react` create-blocks-app templates** pass `encodeURIComponent(user.username)` as the channel name, so a username can't add `/` segments.
  - **Server-side `subscribe()`** now uses an exact token for its own WebSocket subscription; it only ever subscribes to that one channel, so nothing changes for callers.

  The README's new "Sub-channels and access" section explains how a channel name maps to access, with the per-tenant pitfall as the example. Use `{ scope: 'exact' }` whenever a sub-channel of a handle's channel can belong to someone else.

- 5f55dac: The scaffolded `AGENTS.md` no longer contradicts itself about API namespaces: a method is called as `<exported name>.<method>` (`export const api = new ApiNamespace(…)` → `api.*`), not by the second argument to `new ApiNamespace(…)`.
- e286b16: docs(telemetry): make the first-run telemetry notice describe exactly what is collected

  The notice printed the first time the CLI or `create-blocks-app` collects usage data said the data was anonymous and that no personal data was collected. It now lists what an event can include: random installation and project IDs, and an event ID and timestamp; the command, its outcome, duration and error category (never the error message); your OS, Node.js version and package manager user agent; whether it ran in CI or under a coding agent; the AWS Blocks and CDK versions, the framework, and the template name and version; and the names and versions of the official Building Blocks the app uses, how many Building Blocks it uses, and how many of them are custom (custom Building Block names are never sent). It says that events never include names, email addresses, AWS account IDs, ARNs, file paths, file contents or source code, and that, as with any HTTPS request, the collection endpoint also receives your IP address.

  The notice names the opt-out, which is CDK's. The `aws-cdk-blocks` README describes the same in its CLI section.

  What is collected and when has not changed.

- c00ab16: docs(telemetry): state the retention periods in the first-run notice

  The first-run telemetry notice printed by the CLI and `create-blocks-app`, and the `aws-cdk-blocks` README, now say that the collection endpoint does not store your IP address, except in logs of requests that its firewall blocks, and that events are kept for up to 1 year and logs of all requests, blocked or not, for up to 10 years.

- 5247488: The commented `KVStore` example in the `bare` template now shows a secondary index (`indexes` is an object keyed by index name, not an array), a point read with `get()` that takes the whole key as an object, and a newest-first index query with `order: 'desc'` (the values are `'asc'` and `'desc'`). The `api-only` template's items table gains the same index and sort-order notes as comments.
- aaf473e: fix(create-blocks-app): load the generated client only after the dev server is ready in template e2e tests

  When `npm run test:e2e` started the dev server itself, the test imported `cdk-blocks` before the server had regenerated `cdk-blocks/client.js`. An API namespace you had exported since the client was last generated was then `undefined` in the test, and calls to it failed with `Cannot read properties of undefined` on that run. The test now waits for the server to answer before it imports the client, and no longer pauses for a fixed two seconds after starting the server. The Next.js template already created its client after the server was ready and is unchanged.

- 1b18478: Scaffolded apps with a frontend now ship a favicon, so the browser no longer gets a `/favicon.ico` 404 on every page load. The Vite templates (`default`, `react`, `bare`, `auth`, `agent`, `demo`) add `public/favicon.svg` and link it from `index.html`; the `nextjs` template adds `src/app/icon.svg`, which the App Router links automatically.
- 9434f01: The `cdk-blocks/index.ts` scaffolded by the `bare`, `backend`, `nextjs` and `cron` templates now explains that clients call an API by its export name (`api.greet()`), so a new client namespace such as `orders.create()` needs its own `export const orders = new ApiNamespace(...)`, and that the constructor's second argument is only a label. The commented `KVStore` example in the `bare` template also notes that the partition key and sort key together identify an item.
- 475054b: The `test/e2e.test.ts` file in new apps no longer hides the global `setTimeout`. It imported `setTimeout` from `node:timers/promises` under that name, so a test you added that called `setTimeout(() => …, ms)` failed with a type error. The promise version is now imported as `sleep`.
- 5f55dac: Templates: per-user data is keyed on `userSub`, and `updateTodo` can no longer write into another user's list.

  - **`updateTodo` (`demo`, `auth`)** spread the caller's `updates` object over the stored todo. The RPC layer passes through properties the TypeScript signature doesn't declare, so a crafted request could set the todo's key fields and overwrite or create a todo in someone else's list. It now copies only `completed`, `priority` and `title`. If you scaffolded an app from either template, make the same change to its `updateTodo`.
  - **Keyed on `userSub`** (`default`, `react`, `demo`, `api-only`, `sql`, and the commented example in `bare`): per-user rows used the username as their owner key. They now use `user.userSub`, the id that stays the same for the user's lifetime, as the `auth` template already did. The todo field is renamed from `userId` to `userSub`. This only affects newly scaffolded apps.
  - Each template's e2e tests now check that a second user can't list, read, update or delete the first user's items.

- 1ade81b: The `api-only` template README now has a "Security model" section: every API method is a public endpoint until you gate it with `auth.requireAuth(context)`, and a presigned URL lets whoever holds it read or write that key until it expires. The template security tests now check every template, so any method that signs a URL (`getUrl`, `putUrl`, `getFileHandle`, `createUploadHandle`) must start with `requireAuth` or `requireRole`.

## 0.4.0

### Minor Changes

- b16e5b6: feat(create-blocks-app): add a one-shot `npm run sandbox:deploy` script to every deployable template

  `npm run sandbox` deploys and then keeps running (CDK watch plus the local dev server), so it never exits and can't be used from scripts or CI. The new `npm run sandbox:deploy` runs the same sandbox script with `--deploy-only`: it deploys once, writes `.blocks-sandbox/config.json`, prints the `BLOCKS_DEPLOYED api=…` line, generates the typed client, and exits. Wait for exit code 0 rather than for the line, since the client is generated after it. `npm run sandbox` is unchanged. The template READMEs and the scaffolded `AGENTS.md` list the new script.

  Existing apps can adopt it by adding `deployOnly: process.argv.includes('--deploy-only')` to the `startSandbox({ ... })` call in `aws-blocks/scripts/sandbox.ts`, and a `"sandbox:deploy": "tsx aws-blocks/scripts/sandbox.ts --deploy-only"` script to `package.json`.

- d79a0bd: feat(core,create-blocks-app): `npm run sandbox:preview` deploys a hosted preview sandbox

  `startSandbox({ preview: true })` now synthesizes and deploys with `--context previewMode=true` next to `sandboxMode=true` (the key is exported as `PREVIEW_MODE_CONTEXT`), prints the hosted site URL (and `url=` on its `BLOCKS_DEPLOYED` line), and on a re-deploy hotswaps a backend-only change (a changed frontend build or an infrastructure change does a full deploy). A preview sandbox is deploy-only: it exits after the deploy, with no `cdk watch` and no local dev server. The app decides what the signal does.

  The `create-blocks-app` templates that include hosting (`default`, `bare`, `react`, `nextjs`, `auth-cognito`, `demo`) add a `sandbox:preview` script (`tsx aws-blocks/scripts/sandbox.ts --preview`) and add `Hosting` with `HostingPresets.preview` to a preview sandbox. A plain `npm run sandbox` stays backend-only, and `npm run deploy` deploys the full shape. `sandbox`, `sandbox:deploy` and `sandbox:preview` deploy one stack, so a plain sandbox deploy removes the preview; it prints a warning with the preview URL first. Tear a preview sandbox down with `npm run sandbox:destroy`.

- 82ea78a: A project config can no longer re-enable telemetry that a global config disabled.

  `isTelemetryEnabled()` returned early on a project `telemetry.enabled: true` before reading `~/.blocks/config.json`, so `blocks-telemetry --disable --global` followed by `--enable` left the send gate open while `--status` reported disabled. The gate now resolves through `getTelemetryStatus()`, so only `false` short-circuits and the two cannot disagree. `blocks-telemetry --enable` also warns, naming the mechanism, when a broader opt-out still applies. The env var already overrode both config files, and a project `false` still beats a global `true`.

  Behavior change (0.x minor = breaking channel): if you globally disabled telemetry and relied on a project config to turn it back on, that project stays opted out. Re-enable globally with `npx blocks-telemetry --enable --global`.

### Patch Changes

- 2f85a1b: docs: point the generated `AGENTS.md` at a docs index instead of a guessed folder

  The docs bullet now gives one command that lists the docs folders and prints the block catalog from the docs `README.md`, so agents read folder names (for example `bb-distributed-table`) instead of guessing them from a `<block>/README.md` placeholder. It also names `core/README.md` for `ApiNamespace`, `ApiError` and the typed client, and says to import them from `@aws-blocks/blocks`.

- d8d46e8: The `AGENTS.md` that `create-blocks-app` adds to every new app now covers live data. It recommends `Realtime` for pushing updates, and gives rules and a typed snippet for polling safely: one call in flight at a time (a `setTimeout` chain, never a fixed `setInterval`), a pause while the tab is hidden with an immediate refresh when it's visible again, one call per tick, backoff on errors, and a stop function that drops late responses.
- 2d78849: Scaffolded `AGENTS.md` now states which storage block to use: default to `DistributedTable` for app records you list or query as a collection, and use `KVStore` for values you read and write by one key.
- 34e758c: Stabilize the CLI telemetry HTTP test by waiting for delivery instead of a fixed delay and cleaning up its local server and temporary files even when the test fails or times out.
- 6a94537: New apps created from the `bare` template now include `zod` in their dependencies, so the template's commented Zod examples no longer need a separate `npm install zod`. When you add AWS Blocks to an existing project with `--template bare`, the example comment still tells you to run `npm install zod`.
- 9fa8e37: fix(create-blocks-app): ship secure defaults in the demo and auth-cognito templates and every template `.gitignore`

  - The sample `getValue` / `setValue` key-value methods in the `demo` and
    `auth-cognito` templates now call `auth.requireAuth(context)` and namespace
    keys per user, so they are no longer public, internet-reachable endpoints.
  - The `demo` template's other sample methods that write data, return the
    sample secret, or send email (`getUploadSlot` / `getFileHandle`, `setFlag`,
    `rotateApiKey` / `getApiKey` / `getPreviousApiKey` / `apiKeyVersionCount`,
    `sendWelcome`, `runGreetingJob`) now call `auth.requireAuth(context)`, and file paths are scoped
    per user.
  - The `demo` template's cookie round-trip methods no longer let callers choose
    the cookie name: `setCookie(value)` / `getCookie()` / `deleteCookie()` use a
    single fixed-name `HttpOnly; SameSite=Lax` cookie (plus `Secure` except on
    plain-HTTP localhost) with a URI-encoded value (previously a caller-named
    `SameSite=None` cookie readable by page scripts).
  - Every template `.gitignore` now ignores `.env`, `.env.*` (except
    `.env.example`), `*.pem`, `*.key`, `*.p12`, `credentials` files (not
    `credentials/` directories), and `.aws/`.

- 50b8c94: `npm run deploy` and `npm run sandbox` now check that CDK has been bootstrapped in the target account and Region before they synthesize. In an account and Region that were never bootstrapped, a deploy used to fail only after synthesis, with `SSM parameter /cdk-bootstrap/hnb659fds/version not found`. The commands now read that parameter, with the credentials that the credential check verified and the qualifier from `@aws-cdk/core:bootstrapQualifier` in the CDK context, and stop right away with the command that bootstraps the account and Region: `npx cdk bootstrap aws://<account-id>/<region> --app=`. `--app=` keeps CDK from synthesizing the app to find environments. The commands never bootstrap for you, because bootstrapping creates IAM roles in the account. Only a missing parameter stops the deploy; a denied read, a network error or a timeout does not. The destroy commands do not run this check.
- 42591d2: Git-ignore `.bb-data/` in the `nextjs` template and when adding AWS Blocks to an existing project or an Amplify Gen 2 project. That directory holds local dev state, including every `AppSetting` and secret value in `.bb-data/settings.json`, so `git add .` could commit local secret values.
- 19c3b94: feat(create-blocks-app): show todo errors in the default template with the StatusMessage UI primitive

  The default template previously gave no feedback when loading, adding, or deleting a todo failed — the list simply did not change. It now reports those failures in a shared `StatusMessage` region (a polite ARIA live region themed by the `--bb-*` design tokens), which clears on the next successful action. A failed add keeps the typed title in the input so it can be retried.

- 8527195: Add a DistributedDatabase (SQL) atomic-transfer e2e to the demo template, raising daily canary coverage to 12/20 Building Blocks.
- d621235: test(demo): add canary e2e for Secret and KnowledgeBase

  The `demo` template now exercises two more Building Blocks through
  mock-runnable e2e tests (no AWS): Secret (set, rotate, read the previous value
  across the rotation grace window, and confirm two labeled versions) and
  KnowledgeBase (semantic search over a small committed `knowledge/` corpus,
  asserting the billing query retrieves `billing.md` over the unrelated shipping
  doc). Raises the daily canary's Building Block coverage without changing any
  template runtime behavior.

- 1c977b5: feat(create-blocks-app): adopt the StatusMessage UI primitive in the demo template

  The demo template's KV, cookie, and todo-error surfaces previously rendered status lines by writing raw `innerHTML` with `<span class="error">` / `<span class="success">` markup and a hand-rolled `escapeHtml`. They now use the shared `StatusMessage` primitive from `@aws-blocks/blocks/ui` (the same one the `auth-cognito` template adopted), driven through small `showMessage` / `showError` helpers:

  - **Accessibility:** each status surface is now a polite ARIA live region (`role="status"`, `aria-live="polite"`) that is pre-mounted once and mutated in place, so a screen reader announces every result — previously those result divs had no ARIA at all.
  - **Theming:** status colors come from the shared `--bb-*` design tokens and match the active light/dark theme automatically; the dead `.success` / `.error` CSS rules are removed.
  - **Safety:** status text is set via `textContent` rather than interpolated into `innerHTML`, removing an escaping burden on the status path. A missing key/cookie now renders as a neutral `idle` result rather than a danger-red error.

  The todo-list and "run all tests" summary continue to render their own (non-status) DOM and are unchanged.

- d366907: chore: manual dependency bump (2026-10-19)
- d062eeb: Before they deploy, `npm run deploy` and `npm run sandbox` now print the deployment target: the credentials that CDK deploys with (an AWS profile, access keys from the environment, or container or web identity credentials) and the configured Region. As in CDK, access keys from the environment (including the `AMAZON_` names that CDK also reads) are used before `AWS_PROFILE` unless `cdk.json` sets a profile; the credential check now verifies those keys rather than the profile. When the credential check succeeds, they also show the account name and the AWS account plan (Free or Paid, with its status), read with the same credentials that the check verified. These reads are optional and never stop a deploy. If they are denied, unsupported, empty, malformed or take longer than 2.5 seconds, the value shows as "not available". Account IDs, ARNs, error text and plan credits are not printed. `npm run destroy` and `npm run sandbox:destroy` print only the deployment target.

  When the credentials are the AWS-managed role from the new AWS sign-up experience (a role at the path `/managed/` that `account-access.amazonaws.com` can assume, read with `iam:GetRole`), the output also has a one-line link to `https://settings.aws.com/billing` for spend limits, with a reminder to check that the project selected there matches the deployment target. Other credentials, or a role that cannot be read in time, get no link. When a profile has no Region, the warning now explains how to use `aws login`: set the profile Region to your project's Region before you sign in, and sign in again after you change it.

  `@aws-blocks/core` now depends on `@aws-sdk/client-account`, `@aws-sdk/client-freetier` and `@aws-sdk/client-iam`. They load only when a deploy command runs.

- 63b154f: feat(core): multi-compute routing — per-namespace RPC paths + shared-gateway fan-out

  Make the shared REST API gateway route each API namespace to the compute that hosts it, in two parts.

  **Per-namespace paths.** The typed RPC client now POSTs to `/aws-blocks/api/{namespace}` (the namespace in the path) instead of the shared `/aws-blocks/api` — a gateway routes by URL path, not the JSON-RPC body, so giving each namespace its own path is what lets one gateway fan out to multiple computes. `{namespace}` is the backend export name. The body still carries `namespace.method`, and that is what the runtime handler and the local dev server dispatch: a per-namespace path must be exactly `/aws-blocks/api/{namespace}` and name the same namespace, or the request is rejected with a JSON-RPC `-32600` Invalid Request rather than silently running either one. `POST /aws-blocks/api` keeps working unchanged, so raw HTTP callers that use it are unaffected.

  Migration note for `ApiNamespaceClientOptions.url`: pass the **base** URL (e.g. `/aws-blocks/api`, or `https://d123.cloudfront.net/aws-blocks/api`) — the client now appends `/{namespace}` itself. A pre-qualified URL that already includes the namespace routes to `{url}/{namespace}` and is not supported.

  Deploy order: a web client built with this release calls `/aws-blocks/api/{namespace}`, which needs the gateway resource this release adds. Deploy the backend before, or together with, clients built against it; a gateway deployed from an earlier release may reject the per-namespace path (403). If you run your own proxy or rewrite in front of the API (nginx, a framework rewrite, your own CloudFront behavior), make it forward the whole `/aws-blocks/api/*` subtree, not just the exact `/aws-blocks/api` path — `Hosting` already does.

  The native clients call the same per-namespace paths from `aws-blocks-swift` 0.2.0, `aws-blocks-kotlin` 0.3.0 and the next Dart `blocks_runtime` release. Native clients from earlier releases POST to the bare `/aws-blocks/api` URL, which keeps working and runs every call on the default compute.

  **Gateway fan-out.** The shared gateway now routes each namespace's path to the compute that hosts it. The default compute's function stays behind the catch-all resources, so the RPC root, auth, `RawRoute`s, and any namespace left on the default compute all reach it; a new `/aws-blocks/api/{proxy+}` resource carries the per-namespace RPC paths for those namespaces. Every non-default compute gets its own Lambda integration plus a literal `/aws-blocks/api/{namespace}` (`ANY`) resource for each namespace it hosts. A literal resource wins over the sibling `{proxy+}`, so requests fan out within a single gateway — and a single CloudFront origin under `apiFrontDoor: 'cloudfront'`. Routes key on each namespace's export name — what the client calls — read from the backend module after it is imported, and each namespace's compute is resolved then (the namespace's own `compute` option, else the compute of the scope it was built in). A non-default compute's function gets one API-scoped invoke permission however many namespaces it hosts. Synth fails with a clear error for a namespace on a compute that takes no API traffic, or for an export name API Gateway can't use as a path segment.

  For an app that gives no namespace its own compute (every app before the `ApiNamespace` `{ compute }` option), every namespace resolves to the default compute and the only synthesized change is the additive `/aws-blocks/api/{proxy+}` resource; existing gateway resources keep their logical IDs. The `createSharedGateway` signature (it now takes the per-compute namespace routes + default compute) is `@internal`, and so is the `ComputeBase.namespaces` list this replaces.

- 3ae22e6: fix(hosting): build Next.js apps with a verified OpenNext version, and explain Edge-route and version mismatches

  - **`@opennextjs/aws` not installed.** Hosting declares OpenNext as an optional peer dependency, so nothing installs it for the app, and a bare `npx @opennextjs/aws build` downloaded the newest release, which is often outside the version range the Next.js adapter is verified against. When the project doesn't declare it, the adapter now builds with `@opennextjs/aws@4.0.3` and prints the command to declare it (`npm install --save-dev @opennextjs/aws@~4.0.3`). If that build fails, it throws `OpenNextNotFoundError` with the same command. Before this change that error could never be raised.
  - **Next.js outside OpenNext's `next` peer range.** When the app's `next` version is outside the range the building OpenNext declares (for example `next@15.5.7` with `@opennextjs/aws@4.0.3`, which requires `>=15.5.18 <16 || >=16.2.6`), the adapter now prints a warning naming both versions and the range. Package managers that skip peer checks would otherwise build an untested pair without a word.
  - **Edge routes on a stack without a region.** A Next.js route with `runtime = 'edge'` is built as Lambda@Edge, which needs the stack's region at synth time. On a stack with no explicit `env.region`, synth failed with CDK's `stacks which use EdgeFunctions must have an explicitly set region`. Hosting now throws `EdgeComputeRequiresRegionError`, which names the route's compute and shows the `env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }` fix.
  - **Package versions in workspaces and monorepos.** The Next.js, Astro, Nuxt and SvelteKit adapters now read `next`, `@opennextjs/aws`, `astro`, `@astrojs/node`, `nitropack`, `@nuxt/image`, `@sveltejs/kit` and `@sveltejs/adapter-node` from the app's own directory. They previously started at its parent, so an app that pins a different version than the one hoisted to the workspace root got the root's version. For example, a Next.js 15 app under a root `next@16` had the Next.js 16 image-optimizer patch applied and missed the peer-range warning.
  - **Local images on Next.js 15.5.16+ and 16.2.0–16.2.4.** The adapter patches OpenNext's call to Next.js's `fetchInternalImage` when Next.js takes an extra `maximumResponseBody` argument. It decided by major version (patch on 16, skip on 15), but that argument arrived in patch releases: it is in 15.5.16 and later, and in 16.2.5 and later, but not in 16.0.x, 16.1.x or 16.2.0–16.2.4. So `/_next/image` returned 500 (`TypeError: … is not a function`) for local images on Next.js 15.5.16+ and on 16.2.3–16.2.4. The adapter now reads the signature from the installed `next` (falling back to those version boundaries).
  - The `@opennextjs/aws` peer dependency range is now bounded: `>=3.10.0 <5.0.0`.
  - `@aws-blocks/create-blocks-app`: the `nextjs` template declares `@opennextjs/aws` (`~4.0.3`) as a devDependency, so new Next.js apps build with a pinned, verified OpenNext.

- ca60fc2: feat(create-blocks-app): show greet errors in the Next.js template with the StatusMessage UI primitive

  The Next.js template's client greeting previously gave no feedback when the greet call failed — the button stopped loading and nothing appeared. It now reports the failure in a shared `StatusMessage` region (a polite ARIA live region themed by the `--bb-*` design tokens), which clears on the next successful greet.

- 276e365: feat(create-blocks-app): show todo errors in the React template with the StatusMessage UI primitive

  The React template previously gave no feedback when loading, adding, or deleting a todo failed — the list simply did not change. It now reports those failures in a shared `StatusMessage` region (a polite ARIA live region themed by the `--bb-*` design tokens), which clears on the next successful action. A failed add keeps the typed title in the input so it can be retried.

- 890f15f: Templates: the `nextjs` template now wraps each page section in a `SectionBoundary` error boundary (`src/app/section-boundary.tsx`), so a section that fails, such as a Server Component whose API call throws, shows an inline error with a retry button instead of replacing the whole page through the route-level `error.tsx`. The `demo` template's `index.html` now declares `<meta charset="utf-8">`, so hosts that serve HTML without a charset no longer make the browser decode the page as windows-1252.

  Existing apps can adopt both: copy `section-boundary.tsx` into `src/app/` and wrap each section's content in `<SectionBoundary>`, and add `<meta charset="utf-8">` as the first element of `<head>`.

- f704a68: feat(auth-common): add the `StatusMessage` UI primitive

  Adds `StatusMessage` to `@aws-blocks/auth-common/ui` (re-exported from `@aws-blocks/blocks/ui`) — a themed, accessible status line for the loading / success / error affordance the starter templates otherwise hand-roll with inline styles.

  - `StatusMessage(options?)` returns a `StatusMessageHandle` (`{ element, set }`): mount `element`, then drive it with `set(kind, text)` as an async operation progresses.
  - Four lifecycle states (`StatusKind`): `idle` (muted), `loading` (muted + spinner), `success` (green), `error` (red) — all driven by the existing `--bb-*` semantic tokens, so the message matches the active light/dark theme.
  - The root is a polite ARIA live region (`role="status"`, `aria-live="polite"`); the `loading` spinner is decorative (`aria-hidden`) and holds still under `prefers-reduced-motion`.
  - Adds the `.bb-status*` / `.bb-spinner` classes and a reduced-motion-aware `bb-spin` keyframe to the shared theme CSS.
  - The `auth-cognito` template now renders its status lines through `StatusMessage` instead of a hand-built classed span.

  No breaking changes — purely additive.

## 0.3.0

### Minor Changes

- 8f725b6: fix(bb-data): enable Aurora storage encryption, backup retention, and log export

  Hardens the Aurora Serverless v2 cluster synthesized by `Database`:

  - **Storage encryption at rest** is opt-in via the
    `@aws-blocks/bb-data:encryptStorageByDefault` context flag — set in the new
    `create-blocks-app` cdk.json templates, so new projects encrypt by default with
    the AWS-managed `aws/rds` key. A new optional `storageEncryptionKeyArn` (the ARN
    of a customer-managed KMS key) turns encryption on regardless of the flag and
    also encrypts the auto-generated credentials secret. When neither is set, the
    `StorageEncrypted` property is left unset (so an existing cluster is untouched)
    and a synth warning explains how to opt in.
  - **Automated backups** are on by default and retained **15 days**; this is also
    the point-in-time-recovery window. A single `pointInTimeRecovery` option
    controls it (mirroring every other Blocks block): `true` enables the 15-day
    window, `{ retentionDays: n }` pins a 1–35-day window, and `false` clamps to the
    1-day minimum (Aurora cannot disable automated backups). When omitted it follows
    the stack-wide `defaults.pointInTimeRecovery` (on under `production`, off under
    `sandbox`).
  - **CloudWatch log export** — the PostgreSQL engine log is exported to CloudWatch
    Logs, with retention following the stack-wide `defaults.logRetention`.
  - `iamAuthentication` remains intentionally off (access is exclusively via the RDS
    Data API), and automatic secret rotation is documented as a follow-up.

  `@aws-blocks/create-blocks-app` scaffolds this default into new projects: every
  template's `cdk.json` now sets the `@aws-blocks/bb-data:encryptStorageByDefault`
  context flag, and the Amplify overlay sets the same flag via `setContext`. As a
  result, a `Database` created in a newly scaffolded project encrypts its storage at
  rest by default.

  **Breaking for existing stacks (0.x minor = breaking channel):** the
  backup-retention and CloudWatch log-export changes alter synthesized cluster
  properties, so existing stacks will show a CloudFormation diff.

  Storage encryption is **opt-in** specifically so it does **not** silently replace
  existing clusters: with neither the context flag nor a `storageEncryptionKeyArn`
  set, the `StorageEncrypted` property is left unset and the existing cluster is
  untouched. Opting in (setting the flag, or supplying a key) on an
  already-provisioned, unencrypted cluster requires a **replacement**, and the
  replacement is destructive: RDS cannot encrypt an existing cluster in place, so
  CloudFormation creates a **new, empty** encrypted cluster and repoints the stack.
  There is no in-place path. The migration CustomResource does **not** re-run on a
  cluster swap — its only CloudFormation properties are the service token and the
  migrations hash, neither of which changes when the cluster is replaced — so the new
  cluster comes up with **no schema**; migrations run only when a migration file
  changes (which changes the migrations hash). Under production (RETAIN) the old
  cluster is orphaned/unreferenced; under sandbox (DESTROY) it and its data are
  deleted; under `removalPolicy: 'snapshot'` it is snapshotted as it is replaced
  (though under production's `deletionProtection: true` the follow-up delete may fail
  and leave it in place, unverified on a real deploy). The only safe route is to
  snapshot the existing cluster, restore it with encryption enabled, then cut over.
  Review the diff and snapshot before deploying. The replacement is symmetric:
  turning encryption back off — removing the flag (or `storageEncryptionKeyArn`) from
  a project that already deployed encrypted, e.g. deleting the cdk.json line or a
  merge dropping it — also changes `StorageEncrypted` and so likewise replaces the
  cluster (back to unencrypted), with the same new-empty-cluster / no-schema outcome.

- 4ae500e: feat(create-blocks-app): add a dev:stop command for the local dev server

  Adds a first-class, sanctioned way to stop the local dev server, so there is an
  alternative to `pkill -f tsx` / `killall node` — which match by process name and
  can kill the caller's own shell/agent process.

  - `@aws-blocks/core/scripts` (re-exported by `@aws-blocks/blocks/scripts`) gains
    `stopDevServer`, the CLI entry `runStopCli`, `stopMessage`, and the
    `StopResult` type. Stop acts ONLY on the supervisor identity the dev server
    recorded in its own pidfile (`{pid, ppid, port}`): it SIGTERMs the recorded
    `tsx watch` watcher — the only thing that actually ends `npm run dev` — and
    falls back to the recorded child's listener tree only when the watcher is
    gone. It never scans a port and signals an arbitrary listener, so a stale
    pidfile or an unrelated same-port process is never touched, and the pidfile is
    removed only once the port is confirmed free. Idempotent; never throws;
    `runStopCli` exits non-zero when the stop leaves the port bound.

  - `@aws-blocks/create-blocks-app`: every standalone template gains a `dev:stop`
    npm script and a thin `stop.ts` wrapper; the existing-project and Amplify
    integration paths get `dev:stop` / `blocks:stop` too. The scaffolded
    `AGENTS.md` and the singleton-guard message point at `npm run dev:stop`
    instead of `pkill` / the blunt cleanup script.

- 6d764f7: `AWS_BLOCKS_DISABLE_TELEMETRY` now accepts `true` and `yes` in addition to `1` (case-insensitive, trimmed).

  Previously only the exact value `1` disabled telemetry, so `AWS_BLOCKS_DISABLE_TELEMETRY=true` kept telemetry on. Both packages now accept `1`, `true` and `yes`; `0`, `false`, empty and unset keep telemetry enabled. The `blocks-telemetry --help` output lists the accepted values, and the D-010 usage note in `docs/DECISIONS.md` is updated to match.

  Behavior change (0.x minor = breaking channel): if you already export `AWS_BLOCKS_DISABLE_TELEMETRY=true` or `=yes` for another tool, Blocks telemetry is now disabled where it was previously still on.

- 122c49c: fix(telemetry): honor opt-out when `--telemetry-file` is set

  The flag let an opted-out run build an event, which persisted the installation ID to `~/.blocks/telemetry/installation-id` and printed the first-run notice, and in `@aws-blocks/core` also persisted a project ID into `<project>/.blocks/config.json`. Consent is now checked before the event is built, and in `@aws-blocks/create-blocks-app` again before it is emitted, so an opt-out landing mid-command is honored too. A disabled run writes no identifiers, prints no notice, writes no file and sends no HTTP. `--telemetry-file` now also ignores a whitespace-only path in the space-separated form, matching the `=` form.

  Behavior change (0.x minor = breaking channel): to capture events without sending them, use `BLOCKS_TELEMETRY_ENDPOINT=http://127.0.0.1:1 <cmd> --telemetry-file=<path>` rather than combining the flag with `AWS_BLOCKS_DISABLE_TELEMETRY`. The detached send worker still runs and fails fast against port 1. That run is consented, so it still writes the installation ID and prints the notice.

- 66f4be2: Templates no longer set `BLOCKS_SANDBOX` or pass `crossDomain: process.env.BLOCKS_SANDBOX === 'true'` to the auth Building Block. `npm run sandbox` serves the app through the local dev server, which proxies to API Gateway, so the browser talks to `localhost` only and the default `SameSite=Lax` session cookie is correct. Set `crossDomain: true` yourself only when a frontend on a different registrable domain calls the API directly. The Amplify template passes its Cognito settings with `registerConfig` instead of `handler.addEnvironment`.

  Apps generated from an earlier template can delete the `if (sandboxMode) { blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true') }` block and the `crossDomain` line when upgrading `@aws-blocks/blocks`, since `blocksStack.handler` is removed.

### Patch Changes

- 299c0e9: docs(agents): spell out the auth frontend-mount outcome and a check in the scaffolded AGENTS.md

  The scaffolded `AGENTS.md` already shows the `Authenticator` + `onAuthChange`
  mount, but an agent could still provision the auth backend and stop there,
  leaving every gated route unreachable. Add a short, template-agnostic
  outcome + available-parts + check note: state that the backend renders no UI,
  name `Authenticator` and `AuthenticatedContent` as the parts to fit into
  whatever frontend the task has, and give a signed-out/signed-in check. Scope
  the stable testids to `AuthBasic`/`AuthCognito` and link `CUSTOMIZING-AUTH-UI.md`
  for the full contract (OIDC/federated actions carry a provider suffix).

  Documentation only — no runtime or API change.

- b8ec583: fix(create-blocks-app): set the storage-encryption flag in the api-only and sql templates

  The `api-only` and `sql` template `cdk.json` files did not set the
  `@aws-blocks/bb-data:encryptStorageByDefault` context flag, so new projects
  scaffolded from them started with Database storage encryption OFF — unlike every
  other template. Add the `context` flag (boolean `true`) to both, matching the
  other templates and the encrypt-by-default contract.

- 440ecce: When the AWS credential check before `npm run deploy` and `npm run sandbox` fails, the message now names the profile and the command that fixes its credentials. A profile without credentials gets sign-up and `aws login` guidance, with an AWS CLI install or update hint when the installed CLI does not have `aws login`. Expired `aws login` and IAM Identity Center (SSO) sessions get `aws login` or `aws sso login` for that profile. Rejected access keys, `credential_process`, web identity, a role assumed with environment keys, and environment credentials get guidance for that source. Rejected or expired credentials from outside the AWS config files, such as an instance role, get a hint to check that source instead of sign-up guidance. When AWS cannot be reached, including the SSO portal, the deploy still continues, and the warning now says that AWS could not be reached. The deploy docs and the generated app's `AGENTS.md` describe this behavior.

  `@aws-blocks/core` now requires AWS SDK for JavaScript clients 3.936.0 or later, the first version that reads credentials from `aws login` profiles.

- 5d6656a: feat(core): add the `apiFrontDoor` prop, the `cloudfront` tier, and `publicApiUrl`

  A Blocks app's API is served by the stack's single shared API Gateway REST API. By
  default clients call that gateway's own `execute-api` endpoint — the `'apigateway'`
  tier. You can now put a Blocks-managed CloudFront distribution in front of it
  instead, with a new prop on `BlocksStackProps` / `BlocksBackendProps`:

  ```ts
  await BlocksStack.create(app, "App", {
    // …
    apiFrontDoor: "cloudfront", // default: 'apigateway'
  });
  ```

  - `'apigateway'` — clients call the API Gateway endpoint directly. Nothing extra to
    deploy; unchanged from before.
  - `'cloudfront'` — one CloudFront distribution in front of the gateway (CloudFront →
    API Gateway → Lambda), and the gateway is built as a regional endpoint so there is
    a single CloudFront layer. One catch-all behavior forwards every request to the
    gateway — uncached, all methods, everything except `Host`, HTTP→HTTPS. The
    distribution's URL is published to the runtime as `BLOCKS_PUBLIC_ORIGIN`, so
    absolute URLs the backend builds (such as AuthOIDC's sign-in callback) use it.

  **`publicApiUrl`** on `BlocksStack` / `BlocksBackend` is the URL clients should call
  under either tier: the CloudFront URL + `/aws-blocks/api` under `'cloudfront'`, else
  `apiUrl`. `apiUrl` stays the gateway's own URL (what `Hosting` forwards to). A
  `BlocksStack`'s `ApiUrl` output — what `deploy` / `sandbox` hand a client as
  `BLOCKS_API_URL` — is `publicApiUrl`; with `BlocksBackend`, emit it yourself. The
  Amplify template now publishes `publicApiUrl` as `blocks_api_url`.

  The default is a constant `'apigateway'` — it is **never** derived from the app's
  shape, so adding or removing Building Blocks never silently changes how the API is
  exposed. Any value other than `'apigateway'` or `'cloudfront'` fails synth.

  When an app fronts its frontend with `Hosting`, the API is served from Hosting's
  distribution; under `'cloudfront'` the managed distribution then stands down — one
  distribution, same origin as the frontend, no CORS and no second hop.

  ⚠️ **Switching tiers — or adding or removing `Hosting` under `'cloudfront'` —
  changes the API's endpoint domain.** Browser auth cookies and sessions are bound to
  the origin they were set on, so the change signs every user out. (A stable custom
  domain, a future feature, would avoid this.) Pick a tier, and decide on Hosting,
  before you have real users, and treat a later change as a breaking migration.

- 38ce80c: fix: the local dev surface is no longer reachable from the network or from other websites

  - **Dev server binds loopback.** `npm run dev` now listens on `127.0.0.1` instead of every
    interface. It serves your whole API against local mock data with no authentication, so it
    must not be reachable from other machines. For a container or remote devbox, opt in with
    `BLOCKS_DEV_HOST=0.0.0.0` (or `startDevServer({ host })`); a warning is printed when the host
    isn't loopback.
  - **Local realtime WebSocket matches the deployed one.** A client-sent `publish` was broadcast
    to every subscriber with no authorization. The deployed WebSocket has no client publish, so
    the local server now rejects it as well; publish from the server with `Realtime.publish()`.
  - **Local realtime tokens are signed with a per-process random secret** instead of a constant
    published in this repository, so they can't be forged.
  - **The `/realtime` WebSocket upgrade checks `Origin`.** Only loopback origins can connect, plus
    the opted-in host: with `BLOCKS_DEV_HOST=0.0.0.0`, a same-origin page opened by IP address; with
    a concrete `BLOCKS_DEV_HOST` hostname, that hostname. This closes cross-site WebSocket hijacking from any
    page the developer visits. Non-browser clients that send no `Origin` still connect.
  - **`GET /aws-blocks/settings` opens an editor only under the local dev server.** It no longer
    spawns a process or echoes the working directory when the built-in routes run in a deployed
    Lambda, and it opens the file with `execFile` instead of a shell command.
  - **The `nextjs` template's frontend dev server binds loopback** (`next dev --hostname
127.0.0.1`), like the Blocks dev server.

- 002b063: Keep the Next.js starter E2E independent of the sample page title by checking the home page response and Blocks config endpoint. Validate the sample API separately, with guidance to update its test when replacing the sample methods.
- f1eb149: fix(telemetry): keep every event written to `--telemetry-file` instead of only the first

  The sink created the file with `O_CREAT | O_EXCL` and swallowed the resulting `EEXIST`, so a run that emitted more than one event recorded only the first. In `@aws-blocks/core` a `dev` server that retries a port bind emits `dev/FAIL` then `dev/SUCCESS`, and the success was lost. Events after the first are now appended to the same JSON array. A path that already existed when the run started is still left untouched. The container is unchanged — a JSON array, 2-space indented — so a consumer reading the first element is unaffected, but a file can now hold more than one event: anything asserting exactly one needs updating.

- 8ca3692: feat: shared, framework-neutral `ui-theme` design-token layer

  Introduce a design-token layer for the Blocks UI so the shared Auth
  components and the starter templates share one consistent, polished look
  with no new runtime framework dependency.

  - `@aws-blocks/auth-common` ships a new theme module: CSS custom
    properties (`--bb-*` for color, spacing, radius, typography, elevation)
    on `:root`, a light and dark palette driven by `prefers-color-scheme`
    with a `data-bb-theme` override hook, and base `.bb-*` component
    classes. The palette declares `color-scheme` so UA-drawn widgets
    (checkboxes, `<select>`, scrollbars, `::placeholder`, autofill) follow
    the active palette, and `.bb-button` has a `:disabled` state. A new
    idempotent, SSR-safe `injectTheme()` adds the stylesheet to the document
    once. The shared `Authenticator`, `AccountMenuBar`, and
    `AuthenticatedContent` now render against these token classes instead
    of inline styles and inject the theme themselves, so the themed look
    travels with the component into any host (lit-html, vanilla, React,
    Next.js) with zero wiring. Every `data-testid` is preserved.
  - `@aws-blocks/blocks` re-exports `injectTheme`, `THEME_CSS`, and
    `THEME_STYLE_ID` from `@aws-blocks/blocks/ui`, and adds a lean
    `@aws-blocks/blocks/theme` subpath that re-exports ONLY the token layer
    (no `Authenticator`/WebAuthn surface) for non-auth hosts. `@aws-blocks/auth-common`
    is marked `sideEffects: false` so a bundler can drop the unused UI
    surface; `@aws-blocks/blocks` is not, because as an aggregator that
    re-exports side-effecting building blocks it is not side-effect-free.
  - `@aws-blocks/create-blocks-app` templates (`default`, `react`,
    `nextjs`, `demo`, `auth-cognito`) adopt the tokens for their own page
    chrome and todo UI, so the whole page is themed and dark-mode-aware;
    the `bare` template stays deliberately minimal. The static templates
    inline the first-paint palette and the `nextjs` template server-renders
    the token `<style>` so a dark-mode user never sees a white flash before
    the bundle runs. A `--bb-color-success` token keeps success messages
    from reading as accent blue.

  Focus states use a real `outline` ring (preserved under forced-colors /
  Windows high-contrast mode) rather than an `outline: none` + `box-shadow`
  ring, which such modes drop.

  Additive and non-breaking.

- 7c19c4f: feat: `npm run deploy -- --wait-live` holds `BLOCKS_DEPLOYED` until the new build is actually served

  `cdk deploy` returning is not the same as the new frontend build being served.
  Two edge windows stay open after CloudFormation reports complete, and emitting
  `BLOCKS_DEPLOYED` while either is open lets a caller's immediate self-test hit a
  stale bundle and silently miss a regression.

  - **New opt-in `--wait-live` flag.** When set, `npm run deploy` only prints
    `BLOCKS_DEPLOYED` once the new build is confirmed live, so a request issued
    immediately after the signal returns the new asset.
  - **Per-build config match (the KVS cutover).** Each deploy stamps its build id
    into the runtime config (`/.blocks-sandbox/config.json`) and surfaces it as a
    `HostingBuildId` stack output; the poll declares the config live only when the
    body CloudFront serves carries that exact id, distinguishing the new build from
    a byte-identical config still served by an edge POP routing to the previous
    build during cutover — the common re-deploy case.
  - **Invalidation wait (the compute/SSR window).** For a compute deploy the `/*`
    CloudFront invalidation that flushes the previous build's edge-cached SSR HTML
    is fire-and-forget, so CloudFormation returns before it propagates. The deploy
    now surfaces the invalidation id as a `HostingInvalidationId` stack output and,
    under `--wait-live`, polls `GetInvalidation` until `Completed` before signalling
    — closing the window where the edge still serves old SSR HTML (referencing old
    hashed assets → 403). Pure-static deploys issue no invalidation and skip this.
  - **Bounded probing.** Each config probe carries a per-request timeout
    (`AbortSignal`), so one stalled response cannot hold the deploy past its budget.
    `--wait-live-timeout=<seconds>` tunes the overall budget (default 180); if
    liveness can't be confirmed in time, the deploy — which itself succeeded — prints
    a clear warning and exits non-zero rather than emitting a false "live" signal.
  - **No-op for backend-only apps** (no frontend to verify) and off by default, so the
    existing deploy flow is unchanged unless you opt in.

- 74e5581: fix(templates): make the scaffolded e2e dev-server spawn cross-platform on Windows

  Every template's `test/e2e.test.ts` started the dev server with
  `spawn('npm', [...])` and no shell, and tore it down with a POSIX
  process-group kill (`process.kill(-pid)`). On Windows `npm` is `npm.cmd`,
  which `child_process.spawn` cannot resolve without a shell, so the spawn threw
  `spawn npm ENOENT`, the server never started, and the readiness probe timed
  out — a customer running `npm run test:e2e` on Windows hit the same failure.
  The spawn now passes `shell: isWin`, uses `detached: !isWin` (process groups
  are POSIX-only), and the teardown reaps the tree with a synchronous
  `spawnSync('taskkill', ['/T', '/F'])` on Windows (so the process cannot exit
  before the reap completes) and keeps the existing graceful
  `process.kill(-pid, 'SIGTERM')` group kill on POSIX. Behaviour on macOS/Linux
  is unchanged.

## 0.2.0

### Minor Changes

- f066594: feat(create-blocks-app): add `sql` and `api-only` starter templates

  Two new headless scaffolds, so `npm create @aws-blocks/create-blocks-app` can
  start from a shape closer to what you are building:

  - **`sql`** — a PostgreSQL backend on the `Database` Building Block. A relational
    notebooks → notes model with a foreign key (`ON DELETE CASCADE`), per-user
    ownership, parameterized `sql` queries, and a transaction, defined in
    version-controlled `.sql` migrations. PGlite locally, Aurora Serverless v2 on
    deploy.
  - **`api-only`** — a headless JSON API service: a public health check plus an
    auth-gated CRUD resource over a `DistributedTable`, no frontend. The starting
    point for a backend behind a mobile app, CLI, or third-party client — a service
    skeleton, unlike the bare `backend` greet stub.

  Both are registered in the template list; `crud` and `realtime` are intentionally
  not added — the `default` and `demo` templates already ship full CRUD + auth +
  Realtime.

### Patch Changes

- bbd2c13: Front-load the scaffolded `AGENTS.md` with the framework model an agent needs before building.

  The scaffolded `AGENTS.md` previously pointed coding agents at the block docs folder and let them rediscover the framework wiring on every project. It now states the load-bearing facts inline: the backend-defines / frontend-imports-the-same-name client model (and the "don't import `index.ts` directly" pitfall), method namespacing (`namespace.method`), auth via `requireAuth` + the `@aws-blocks/blocks/ui` components, that the deployed frontend discovers the API through `/.blocks-sandbox/config.json` (no hardcoded URL), and a minimal end-to-end example. The full docs pointer is retained for depth. Reduces the doc-reading and wiring-discovery an agent does to get a first API call working.

- 18f4014: Template hygiene: add missing READMEs, fix the `react` spec script, drop a dead dependency.

  Three small fixes across the scaffolded templates:

  - **READMEs** — `demo`, `nextjs`, and `auth-cognito` had none, while every other
    non-overlay template ships one. Each now has a README with a description of what
    it demonstrates, the project structure, and the standard command block including
    the destroy commands. A scaffolded app is a copy-and-learn surface, so the README
    is the first thing a developer reads.
  - **`react` spec script** — the `react` template was the only one missing
    `"spec": "blocks-generate-spec"`, so `npm run spec` failed there while it worked
    in every sibling. Added, matching the sibling templates.
  - **`backend` dependency** — the `backend` template declared `@aws-blocks/hosting`
    but is frontend-less and imports nothing from it. Removed, matching the
    `api-only` and `sql` headless templates.

- a649895: Emit a machine-readable completion signal on a successful `npm run deploy` **and** `npm run sandbox`.

  `deploy()` now prints one stable last line — `BLOCKS_DEPLOYED url=<frontend> api=<backend>` (a backend-only app omits `url=`) — so a caller (a coding agent, a CI step, a script) can detect "deploy finished + where it lives" by grepping one line instead of parsing streamed CloudFormation output or polling the stack for the URL. `sandbox()` prints the same line on its success path (backend-only — `BLOCKS_DEPLOYED api=<backend>`, since the sandbox serves the frontend locally), so a programmatic caller greps the identical token after either command. The existing human-readable `✅ Deployment complete!` / `📡 API URL` / `🌐 Frontend URL` lines are unchanged; the signal is additive. The formatting is extracted into a pure `formatDeploySignal()` helper with unit coverage, shared by both entry points. The scaffolded `AGENTS.md` documents the line so agents grep it rather than poll.

  For `npm run deploy` specifically (which streams a real CloudFormation deploy), the heartbeat now also names the resource currently converging — e.g. `waiting on HostingDistribution (AWS::CloudFront::Distribution)` — and surfaces a rolling-back resource as a warning rather than silently clearing it, and the frontend URL is surfaced early (on the in-progress path) so a deploy killed at a caller timeout has still reported where the app lives.

- aeca8e6: Make the Next.js template run its local frontend with webpack so `npm run dev` renders the scaffolded app correctly with local Blocks workspace packages, and make the template e2e test start the dev server itself.
- e034e20: Make scaffolded starter e2e tests resilient to replacing the sample API.

  Six templates' `test/e2e.test.ts` (bare, backend, auth-cognito, demo, default, react) previously asserted against the sample API by name (`greet`, the KV `setValue`/`getValue`, or the todo CRUD suite). Removing or renaming that sample API — the first thing most projects do — immediately left a freshly-scaffolded app with a failing test before any real code was written. Each of these templates now ships an always-on, sample-API-independent readiness assertion that checks `/.blocks-sandbox/config.json`, so a fresh scaffold is validated end to end even before you touch the sample API. The sample-API assertions still run and assert against the shipped sample API, with a comment telling you to update or delete them when you replace it. The `default`/`react` readiness loops also stop depending on the sample auth API. Complements the readiness-loop decoupling shipped earlier.

- a23b8d8: Stop leaking raw backend exception details in RPC error responses, while forwarding Building Block error names AND their BB-authored messages.

  `errorResponseFromCatch` sorts a caught throw into three cases: an `ApiError` crosses the wire verbatim (status, `message`, `name`, `retriable`); a Building Block error carrying the wire-safe brand forwards BOTH its BB `name` in `data.name` AND its BB-authored `message` (per D-003, the wire carries `name` alongside `message`), so `isBlocksError()` keeps matching on the client and the caller sees the real, actionable message ("Batch contains 150 payloads, exceeds the 100 limit"); and everything else — a driver/SDK exception, a bare `Error`, or a non-`Error` throw — collapses to a nameless generic `500` / `"Internal error"`. The full error (including `cause`) is still logged server-side in every case.

  The brand is a non-enumerable symbol stamped by core's new `brandBlocksError()` helper, and the serializer keys the name-and-message-forwarding decision on that brand rather than on `.name !== 'Error'`. Every Building Block that mints a named error now routes it through that one helper — core's `blocksError()`, each package's own local `blocksError()`, and the inline named-error sites across the runtime and mock layers — so a BB error keeps its `name` and message on the wire no matter which package or layer threw it. A raw driver exception whose class name happens to be non-generic (`PostgresError`, `DynamoDBServiceException`) is never branded, so neither its class name nor its raw message ever reaches the client.

  The load-bearing invariant, now that messages cross the wire: **a branded error's message must never embed raw driver/SDK text.** Two message-embedding sites are therefore given stable, BB-authored messages (`bb-kv-store` and `bb-distributed-table`'s item-too-large remaps, which previously copied DynamoDB's raw `err.message`), keeping the raw driver error only as `cause`.

  Re-tag paths are branded, with a stable message. The catch-all re-tag paths in `bb-data` (`wrapError` / `translatePgError`) and `bb-distributed-data` (`translateDsqlError`) — which classify a caught driver error as `QueryFailed` / `ConnectionFailed` — now build a fresh BRANDED error carrying the BB `name` and a stable BB message (e.g. "The database query failed"), keeping the raw driver error as `cause`. This preserves the client-side `isBlocksError(e, DatabaseErrors.QueryFailed | .ConnectionFailed)` retry contract the `bb-data` README teaches for auto-pause-resume, and — because the message is a stable BB string, not the driver's — a re-tagged error still never leaks driver internals over the wire. The 40001 / 23505 conflict paths already crossed as `ApiError` (409) with stable messages and are unchanged. Also branded in this pass: `bb-auth-oidc`'s `InvalidRelayError` (a class-field error not reached by the `.name =` sweep) and `bb-distributed-data`'s mock DDL-guard error (name `DsqlPermissionException`, the internal `DSQL_PERMISSION_ERROR_NAME`; now branded with a stable message, its name kept internal and mock-only, not a public `DistributedDatabaseErrors` constant).

  The two `bb-realtime` client-middleware `brandBlocksError` calls are commented as intentionally inert (a client-side subscription rejection matches on `err.name`, never routes through the server serializer). The realtime e2e's `ConnectionFailedException` assertions run against `channel.subscribe()` in-process on the client, not across the RPC serializer.

  ## Breaking change (why `@aws-blocks/core` is a minor)

  App code that throws a plain `Error('Todo not found')` from an API method now surfaces as a generic `500` / `"Internal error"` on the client instead of the raw message (a customer-defined `Error` also loses its `.name`). This is the intended safety net — an unbranded throw is treated as an unhandled internal error — but it changes client-visible behavior, so `@aws-blocks/core` ships as a minor (we are pre-1.0). To send a specific status, name, and message to the client, throw an `ApiError`:

  ```ts
  // before — message collapses to "Internal error" on the client
  throw new Error("Todo not found");

  // after — status, message, and name all reach the client
  throw new ApiError("Todo not found", 404, { name: "TodoNotFoundException" });
  ```

  Building Block errors (`isBlocksError` / `blocksError`) are unaffected — their name and message continue to cross the wire.

- 4794cb8: create-blocks-app now scaffolds a fresh project into a directory that contains only benign metadata files (VCS, editor, and OS entries) or an INSTRUCTIONS.md seed, instead of aborting. Any other pre-existing file (including a README.md or .gitignore) still blocks scaffolding, and the error now lists each conflicting entry — so no existing file is overwritten.
- ca3b54a: Document the single RPC endpoint in the scaffolded `AGENTS.md` and the `react`, `default`, and `bare` template READMEs.

  These files told agents not to curl the API but never gave the request shape, so agents that needed to verify a deployed app guessed per-namespace paths (`/aws-blocks/authApi`) and got 404s. They now state that every namespace shares `POST /aws-blocks/api` with the namespace in the JSON-RPC `method` field, show a curl example, and cover error handling and the session cookie. The guidance to prefer the typed client and `npm run test:e2e` is unchanged.

- 465a002: fix(telemetry): use ci-info for CI detection so Taskcluster (`TASK_ID` + `RUN_ID`), Netlify, Vercel, and 40+ other CI providers are identified; also keep the previously checked `CODEBUILD_BUILD_ID`, `JENKINS_URL`, `BITBUCKET_BUILD_NUMBER` and `TASKCLUSTER_ROOT_URL` variables, and honor `CI=false`

## 0.1.23

### Patch Changes

- f24961b: Add a build script to the backend template so freshly scaffolded backend apps support `npm run build`.
- 5eee114: Add npm keywords for discoverability via `npm search keywords:aws-blocks`

  Every published package now carries an npm `keywords` array: the shared `aws-blocks`
  discovery tag plus 2–5 functional keywords describing the package's domain and the
  AWS services it uses (e.g. `realtime`, `websocket`, `pubsub` for `bb-realtime`;
  `ci-cd`, `pipelines`, `deployment` for `pipeline`). Metadata only — no runtime,
  API, or behavior change.

- fef57e7: Add the AWS CDK CLI to generated template development dependencies.
- 6496713: Simplify VPC implementation: replace `registerVpcEndpoint` (instanceof-based) with two explicit methods (`registerVpcGatewayEndpoint` / `registerVpcInterfaceEndpoint`), simplify `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`, and strip persistent test VPC to bare minimum.
- d9b442e: Make starter template E2E setup wait for the Blocks server without depending on a sample API.

## 0.1.22

### Patch Changes

- 46b7c89: Generate the local `aws-blocks` package's client entry point on fresh checkouts, under the correct export conditions.

  The templates declare `./client.js` as the package's `browser`/`import` entry and gitignore it as generated, so a scaffold built on any machine other than the one that scaffolded it failed to resolve the package, and `cdk synth` failed with it (the Hosting block builds the frontend during synthesis).

  `@aws-blocks/blocks` gains a `blocks-generate-client` bin (mirroring `blocks-generate-spec` and `blocks-vendorize`) that spawns the core generator worker with `--conditions=aws-runtime`, so the emitted client imports `aws-middleware` rather than `mock-middleware` regardless of how the hook is invoked. `@aws-blocks/core` exports the existing `generate-client-worker` subpath so the bin can resolve it. The templates wire `"prebuild": "blocks-generate-client"` (including `backend`, where the hook is dormant until a `build` script exists) and gitignore `.hosting/`, the Vite output written during synthesis.

## 0.1.21

### Patch Changes

- 9d4ccea: Add `secret()` / `config()` support to hosting and pipeline for self-hosted deployments — externalized values that are never hardcoded in source, committed to git, or written into the CloudFormation template.

  **Two intent functions; the store is implied by which you call.**

  - **`secret('KEY')` → AWS Secrets Manager** — for sensitive values (API keys, tokens, credentials).
  - **`config('KEY')` → SSM Parameter Store** (free tier) — for non-sensitive externalized values (feature flags, a custom domain, a connection ARN).

  The developer never selects a store; it is derived from the function (`storeForKind`), so the CLI write, the IAM grant, the synth-time fetch, and the runtime read can never disagree.

  **Runtime read — two getters, one per store.** `getSecret('KEY')` reads Secrets Manager; `getConfig('KEY')` reads SSM. Each reads its own injected locator env var (`HOSTING_SECRET_PARAM_<KEY>` vs `HOSTING_CONFIG_PARAM_<KEY>`), so the store is unambiguous. Both read `process.env.KEY` first, so **local dev needs no AWS** (put the value in a `.env` file). Values are fetched + decrypted on first use, cached (per-kind `cacheTtlSeconds` for rotation without a cold start; otherwise cached for the process lifetime), and never enter the template. The getters live on the **CDK-free `@aws-blocks/hosting` entry** — the value API (`secret`/`config`/`getSecret`/`getConfig`) is the package's `.`, and its module graph pulls in no CDK, no `fast-glob`, and no `node:fs`, so importing it into an SSR/runtime bundle (including the edge runtime) is safe. Build-time tooling lives off `.` so it never enters a runtime bundle: the CDK construct + resolution engine on `@aws-blocks/hosting/constructs`, and the CLI + typegen engines on `@aws-blocks/hosting/scripts`. (`@aws-blocks/core` already exports a backend `getConfig`, so import the hosting getters from `@aws-blocks/hosting`.)

  **CDK wiring.** In `Hosting` `environment` (and `domain`) a `secret()`/`config()` marker injects only the store _locator_ and grants the compute role least-privilege read (`secretsmanager:GetSecretValue` / `ssm:GetParameter`, scoped to the exact ARN) + `kms:Decrypt` (conditioned on `kms:ViaService`). When a `stage` is set the grant covers BOTH the stage locator `<prefix>/<stage>/<key>` and the shared fallback `<prefix>/<key>` (the fallback read is what lets a stage fall back to a shared value), so treat the shared entry as readable by every stage sharing that prefix. A **synth-time** position — `domain.domainName` — accepts only `config()` (or a plain string), never `secret()`: the value is resolved via an SDK read and **inlined as a literal into the template** (a domain must be a literal before CloudFront/ACM), so a secret there would defeat its own purpose; a domain is public anyway. Synth resolution is async, so use `await Hosting.create(...)`. (Runtime `environment` markers still accept both `secret()` and `config()` — those inject only the locator and never inline.) Per-kind namespace/cache config is set via the separate `secretStore` / `configStore` props (`{ prefix, stage, cacheTtlSeconds }`), defaulting to the neutral `/hosting/secrets` and `/hosting/config` prefixes.

  **Namespacing (avoid cross-app collisions).** A **Blocks** app is scoped automatically: the `Hosting` / `Pipeline` blocks and the `npm run secret` / `config` CLIs default to `/blocks/<stackId>/secrets` and `/blocks/<stackId>/config`, where `stackId` is the app's stable id from the committed `.blocks/config.json`. Both the CLI and the CDK synth read that same file, so two Blocks apps in one account/region never collide, and the write and the read can never diverge (when the file is absent — e.g. a bare test — both sides fall back to the unscoped `/blocks/*` identically). `stackId` is stage-independent (prod and sandbox share it; use the opt-in `stage` segment for per-stage values). A **standalone** hosting/pipeline app (the framework-neutral leaf) has no `.blocks/config.json`, so its defaults (`/hosting/secrets`, `/hosting/config`) stay account-global — give each app its own `secretStore.prefix` / `configStore.prefix` (and matching CLI `--prefix`) when more than one deploys to an account. Use `--region` (or `AWS_REGION`) to write the value in the same region the app deploys to.

  **Bring-your-own (BYO).** `environment` (hosting) and `buildSecrets` (pipeline) also accept an existing CDK `ISecret` / `IParameter` handle alongside the managed markers: the construct grants read via the handle and injects its locator, so `getSecret`/`getConfig` resolve it identically — managed _provisions_, BYO _references_.

  **Pipeline.** `source.connectionArn` accepts a `config()` marker (resolved to a literal at synth; a connection ARN is a reference inlined into the template, so `secret()` is a type error there — same rule as `domain`). `buildSecrets` accepts `secret()` markers or BYO `ISecret` handles and wires them as CodeBuild `SECRETS_MANAGER` env vars fetched at build time (masked in logs, never inlined) — build-time credentials are secrets, so this surface is Secrets-Manager-only. Namespace config via `secretStore` / `configStore`.

  **CLI.** `secret set|list|remove` (Secrets Manager) and `config set|list|remove` (SSM), sharing one engine (`setValue`/`listValues`/`removeValue`/`runValueCli`). Blocks apps get `npm run secret` / `npm run config` (scoped per app to `/blocks/<stackId>/secrets` and `/blocks/<stackId>/config`); standalone/pipeline apps get the `hosting-secret` and `hosting-config` bins. A **secret** value is never read from argv/shell history — `secret set` takes it from a hidden prompt or `--value-stdin` (a positional value is a hard error); a non-sensitive **config** value may be passed positionally. `list` prints names only, never values. All commands accept `--prefix`, `--stage`, and `--region` (write to the same region the app deploys to).

  **Type-safe reads (zero code) — `getSecret` / `getConfig` autocomplete + typo errors.** The runtime getters are typed against two augmentable registries (`HostingSecretRegistry` / `HostingConfigRegistry`): empty by default they accept any `string` (unchanged, non-breaking), and once populated they narrow to your declared keys — editor autocomplete, and a typo (or reading a `config` key via `getSecret`, i.e. the wrong store) becomes a compile error. You populate them with **no code change** via the new `hosting-typegen` CLI (`npm run typegen`, `--watch` to regenerate on save, `--check` for CI): it statically scans your `secret('...')` / `config('...')` calls (TypeScript compiler API — no app execution, no AWS credentials) and generates a `.d.ts` (`.blocks/hosting-values.d.ts`) that augments the `@aws-blocks/hosting` entry (where the getters live), narrowing them to your declared keys. The generated file is derived from your `secret()`/`config()` calls, and `--check` fails CI when it's stale. Add `.blocks/**/*.d.ts` to your tsconfig `include`. In a Blocks app this is automatic: the dev server (`npm run dev`) auto-detects `secret()`/`config()` usage and runs the generate-and-watch step itself (a no-op when the app declares no secrets, and non-fatal), so keys update as you type with no second command; standalone hosting apps use `hosting-typegen --watch`.

  **Typed, parsed values via a schema.** `secret('KEY', { schema })` / `config('KEY', { schema })` accept any Standard Schema (Zod, Valibot, ArkType — typed as `StandardSchemaV1`, library-neutral). `typegen` builds a TypeScript `Program`, infers the schema's output type, and inlines it into the generated `.d.ts`, so **`getSecret`/`getConfig` return the inferred type** (e.g. `const { beta } = await getConfig('FEATURE_FLAGS')`) instead of `string` — no `JSON.parse(...)` and no `any`. At runtime the value is JSON-parsed (a per-key flag is injected at synth); the schema itself isn't shipped to the runtime, so this is parse-to-type, not a deep re-validation across the bundle boundary.

  **Templates.** `@aws-blocks/create-blocks-app` templates scaffold a `secret` script (`npm run secret`) wired to the Blocks CLI, and a `typegen` script (`npm run typegen` → `runTypegenCli` from `@aws-blocks/blocks/scripts`) with `.blocks/**/*.d.ts` added to the tsconfig `include`, so a newly-created app can manage secrets and get type-safe `getSecret`/`getConfig` out of the box.

- 0ac3879: `sandbox` / `deploy`: fail fast with an actionable message when AWS credentials are missing or expired.

  Both commands previously spent ~10 seconds synthesizing the CDK app before the first AWS call, so an unconfigured or expired credential surfaced only afterwards — as an opaque CDK/CloudFormation error that didn't name the real cause. `startSandbox` and `deploy` now run a bounded STS `GetCallerIdentity` check up front and, on a real credential error (missing/expired/invalid), exit immediately with guidance (`aws configure` / `aws sso login`, `AWS_PROFILE`, or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) instead of wasting the synth.

  The check is deliberately conservative: it only blocks on a genuine credential error (surfacing the SDK error _name_, never the raw message, which can embed an ARN/account id); a network or service error warns and lets the deploy proceed; and it skips (with a warning) when no region is set in `AWS_REGION` / `AWS_DEFAULT_REGION`, rather than guessing a region in the wrong partition (GovCloud/China). The scaffolded `sandbox` template entrypoint now `.catch`es and exits cleanly, matching `deploy`, so the guidance prints without an unhandled-rejection stack trace.

## 0.1.20

### Patch Changes

- 7b4c62d: Add infrastructure `defaults` chosen once at the app entry point, replacing the per-block `sandboxMode` logic and the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin dance for removal-policy and deletion-protection.

  `@aws-blocks/core/cdk` now exports `BlocksDefaults` and the `BlocksPresets.sandbox` / `BlocksPresets.production` starting points. `BlocksStack.create` / `BlocksBackend.create` take a required `defaults` prop; start from a preset and override individual fields with a spread. `defaults` is anchored on the owning `BlocksStack`/`BlocksBackend` (resolved by walking up the construct tree, like `handler`/`executionRole`), so multiple backends in one stack each keep their own posture. Building Blocks read the resolved values via `scope.defaults`, and a per-block option always wins (`option ?? scope.defaults.field`).

  Adopted across the stateful Building Blocks: `bb-kv-store`, `bb-data`, `bb-distributed-data`, `bb-distributed-table`, and `bb-knowledge-base` now take their removal policy and deletion protection from `defaults` instead of reading the `sandboxMode` context themselves. (`bb-distributed-table` reads `defaults` directly for now; a richer per-block `protection` override lands with #282.)

  The `create-blocks-app` scaffolding templates are updated to pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production` (replacing the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin), so newly-generated apps satisfy the required prop.

  **Breaking:** `BlocksStack.create` / `BlocksBackend.create` now require a `defaults` field — pass `BlocksPresets.sandbox` or `BlocksPresets.production` (typically `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`). The previously-shipped experimental `hardening` prop and its `resolve*` helpers are removed; log-retention, API throttling, access-logging and point-in-time-recovery move into `defaults` in follow-up, per-feature changes.

- 6918752: Use the lazy Lambda handler factory in the React template.
- 8966cfb: fix(telemetry): detect Render and Taskcluster as CI

  Telemetry CI detection (`isCI()`) checked a fixed list of CI env vars but
  omitted Render and Taskcluster. Render sets `RENDER=true` on every build and
  service; Taskcluster tasks always set the namespaced `TASKCLUSTER_ROOT_URL`.
  Runs on those platforms were therefore reported as real user sessions instead
  of `ci:true`, inflating user metrics. `RENDER` and `TASKCLUSTER_ROOT_URL` are
  now included in both `isCI()` implementations (`@aws-blocks/core` and
  `@aws-blocks/create-blocks-app`). The umbrella `@aws-blocks/blocks` gets a patch
  bump because it re-exports `@aws-blocks/core`.

## 0.1.19

### Patch Changes

- 1e37c67: docs: per-block docs folders + committed BB catalog with CI sync check; CLAUDE/agents docs resolved via require.resolve

  `@aws-blocks/blocks` now ships one docs folder per Building Block under `docs/<block>/`
  (`README.md` / `API.md` / `DESIGN.md`), plus a committed, marker-delimited Building Block
  catalog in the package README that a `sync-docs --check` CI gate keeps in sync. The README's
  catalog section and the scaffolded `AGENTS.md` (`@aws-blocks/create-blocks-app`) now direct
  tools and agents to locate docs programmatically via
  `require.resolve('@aws-blocks/blocks/docs/<block>/README.md')` (and
  `require.resolve('@aws-blocks/blocks/docs/README.md')` for the catalog) rather than assuming a
  `node_modules/` path or following the human-facing relative links. Also adds a Security
  Considerations section to the package README.

## 0.1.18

### Patch Changes

- 75f5446: Add optional `fallback` parameter to `AuthenticatedContent` for rendering alternative content when the user is not authenticated.
- 8264dd0: Add the missing `vendorize` script to the `auth-cognito` template. Every other deployable template shipped `"vendorize": "blocks-vendorize"`, but auth-cognito omitted it, so `npm run vendorize` (used to inline a Building Block's source for customization) didn't work in scaffolded auth-cognito apps. Also adds a regression test asserting every deployable template carries the standard `vendorize` script.

## 0.1.17

### Patch Changes

- 50dbd0e: Include the local dev-server script and use public AWS Blocks imports when adding AWS Blocks to an Amplify Gen 2 project.

## 0.1.16

### Patch Changes

- fc33428: fix(telemetry): inherit worker stderr in debug mode; enable telemetry in CI for create-blocks-app

  - When `NODE_DEBUG=blocks-telemetry` is set, the telemetry worker subprocess
    inherits the parent's stderr so delivery confirmation is observable. Silent
    by default.
  - Remove CI telemetry suppression from create-blocks-app to match core behavior.
    Telemetry is now enabled in CI (same as all other CLI commands).
  - Make `console` cross-platform and headless-safe: pick the OS browser opener
    (`open`/`xdg-open`/`start`), resolve the region from the environment, and treat
    a missing opener (CI / remote shells) as best-effort success instead of failing.
  - Add an isolated E2E telemetry test suite (`test-apps/telemetry`) that verifies
    payload structure, delivery to the real endpoint, disable mechanisms, and
    per-command success/failure events.

## 0.1.15

### Patch Changes

- f6a7fc7: Fix two security defects in the `demo` template:

  - **Set-Cookie header (CRLF) injection**: the public `setCookie` / `deleteCookie` API methods wrote a user-controlled cookie name/value directly into the `Set-Cookie` response header. Cookie name/value components containing CR (`\r`) or LF (`\n`) are now rejected, preventing HTTP response-header injection / response splitting.
  - **Incomplete HTML escaping (XSS)**: the frontend `escapeHtml` helper escaped `&`, `<`, `>`, and `"` but not the single quote (`'`), leaving an XSS gap when interpolating user-controlled values into single-quoted JS/HTML attribute contexts (e.g. `onchange="toggleTodo('...')"`). Single quotes are now escaped to `&#39;`.

- 919d38c: Env-gate the `getLastCode` OTP helper in the `auth-cognito` template so a verification code can never be captured, logged, or returned from a deployed environment.

  The passwordless-OTP demo exposes `api.getLastCode()` (tagged `@blocksSkipCodegen`) so the local UI can read the emailed code without a real mailbox. Its behavior was documented as "no-op in Sandbox/Production" but nothing enforced it — the `codeDelivery` hook captured the code and the method returned it unconditionally, so a live OTP could leak in a deployed environment. Both the capture and the read are now gated inline on `!process.env.BLOCKS_STACK_NAME` — the marker BlocksBackend injects into every deployed Blocks Lambda and leaves unset in local/mock dev, matching how the framework's generated DB connection resolver distinguishes deployed vs. local. The code is returned in local/mock dev and `null` in a deployed environment.

## 0.1.14

### Patch Changes

- a1de3b8: Fix + polish for `create-blocks-app`:

  - Reject `--template amplify` on a fresh directory up front with a
    helpful message pointing at `--template default` (for a fresh app)
    or the no-arg command (to integrate Blocks into an existing Amplify
    Gen 2 project). The `amplify` template is an overlay auto-selected
    when the CLI detects `amplify/backend.ts`, not a scaffoldable
    starter. Previously the fresh-scaffold path with `--template amplify`
    crashed mid-copy on missing template files.
  - Correct two template descriptions that misstated the frontend:
    `auth-cognito` and `demo` were labeled "Vite + lit-html" but both
    ship a Vite + vanilla-DOM frontend. Descriptions now read
    "Vite + vanilla-DOM frontend with Cognito passwordless email-OTP
    auth end-to-end" and "Fuller example — AuthBasic + KVStore +
    DynamoDB priority-sorted todo (Vite, vanilla-DOM)" respectively.

- 3c365e3: Sanitize user-controlled values in demo template innerHTML assignments
- a1de3b8: Improve `--help` output for `create-blocks-app`:

  - Template discovery is now filesystem-driven — drop a folder under `templates/` with a `package.json` and it auto-registers.
  - `--help` now lists every template with a one-line description, sourced from each template's `blocksTemplateDescription` field.
  - Added `--yes --template nextjs` to the Examples section.

## 0.1.13

### Patch Changes

- e839301: fix: stack-scope the external-DB connection-string SSM parameter to prevent multi-app collision

  The external-database connection string was stored in an SSM parameter named only
  by stage (`/blocks/{stage}/db-connection-string`), so two Blocks apps deployed to
  the same AWS account + region + stage computed the same name and silently
  overwrote each other's credentials.

  The parameter name is now stack-scoped (`/<stackName>-db-url`), derived from a
  single new `getStackName({ sandbox, projectRoot })` helper that is also the one
  place the CDK templates compute the stack name (replacing logic duplicated across
  templates). The same `dbConnectionParameterName(stackName)` — fed the stack name
  from `getStackName({ sandbox, projectRoot })` — is used
  by the pre-deploy writer (`ensureSecrets`) and by the `db pull` generated wiring at
  synth, so the written name and the read name are derived once, from committed
  config (`.blocks/config.json`) — never from the connection string — and cannot
  diverge. The name is computable before synth (enabled by the committed stackId from
  PR #51), so no post-deploy write-back or staging-copy machinery is needed.

  The previous stage-only parameter is orphaned and self-heals on the next deploy.

## 0.1.12

### Patch Changes

- ec1fc6c: Fix multi-tenant data leak in demo template: `listTodos()` no longer falls back to `scan()` when no `sortBy` is provided. All paths now use `query()` with a `userId` filter, ensuring users only see their own todos.

## 0.1.11

### Patch Changes

- a23b1fb: fix(create-blocks-app): serve the react template from a single-origin front door

  The `react` template was the only SPA template without a single-origin dev
  front door: its `server.ts` ran the backend on `:3001` and `package.json`
  used `concurrently` to start Vite on a separate `:3000` origin, with no
  `/aws-blocks` proxy in `vite.config.ts`. As a result `/aws-blocks/*` — including
  the server-initiated OIDC redirect routes (`/aws-blocks/auth/signin/*`) — was
  not reachable from the SPA origin, breaking any browser-navigation auth flow
  (e.g. OIDC) locally.

  The template now matches every other SPA template: `startDevServer` runs Vite
  via `frontendCommand` and exposes a unified front door on `:3000` (backend +
  SPA same origin), and `npm run dev` runs the single dev server. This unblocks
  OIDC / browser-navigation auth in the react template. Surfaced by the agent-bench.

## 0.1.10

### Patch Changes

- f42c604: fix: generate unique stackId in .blocks/config.json, export getStackId/getSandboxId from @aws-blocks/blocks/scripts

  Stack names are now derived from a `stackId` in `.blocks/config.json`, generated at scaffold time as `<name>.slice(0,16)-<random6>`. Templates import `getStackId()` and `getSandboxId()` from `@aws-blocks/blocks/scripts` — no more inline filesystem logic in `index.cdk.ts`.

  Production: `<stackId>-prod`
  Sandbox: `<stackId>-<username(8)>-<random(6)>` (per-machine, gitignored)

## 0.1.9

### Patch Changes

- 95efe42: Honor `--skip-install` when creating a fresh project so scaffolding can complete without running `npm install`.

## 0.1.8

### Patch Changes

- 6c7bb69: fix(create-blocks-app): respect `--template` when adding Blocks to an existing project

  Adding Blocks to an existing project always copied the `aws-blocks/` workspace from
  the `default` (Vite) template, ignoring `--template`. Running
  `npm create @aws-blocks/blocks-app . -- --template nextjs` in a Next.js project
  therefore generated a `scripts/server.ts` whose `frontendCommand` was `npx vite ...`
  instead of `npx next dev ...`, so `npm run dev:server` tried to launch Vite in a
  project without it.

  The requested template now drives the copied `aws-blocks/` workspace, `cdk.json`, and
  devDeps.

## 0.1.7

### Patch Changes

- a98fa95: fix(create-blocks-app): bump `aws-cdk-lib` to `^2.257.0` in the react template

  The react template pinned `aws-cdk-lib` to `2.245.0`, while every block (e.g. `@aws-blocks/bb-realtime`) declares a peer dependency of `aws-cdk-lib@^2.257.0`. The unmet peer caused npm to nest `@aws-blocks/bb-realtime` under `@aws-blocks/blocks/node_modules` instead of hoisting it to the top level. Because the generated `aws-blocks/client.js` imports `@aws-blocks/bb-realtime/mock-middleware` directly from the workspace, Vite failed to resolve it (`Failed to resolve import "@aws-blocks/bb-realtime/mock-middleware"`) and `npm run dev` broke. Aligning the version with the other templates (`^2.257.0`) satisfies the peer dependency so the block hoists correctly.

## 0.1.6

### Patch Changes

- 3d670a9: Report a clear error when `--template` is missing its template name instead of treating the flag as an unknown option or consuming another option as the template value.

## 0.1.5

### Patch Changes

- b8a03a4: Validate unknown `--template` values before reading template metadata so the CLI reports the intended `Unknown template` message instead of a file-system error.

## 0.1.4

### Patch Changes

- ba577bb: List the available starter templates in `create-blocks-app --help` so users can discover valid `--template` values directly from the CLI.

## 0.1.3

### Patch Changes

- bbf0c4a: Add the missing `/.blocks-sandbox/config.json` route handler to the Next.js template so the browser client can discover the API URL.

## 0.1.2

### Patch Changes

- 7b80811: Add in-repo Building Block docs discoverability.

  The `@aws-blocks/blocks` package now ships a `docs/` folder containing every Building Block README (one per block) plus a generated `index.md` with a decision tree and catalog. This gives humans and AI agents a single, stable path to all block documentation — `node_modules/@aws-blocks/blocks/docs/` — instead of scattering them across 19+ individual package paths.

  - `@aws-blocks/blocks`: adds `docs/` to the published package (assembled at build time via `scripts/sync-block-docs.mjs`). README expanded to be a comprehensive guide (architecture, workflow, best practices, common mistakes).
  - `@aws-blocks/create-blocks-app`: AGENTS.md templates updated to point to the blocks README and docs folder as the canonical entry points.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements

## 0.1.0

Initial version
