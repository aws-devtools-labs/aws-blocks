# @aws-cdk-blocks/create-blocks-app

## 1.0.0

The first stable release. The changes since 1.0.0-rc.2 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/create-blocks-app` 0.x

- The package is now `@aws-cdk-blocks/create-blocks-app`. Run `npx @aws-cdk-blocks/create-blocks-app my-app` in place of `npx @aws-blocks/create-blocks-app my-app`.
- c67048e: `Database` is the only SQL block. `@aws-blocks/bb-data` and `@aws-blocks/bb-distributed-data` are removed. See "Upgrade from `@aws-blocks/bb-data`" in the `bb-database` README.
- c42ba42: The hidden `.blocks/` folder is now `.cdk-blocks/`, and local data moves from `.bb-data/` to `.cdk-blocks/local/data/`.
- 703238f: The scaffolded backend folder is `cdk-blocks/` instead of `aws-blocks/`.
- 45a05d1: The per-deploy state directory is now `.cdk-blocks-sandbox/`.
- 1de6ea4: The reserved URL prefix is now `/cdk-blocks/` (`/cdk-blocks/api`, `/cdk-blocks/auth/*` and others). `/aws-blocks/` still works as an alias.
- 8894669: Telemetry follows your CDK CLI telemetry setting. The old opt-out (`AWS_BLOCKS_DISABLE_TELEMETRY`) is removed. To opt out, run `cdk cli-telemetry --disable` or set `CDK_DISABLE_CLI_TELEMETRY=1`.
- 184df0b: Typecheck the backend with Node types and the browser code without them.
- ba80bbd: Generated apps keep their existing npm lifecycle script names without generating `cdk-blocks/scripts/*.ts` wrappers.
- 5f55dac: New apps create a user pool where users sign in with their email address, matched ignoring case.
- 5f55dac: New apps now use the unified `Auth` block.
- f32185c: Adds the dashboard command, which starts the Admin UI against your app on a free loopback port.
- 6d3077e: Scaffold data models on `KVStore` with a `schema` and a `key`.
- e1e4844: Tasks run as package scripts (`npm run dev`, `npm run deploy` and the others) instead of the `cdk-blocks` executable. Run `npm run migrate` to update an older app.
- 8894669: The `telemetry` app task is gone.

### Since 1.0.0-rc.2

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The README has tables of the options, including `--skip-install` and `-y`, and of the scripts of each mode. The scaffolded `AGENTS.md` asks agents to run the e2e test before deploying and to add API checks to the e2e suite.

## 1.0.0-rc.1

### Minor Changes

- c42ba42: **Breaking: the hidden `.blocks/` folder is now `.cdk-blocks/`, and local data moves from `.bb-data/` to `.cdk-blocks/local/data/`.**

  To upgrade:

  1. Run `mkdir -p .cdk-blocks && git mv .blocks/config.json .cdk-blocks/config.json`, then delete the empty `.blocks/` folder.
  2. In your tsconfig `include`, change `.blocks/**/*.d.ts` to `.cdk-blocks/**/*.d.ts`.
  3. Run `npm run typegen` and commit `.cdk-blocks/hosting-values.d.ts`.

  Local data is copied to the new location the first time each block opens its store. Pull request #1607 has the full notes.

### Patch Changes

- e9c1bd4: The `nextjs` template's `tsconfig.json` includes the `ESNext` library, so a backend that uses `Array.fromAsync(...)` type-checks in `next build`. Before, `next build` failed with `TS2550: Property 'fromAsync' does not exist on type 'ArrayConstructor'`.
- b47e4c7: The Dashboard block's route opens during local development, where it shows configured metrics and local observability output and launches the Admin UI. New Admin UI sessions start on local data and defer AWS reads until a cloud stage is selected.
- c9d73a8: A new app installs one copy of `@aws-cdk-blocks/core`, because the templates declare `@types/node` `^22.12.0` instead of `^20.19.43`. To fix an existing app, make the same change in its `package.json` and run `npm install`.
- e529b00: Client code can import the block error constants, `isBlocksError`, and `ApiError` from `aws-cdk-blocks`, which also exports `RealtimeErrors`. The Building Block classes and `sql` are still server-only, so browser code uses `import type` for their types.

## 1.0.0-rc.0

### Major Changes

- e50b9e9: **Breaking: every published package moves from the `@aws-blocks` scope to `@aws-cdk-blocks`, and `@aws-blocks/blocks` becomes the unscoped `aws-cdk-blocks`.**

  To upgrade:

  1. In `package.json`, replace `@aws-blocks/blocks` with `aws-cdk-blocks` and every other `@aws-blocks/` name with `@aws-cdk-blocks/`, for example `@aws-cdk-blocks/core`.
  2. Make the same replacement in the specifier of every import.
  3. Change each `Annotations.of(stack).acknowledgeWarning('@aws-blocks/…')` call to the `@aws-cdk-blocks/` prefix, or `cdk synth --strict` fails on the warning.
  4. Keep the CDK context key `@aws-blocks/bb-data:encryptStorageByDefault` in `cdk.json` as it is, because renaming it makes CloudFormation replace the cluster.
  5. If you publish a block, move its dependency from `@aws-blocks/core` to `@aws-cdk-blocks/core`.

  No export or option moved, and the old `@aws-blocks/*` packages stop receiving releases.

### Minor Changes

- c67048e: **Breaking: `Database` from `@aws-cdk-blocks/bb-database` is the only SQL Building Block, and `@aws-blocks/bb-data`, `@aws-blocks/bb-distributed-data`, and `@aws-blocks/data-common` are removed.**

  To upgrade:

  1. Import `Database`, `DatabaseCluster`, `DatabaseErrors`, and `sql` from `aws-cdk-blocks`.
  2. To keep an old `@aws-blocks/bb-data` cluster, make that line a `LegacyDatabaseCluster` and put a `Database` with a new id on it.
  3. Replace `DistributedDatabase` with a `Database` of the same id, which keeps its cluster.
  4. Replace `Database.fromExisting()` with `DatabaseCluster.fromExisting()`, passed as `cluster`.
  5. Replace `withRLS()` with `asUser()` or `asRole()`, and use `DatabaseDialect` from `@aws-cdk-blocks/bb-database/kysely` for Kysely.
  6. Store the connection string of an existing database with `npm run db -- connect --stage <stage>`, not a `*_DB_URL` or `*_CONNECTION_STRING` environment variable.

  Data is not moved, and `crud()`, `ensureSecrets`, and the `npm run db` commands `pull` and `generate-types` are removed.

- 703238f: **Breaking: the scaffolded backend folder is `cdk-blocks/`, not `aws-blocks/`.**

  To upgrade:

  1. Rename the `aws-blocks/` directory to `cdk-blocks/`.
  2. Change the `"workspaces"` entry that names it.
  3. Change the `"name"` in its `cdk-blocks/package.json` to `cdk-blocks`.
  4. Change every `from 'aws-blocks'` import to import `cdk-blocks`.
  5. Rename an `aws-blocks/migrations` directory or set an explicit migrations path, because `DEFAULT_MIGRATIONS_ROOT` is now `./cdk-blocks/migrations`.

  The reserved URL namespace, such as `/aws-blocks/api` and `/aws-blocks/auth/*`, keeps its path, so deployed routes and OAuth callback URLs keep working.

- 45a05d1: **Breaking: the per-deploy state directory `.blocks-sandbox/` is renamed to `.cdk-blocks-sandbox/`.**

  To upgrade:

  1. Update your own references to the directory, such as a `.gitignore` entry, a `cdk.json` `watch.exclude` entry, a CI step, or a script passing `outputsFile`.
  2. In a scaffolded Next.js app, keep `src/app/.blocks-sandbox/config.json/route.ts` where it is and change the path it reads from `.blocks-sandbox/config.json` to `.cdk-blocks-sandbox/config.json`.
  3. Delete `.blocks-sandbox/` once you no longer need it.

  Your state files are copied to the new directory on the first `npm run dev`, `npm run deploy`, `npm run sandbox`, or `npm run destroy` after upgrading.

- 1de6ea4: **Breaking: the framework's reserved URL prefix is now `/cdk-blocks/`, and the old `/aws-blocks/` prefix stays served as an alias.**

  To upgrade:

  1. If an external identity provider only allows the `/aws-blocks/auth/callback` redirect URI, register `/cdk-blocks/auth/callback` or set `redirects.callbackPath: '/aws-blocks/auth/callback'`.
  2. If a custom front door or an explicit `apiPaths` routes `/aws-blocks/*` by hand, also route `/cdk-blocks/*` or use `cf.apiBehaviors(origins.api)`.
  3. If the app is at the CloudFront cache-behavior quota, 25 by default, free a behavior or raise the quota, because the built-in front door adds one for `/aws-blocks/*`.

  A sandbox `stubIdp()` issuer moves to `/cdk-blocks/auth/idp/<id>`, so its users get a new `userId`.

- 8894669: **Breaking: telemetry follows your CDK CLI telemetry setting, and the AWS Blocks opt-out is removed.** `AWS_BLOCKS_DISABLE_TELEMETRY`, the `cdk-blocks telemetry` command, the `blocks-telemetry` binary, and the `telemetry.enabled` key in `.blocks/config.json` are gone, so if you opted out that way you are opted back in. Opt out with `CDK_DISABLE_CLI_TELEMETRY` set to `1` or `true`, with `cdk cli-telemetry --disable`, or with `cli-telemetry: false` in the `context` of `cdk.json` or `~/.cdk.json`.
- 184df0b: The Vite templates check the browser and the backend as separate TypeScript projects, so a Node global in `src/` is a type error. To move an older app to this layout, see "Keep Node types out of the frontend" in `docs/guides/upgrading-older-apps.md`.
- ba80bbd: Generated apps keep their npm lifecycle script names without `cdk-blocks/scripts/*.ts` wrappers. Backend-only templates default to port 3001, and production destroy requires confirmation in a terminal or `npm run destroy -- --yes` in automation.
- 5f55dac: New apps create a user pool where users sign in with their email address, matched ignoring case. Every template that constructs `Auth` passes `users: { signInWith: ['email'], caseSensitive: false }`, and neither setting can change after the pool exists.
- 5f55dac: Every template that signs users in uses `Auth` instead of `AuthBasic` or `AuthCognito`, and sign-up confirms the email address with a 6-digit code. The `auth-cognito` template is now `auth`, and the `amplify` overlay's `requireGroup()` is now `requireRole()`.
- f32185c: Adds the `blocks dashboard` command, which starts the Blocks Admin UI for the app on a free loopback port and opens it with a session token. `blocks dashboard doctor` prints a diagnostic report instead, and `@aws-cdk-blocks/admin-ui` is offered for install when the app does not have it.
- 6d3077e: The default, react, api-only, auth-cognito, demo, and bare templates use `KVStore` with a declared key in place of `DistributedTable`. Calls are key first, as in `todos.put({ userId, todoId }, todo)`, and `query` yields `{ key, value }` entries.

- e1e4844: **Breaking: the `cdk-blocks` executable is removed, and AWS Blocks tasks run through your app's package manager.**

  To upgrade:

  1. Upgrade `aws-cdk-blocks`.
  2. From the app directory, run `node --input-type=module -e "import 'aws-cdk-blocks/run'" -- migrate --dry-run` and review the plan.
  3. Run the same command without `--dry-run` from a clean Git working tree.
  4. Change by hand the custom wrappers that the migration reports.

  Structured tasks such as `npm run docs KVStore`, `npm run docs:api KVStore`, and `npm run docs:search "partition key"` print text in a terminal and JSON on a pipe or redirect.

- 8894669: **Breaking: the `telemetry` app task is gone, so `npm run telemetry` fails in a new or migrated app.** Telemetry follows your CDK CLI telemetry setting. Opt out with `CDK_DISABLE_CLI_TELEMETRY` set to `1` or `true`, with `cdk cli-telemetry --disable`, or with `cli-telemetry: false` in the `context` of `cdk.json` or `~/.cdk.json`.

### Patch Changes

- d18846c: Adds an `agent` template. `npx @aws-cdk-blocks/create-blocks-app my-app --template agent` scaffolds an AI Agent with a tool and `Auth`-gated chat, which runs locally on the built-in `canned` provider with no AWS account and no LLM.
- 4ff7fd3: The `AGENTS.md` that `create-blocks-app` adds to every new app covers namespaces, errors, client-side imports, and missing items. Its Quick Reference lists which imports come from `aws-cdk-blocks` and which from `aws-cdk-blocks/client`.
- cef2f8c: `AGENTS.md` refers to the project as AWS CDK Blocks.
- 1ff5bcc: The generated `AGENTS.md` tells agents to read a block's `README.md` first. They open `API.md` only for an exact signature or type, and `DESIGN.md` only when they are stuck or need implementation details.
- d46dfaf: create-blocks-app's Amplify overlay writes `"generateClient": false` in `package.json#blocks.dev`, so `npm run dev` keeps the overlay's own `cdk-blocks/client.js`. `npm run migrate` adds the same setting to an existing Amplify overlay.
- dc5dbdb: The `api-only` template ships a public `GET /healthz` `RawRoute` that answers load balancers and uptime monitors with a plain, uncached JSON response.
- 2eb62fa: The `hasAuthError` example in the `@aws-cdk-blocks/core` README and JSDoc submits the action with `submitAuthAction` from `aws-cdk-blocks/ui`. A direct `authApi.setAuthState()` call signs the user in but never notifies `onAuthChange` or `AuthenticatedContent`.
- 5f55dac: The `Authenticator` and `AccountMenuBar` show a signed-in user's email address instead of a generated id. `AuthState.user` has an optional `displayName` for display only, so keep keying data on `userId` or `userSub`.
- a139031: Adds an `auth-oidc` template, which signs in through an OpenID Connect provider with `Auth`'s `store: 'builtin'` and creates no Cognito user pool. Locally and on sandboxes it signs in through `stubIdp()`, and production uses a `type: 'oidc'` entry you point at your own provider.
- dabb3f2: The `auth-oidc` template ships a favicon, and its cdk watch ignores the generated `cdk-blocks/client.js`. Its e2e test runs against a deployed app when you set `TEST_URL`, and against the dev server otherwise.
- 5f55dac: `Auth` takes a block-level `store` and one `providers` map, keyed by provider id and tagged with its `type`. The default `store: 'cognito'` keeps users in a Cognito user pool, and `store: 'builtin'` has no user pool, so your backend verifies each provider itself.
- 5f55dac: Adds `auth.protect`, which returns an `ApiNamespace` that is deny by default. It checks the session before any of its `methods` runs, and a signed-out call to a name that isn't a `public` method gets 401 `NotAuthenticatedException`.
- d46dfaf: The auth template's e2e tests call the dev server, or the deployed app that `TEST_URL` names, in which case they start no dev server. Without `TEST_URL`, `npm run test:e2e` after a deploy no longer signs up users in the deployed stack.
- a0bc7ec: The `auth` template turns on optional MFA with an authenticator app. A user who sets one up is asked for its code at sign-in, and everyone else signs in with their password as before.
- 5f55dac: In the `auth` template, a failed toggle, priority change, title edit, or delete reloads the list and reports the failure in the todo status line. A failed "Show last code" lookup shows an error instead of an unhandled rejection.
- 684e22d: Without a `frontendCommand`, `npm run dev` and `npm run sandbox` detect `nuxt` and `astro` in the app's dependencies and start their dev servers. If your app starts `nuxt dev` or `astro dev` itself, remove that process or set `"blocks": { "dev": { "frontend": false } }`.
- 792e269: Migration moves recognized generated script wrappers to package tasks, carries generated dev settings into `package.json#blocks.dev`, and keeps customized wrappers. It requires a clean tracked working tree unless forced, and `--dry-run` previews the plan.
- 041af90: Scaffolded apps pin every `@aws-cdk-blocks/*` dependency to a caret range such as `"^0.9.0"` instead of `"*"`. To pin an app scaffolded earlier, replace each `"*"` in `package.json` and `cdk-blocks/package.json` with a caret range for the version you have installed, then run `npm install`.
- 02c1589: The `api-only` and `demo` templates call `auth.requireAuth(context)` in `createUploadUrl`, `createDownloadUrl`, `openAccount`, `balanceOf`, `transfer`, and `searchDocs`. Adding Blocks to an existing project appends `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, and `.aws/` to its `.gitignore`.
- a34c850: `npm run docs` lists the blocks and guides shipped with the installed version of `aws-cdk-blocks`. Run `npm run docs KVStore` for a block README, `npm run docs:api KVStore` for API details, or `npm run docs:search KVStore` to search the installed docs.
- 5938d8b: CLI output names the project AWS CDK Blocks, including `create-blocks-app` progress and help text, the `blocks` CLI, and the first-run telemetry notice. The `.gitignore` section that `create-blocks-app` adds to an existing project is headed `# AWS CDK Blocks`.

- d46dfaf: **Breaking: a deploy no longer writes its AWS `apiUrl` to `.cdk-blocks-sandbox/config.json`, which only a dev server writes.**

  To upgrade:

  1. In scripts that read a deployed URL from `config.json`, read `config.sandbox.json` or `config.production.json`, or run `npm run -s sandbox:deploy -- --query apiUrl`.
  2. Run `npm run dev`, `npm run deploy`, `npm run sandbox:deploy`, or a destroy once, or set `BLOCKS_API_URL`, because the Node.js client refuses a `config.json` that still holds a deployed URL.

  The template e2e tests call the dev server unless you set `TEST_URL` to the URL a deployed app's API is under.

- d46dfaf: `npm run deploy` works while `npm run sandbox` watches the same app, and a sandbox deploy or destroy refuses to start during that watch. Existing apps can add `"cdk-blocks/client.js"` to `watch.exclude` in their `cdk.json`.
- cd533c0: A stack name that starts with `aws` in any letter case is an error at synth, for `BlocksStack` and for a `BlocksBackend` inside such a stack. Use a name that does not start with `aws`, and in a scaffolded app change `stackId` in `.blocks/config.json`.
- 5f55dac: The `auth` template's `api` namespace is defined with `auth.protect`. `signOutEverywhere` needs a session, so an anonymous call answers `401 NotAuthenticatedException` instead of returning `{ success: true }`.
- 5f55dac: The e2e tests of new apps use the new `getLastAuthCode` and `createTestClient` helpers from `aws-cdk-blocks/utils`.
- 5f55dac: The `auth` template's role-gated section now shows the `npx @aws-cdk-blocks/bb-auth users add-to-group` command.
- ba80bbd: `create-blocks-app` exits 1 when a step such as `npm install` fails, instead of printing the error and exiting 0. Scaffolding into an npm workspaces monorepo stops unless the monorepo root lists the app's `cdk-blocks/` folder, and prints the `"workspaces"` entry to add.
- cd533c0: `create-blocks-app` no longer writes a `stackId` that starts with `aws` to `.blocks/config.json`. Such a name gets the prefix `app-`, so `aws-demo` gives `app-aws-demo-9f3a2b`, and existing apps are not changed.
- 5f55dac: The generated `AGENTS.md` of scaffolded apps no longer describes the removed `AuthBasic` block, and the templates no longer use `any`.
- 05a88e1: When AWS denies the credential check before `npm run deploy` or `npm run sandbox`, the warning says so and says whether an AWS Organizations policy denied the request. A credential failure message names the profile and the deployment Region.
- 9009efa: Adds a `cron` template. `npx @aws-cdk-blocks/create-blocks-app my-app --template cron` scaffolds a backend-only app with a `CronJob` that runs every minute and records each run in a `KVStore`.
- a63c3a5: In the demo template, the error from a failed toggle, priority change, or title edit stays on screen instead of being cleared by the list reload.
- d01c34c: The FileBucket README's access-control examples construct `new Auth(scope, 'auth')` instead of the removed `AuthBasic`. For frontend code and tests, the scaffolded `AGENTS.md` says to import `ApiError` and `isBlocksError` from `aws-cdk-blocks/client`.
- 0ff1e1f: The `auth` template README states that `--template auth-cognito` is an alias for `auth`.
- 450e25f: `EmailClient` warns at synth when `fromAddress` is on a reserved domain that SES can never verify, such as `example.com` or anything under `.test`. The demo template's sender is an `EMAIL_SENDER` constant, which you replace with a verified SES identity before deploying to production.
- c3aecc5: Adding AWS Blocks to an existing project makes sure `node_modules` is git-ignored. A `.gitignore` that already ignores it, or that un-ignores it with `!node_modules`, is left as it is.
- c6a59f4: The Next.js adapter accepts `@opennextjs/aws` 4.1.x without the out-of-range warning. An app that doesn't declare `@opennextjs/aws` builds with 4.1.14 instead of 4.0.3, and the build warns for `next` versions below `>=15.5.28 <16 || >=16.4.1`.
- 2b144de: Adds an `observability` template. `npx @aws-cdk-blocks/create-blocks-app my-app --template observability` scaffolds a backend-only app with Logger, Metrics, Tracer, and a CloudWatch Dashboard.
- 5a31d94: The `react` template's e2e checks that creating, reprioritizing, and deleting a todo each reach a live Realtime subscriber. The `demo` template's EmailClient e2e checks the sent mail in the local outbox and that an invalid address is rejected.
- 42b84b2: Adds `getChannel(namespace, channel, { scope: 'exact' })`, whose token authorizes the channel only and none of its sub-channels. `publish()`, `subscribe()`, and `getChannel()` throw `RealtimeErrors.ValidationFailed` for a channel name that is empty or has an empty, `.`, or `..` segment.
- 5f55dac: The scaffolded `AGENTS.md` says that a method is called as `<exported name>.<method>`, not by the second argument to `new ApiNamespace(…)`.
- e286b16: The first-run telemetry notice lists what an event can include and never includes, says the collection endpoint receives your IP address, and names the opt-out, which is CDK's. What is collected and when has not changed.
- c00ab16: The first-run telemetry notice and the `aws-cdk-blocks` README say that the collection endpoint does not store your IP address, except in logs of requests that its firewall blocks. Events are kept for up to 1 year, and logs of all requests, blocked or not, for up to 10 years.
- 5247488: The commented `KVStore` example in the `bare` template shows a secondary index, a point read with `get()`, and a newest-first index query with `order: 'desc'`. The `api-only` template's items table gains the same index and sort-order notes as comments.
- aaf473e: In the template e2e tests, `npm run test:e2e` waits for the dev server to answer before it imports the generated client. A newly exported API namespace is no longer `undefined` in the test.
- 1b18478: Scaffolded apps with a frontend ship a favicon, so the browser no longer gets a `/favicon.ico` 404 on every page load.
- 9434f01: The `cdk-blocks/index.ts` scaffolded by the `bare`, `backend`, `nextjs`, and `cron` templates explains that clients call an API by its export name. A new client namespace such as `orders.create()` needs its own `export const orders = new ApiNamespace(...)`.
- 475054b: The `test/e2e.test.ts` file in new apps no longer hides the global `setTimeout`. The promise version from `node:timers/promises` is imported as `sleep`.
- 5f55dac: In the `demo` and `auth` templates, `updateTodo` copies only `completed`, `priority`, and `title` from the request, and new apps key per-user data on `user.userSub`. If you scaffolded an app from either template, make the same change to its `updateTodo`.
- 1ade81b: The `api-only` template README explains that every API method is a public endpoint until you gate it with `auth.requireAuth(context)`. The template tests check that every method that signs a URL starts with `requireAuth` or `requireRole`.

## 0.4.0

### Minor Changes

- b16e5b6: Every deployable template has an `npm run sandbox:deploy` script that deploys once and exits. In an existing app, pass `deployOnly: process.argv.includes('--deploy-only')` to `startSandbox({ ... })` and add the script `"sandbox:deploy": "tsx aws-blocks/scripts/sandbox.ts --deploy-only"`.
- d79a0bd: Adds `npm run sandbox:preview`, which deploys a hosted preview sandbox, prints the hosted site URL, and exits. A plain sandbox deploy removes the preview, because they deploy one stack, and `npm run sandbox:destroy` tears a preview sandbox down.
- 82ea78a: A project config can no longer re-enable telemetry that a global config disabled. If you relied on that, re-enable globally with `npx blocks-telemetry --enable --global`.

### Patch Changes

- 2f85a1b: The generated `AGENTS.md` gives one command that lists the docs folders and prints the block catalog, so agents read folder names instead of guessing them. It also names `core/README.md` for `ApiNamespace`, `ApiError`, and the typed client.
- d8d46e8: The `AGENTS.md` that `create-blocks-app` adds to every new app covers live data. It recommends `Realtime` for pushing updates, and gives rules and a typed snippet for polling.
- 2d78849: Scaffolded `AGENTS.md` now states which storage block to use: default to `DistributedTable` for app records you list or query as a collection, and use `KVStore` for values you read and write by one key.
- 34e758c: Stabilize the CLI telemetry HTTP test by waiting for delivery instead of a fixed delay and cleaning up its local server and temporary files even when the test fails or times out.
- 6a94537: New apps created from the `bare` template include `zod` in their dependencies. When you add AWS Blocks to an existing project with `--template bare`, the example comment still tells you to run `npm install zod`.
- 9fa8e37: The sample methods in the `demo` and `auth-cognito` templates call `auth.requireAuth(context)` and scope keys and file paths per user. Every template `.gitignore` ignores `.env`, `.env.*` except `.env.example`, `*.pem`, `*.key`, `*.p12`, `credentials` files, and `.aws/`.
- 50b8c94: `npm run deploy` and `npm run sandbox` check that CDK has been bootstrapped in the target account and Region before they synthesize. If it has not, they stop with the command to run, `npx cdk bootstrap aws://<account-id>/<region> --app=`.
- 42591d2: `.bb-data/` is git-ignored in the `nextjs` template and when you add AWS Blocks to an existing project or an Amplify Gen 2 project. That directory holds local dev state, including every `AppSetting` and secret value in `.bb-data/settings.json`.
- 19c3b94: The default template shows an error message when loading, adding, or deleting a todo fails. A failed add keeps the typed title in the input so you can retry.
- 8527195: Add a DistributedDatabase (SQL) atomic-transfer e2e to the demo template, raising daily canary coverage to 12/20 Building Blocks.
- d621235: The `demo` template has e2e tests for Secret and KnowledgeBase, with no change to template runtime behavior.
- 1c977b5: The demo template's KV, cookie, and todo-error status lines use the `StatusMessage` primitive from `@aws-blocks/blocks/ui`. Each status is an ARIA live region, and a missing key or cookie shows as a neutral `idle` result instead of an error.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- d062eeb: `npm run deploy` and `npm run sandbox` print the deployment target before they deploy, with the credentials, the Region, the account name, and the AWS account plan. Account IDs, ARNs, error text, and plan credits are not printed.
- 63b154f: The typed RPC client POSTs to `/aws-blocks/api/{namespace}`, and the shared gateway routes each namespace to the compute that hosts it. Deploy the backend before clients built against it, pass the base URL in `ApiNamespaceClientOptions.url`, and make your own proxy forward `/aws-blocks/api/*`.
- 3ae22e6: The Next.js adapter builds with `@opennextjs/aws@4.0.3` when the app does not declare `@opennextjs/aws`, and warns when the app's `next` version is outside OpenNext's peer range. Run `npm install --save-dev @opennextjs/aws@~4.0.3` to declare it.
- ca60fc2: The Next.js template shows a failed greet call in a `StatusMessage` region, which clears on the next successful greet.
- 276e365: The React template shows an error message when loading, adding, or deleting a todo fails. A failed add keeps the typed title in the input so you can retry.
- 890f15f: The `nextjs` template wraps each page section in a `SectionBoundary` error boundary, and the `demo` template's `index.html` declares `<meta charset="utf-8">`. In an existing app, copy `section-boundary.tsx` into `src/app/`, wrap each section in `<SectionBoundary>`, and put the tag first in `<head>`.
- f704a68: Adds `StatusMessage` to `@aws-blocks/auth-common/ui`, re-exported from `@aws-blocks/blocks/ui`, a themed status line for loading, success, and error states. `StatusMessage(options?)` returns `{ element, set }`, so you mount `element` and call `set(kind, text)`.

## 0.3.0

### Minor Changes

- 8f725b6: **Breaking: `Database` retains automated backups for 15 days and exports the PostgreSQL engine log to CloudWatch Logs, so existing stacks show a CloudFormation diff.**

  To upgrade:

  1. Review the diff and snapshot before deploying.
  2. To encrypt storage, set the `@aws-blocks/bb-data:encryptStorageByDefault` context flag, as the new `cdk.json` templates do, or pass `storageEncryptionKeyArn`.
  3. On an already-provisioned cluster, first snapshot it, restore it with encryption enabled, then cut over.

  Turning encryption on or off for a deployed cluster replaces it with a new, empty cluster that has no schema.

- 4ae500e: Adds a `dev:stop` npm script to every standalone template, so `npm run dev:stop` stops the local dev server. `@aws-blocks/core/scripts` exports `stopDevServer`, `runStopCli`, `stopMessage`, and the `StopResult` type.
- 6d764f7: `AWS_BLOCKS_DISABLE_TELEMETRY` accepts `true` and `yes` in addition to `1`, case-insensitive and trimmed. If you already export `AWS_BLOCKS_DISABLE_TELEMETRY=true` or `=yes` for another tool, Blocks telemetry is disabled where it was still on before.
- 122c49c: **Breaking: an opted-out run with `--telemetry-file` writes no identifiers, prints no notice, writes no file, and sends no HTTP.** To capture events without sending them, use `BLOCKS_TELEMETRY_ENDPOINT=http://127.0.0.1:1 <cmd> --telemetry-file=<path>` instead of combining the flag with `AWS_BLOCKS_DISABLE_TELEMETRY`. That run is consented, so it still writes the installation ID and prints the notice.
- 66f4be2: Templates no longer set `BLOCKS_SANDBOX` or pass `crossDomain` to the auth Building Block. In an app from an earlier template, delete the `if (sandboxMode) { blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true') }` block and the `crossDomain` line, because `blocksStack.handler` is removed.

### Patch Changes

- 299c0e9: The scaffolded `AGENTS.md` states that the auth backend renders no UI, names `Authenticator` and `AuthenticatedContent` as the parts to mount in the frontend, and gives a signed-out and signed-in check. Documentation only.
- b8ec583: The `api-only` and `sql` templates set the `@aws-blocks/bb-data:encryptStorageByDefault` context flag in `cdk.json`, so new projects start with Database storage encryption on, like every other template.
- 440ecce: When the AWS credential check before `npm run deploy` and `npm run sandbox` fails, the message names the profile and the command that fixes its credentials. `@aws-blocks/core` requires AWS SDK for JavaScript clients 3.936.0 or later.
- 5d6656a: Adds the `apiFrontDoor` prop, and `publicApiUrl` on `BlocksStack` and `BlocksBackend` for the URL clients should call. Setting `apiFrontDoor: "cloudfront"` puts a CloudFront distribution in front of the API, and switching tiers changes the API's endpoint domain and signs every user out.
- 38ce80c: `npm run dev` listens on `127.0.0.1` instead of every interface, and the local realtime WebSocket rejects a client-sent `publish` and checks `Origin`. For a container or remote devbox, set `BLOCKS_DEV_HOST=0.0.0.0`, and publish from the server with `Realtime.publish()`.
- 002b063: The Next.js starter E2E test checks the home page response and the Blocks config endpoint instead of the sample page title. A separate test validates the sample API, with guidance to update it when you replace the sample methods.
- f1eb149: `--telemetry-file` keeps every event of a run instead of only the first, appended to the same JSON array. Update anything that asserts the file holds exactly one event.
- 8ca3692: Adds a `ui-theme` design-token layer with a light and dark palette, used by the shared Auth components and the `create-blocks-app` templates. `@aws-blocks/blocks/ui` exports `injectTheme`, `THEME_CSS`, and `THEME_STYLE_ID`, and the new `@aws-blocks/blocks/theme` subpath exports only the token layer.
- 7c19c4f: Adds an opt-in `--wait-live` flag to `npm run deploy`. With it, the deploy prints `BLOCKS_DEPLOYED` only once the new build is served, and exits non-zero if that is not confirmed within `--wait-live-timeout=<seconds>`, default 180.
- 74e5581: The scaffolded `test/e2e.test.ts` starts and stops the dev server on Windows, where `npm run test:e2e` failed with `spawn npm ENOENT` before.

## 0.2.0

### Minor Changes

- f066594: Adds the `sql` and `api-only` starter templates to `npm create @aws-blocks/create-blocks-app`. `sql` is a PostgreSQL backend on the `Database` Building Block, and `api-only` is a headless JSON API service with no frontend.

### Patch Changes

- bbd2c13: The scaffolded `AGENTS.md` states the framework model inline, including the client model, method namespacing, auth via `requireAuth`, and a minimal end-to-end example.
- 18f4014: The `demo`, `nextjs`, and `auth-cognito` templates have a README. `npm run spec` works in the `react` template, and the `backend` template no longer declares `@aws-blocks/hosting`.
- a649895: A successful `npm run deploy` or `npm run sandbox` prints one stable last line, `BLOCKS_DEPLOYED url=<frontend> api=<backend>`, that a script can grep. For a backend-only app and for `npm run sandbox`, the line omits `url=`.
- aeca8e6: The Next.js template runs its local frontend with webpack, so `npm run dev` renders the scaffolded app correctly with local Blocks workspace packages. Its e2e test starts the dev server itself.
- e034e20: The starter `test/e2e.test.ts` in six templates has a readiness assertion that checks `/.blocks-sandbox/config.json` and does not depend on the sample API. Update or delete the sample-API assertions when you replace the sample API.
- a23b8d8: **Breaking: a plain `Error` thrown from an API method reaches the client as a generic `500` with `"Internal error"` instead of its raw message.** To send a specific status, name, and message to the client, throw an `ApiError`, for example `new ApiError("Todo not found", 404, { name: "TodoNotFoundException" })`. Building Block errors keep their name and message on the wire.
- 4794cb8: `create-blocks-app` scaffolds into a directory that contains only VCS, editor, and OS metadata files or an `INSTRUCTIONS.md` seed, instead of aborting. Any other existing file still blocks scaffolding, and the error lists each conflicting entry.
- ca3b54a: The scaffolded `AGENTS.md` and the `react`, `default`, and `bare` template READMEs document the single RPC endpoint, `POST /aws-blocks/api`, with a curl example.
- 465a002: Telemetry uses ci-info for CI detection, so Taskcluster, Netlify, Vercel, and 40+ other CI providers are identified. It honors `CI=false`.

## 0.1.23

### Patch Changes

- f24961b: Add a build script to the backend template so freshly scaffolded backend apps support `npm run build`.
- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.
- fef57e7: Add the AWS CDK CLI to generated template development dependencies.
- 6496713: Replaces `registerVpcEndpoint` with `registerVpcGatewayEndpoint` and `registerVpcInterfaceEndpoint`, and reduces `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`.
- d9b442e: Make starter template E2E setup wait for the Blocks server without depending on a sample API.

## 0.1.22

### Patch Changes

- 46b7c89: Adds a `blocks-generate-client` bin to `@aws-blocks/blocks` that generates the local `aws-blocks` package's client entry point. The templates run it as `"prebuild": "blocks-generate-client"`, so a fresh checkout resolves the package and `cdk synth` no longer fails.

## 0.1.21

### Patch Changes

- 9d4ccea: Adds `secret('KEY')` and `config('KEY')` to hosting and pipeline, which keep values in AWS Secrets Manager and SSM Parameter Store for `getSecret('KEY')` and `getConfig('KEY')` to read at runtime. Set values with `npm run secret` and `npm run config`, and run `npm run typegen` for typed keys.
- 0ac3879: `sandbox` and `deploy` check AWS credentials before the synth and exit with guidance when they are missing, expired, or invalid. A network or service error only warns, and the check is skipped with a warning when no region is set in `AWS_REGION` or `AWS_DEFAULT_REGION`.

## 0.1.20

### Patch Changes

- 7b4c62d: **Breaking: `BlocksStack.create` and `BlocksBackend.create` require a `defaults` field.** Pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`, which replaces the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin. A per-block option still wins over `defaults`. The experimental `hardening` prop is removed with its `resolve*` helpers.
- 6918752: Use the lazy Lambda handler factory in the React template.
- 8966cfb: Telemetry reports runs on Render and Taskcluster as `ci:true`, detected from `RENDER` and `TASKCLUSTER_ROOT_URL`.

## 0.1.19

### Patch Changes

- 1e37c67: `@aws-blocks/blocks` ships one docs folder per Building Block under `docs/<block>/` and a Building Block catalog in the package README. The scaffolded `AGENTS.md` tells agents to locate docs with `require.resolve('@aws-blocks/blocks/docs/<block>/README.md')`.

## 0.1.18

### Patch Changes

- 75f5446: Add optional `fallback` parameter to `AuthenticatedContent` for rendering alternative content when the user is not authenticated.
- 8264dd0: The `auth-cognito` template has the `vendorize` script, so `npm run vendorize` works in apps scaffolded from it.

## 0.1.17

### Patch Changes

- 50dbd0e: Include the local dev-server script and use public AWS Blocks imports when adding AWS Blocks to an Amplify Gen 2 project.

## 0.1.16

### Patch Changes

- fc33428: Telemetry is now enabled in CI for `create-blocks-app`, the same as all other CLI commands. With `NODE_DEBUG=blocks-telemetry`, the telemetry worker inherits the parent's stderr, and `console` treats a missing browser opener as success instead of failing.

## 0.1.15

### Patch Changes

- f6a7fc7: In the `demo` template, `setCookie` and `deleteCookie` reject a cookie name or value that contains `\r` or `\n`, and the frontend `escapeHtml` helper escapes single quotes to `&#39;`.
- 919d38c: The `getLastCode` OTP helper in the `auth-cognito` template returns the code in local dev and `null` in a deployed environment.

## 0.1.14

### Patch Changes

- a1de3b8: `create-blocks-app` rejects `--template amplify` on a fresh directory with a message that points at `--template default`, instead of crashing mid-copy. The `auth-cognito` and `demo` template descriptions state the vanilla-DOM frontend they ship.
- 3c365e3: Sanitize user-controlled values in demo template innerHTML assignments
- a1de3b8: `--help` for `create-blocks-app` lists every template with a one-line description.

## 0.1.13

### Patch Changes

- e839301: The external database connection string moves to a stack-scoped SSM parameter, `/<stackName>-db-url`, so two apps in one account, region, and stage no longer overwrite each other. The previous `/blocks/{stage}/db-connection-string` parameter is orphaned and self-heals on the next deploy.

## 0.1.12

### Patch Changes

- ec1fc6c: In the demo template, `listTodos()` always uses `query()` with a `userId` filter instead of falling back to `scan()` when no `sortBy` is provided, so users see only their own todos.

## 0.1.11

### Patch Changes

- a23b1fb: The `react` template serves the backend and the SPA from one origin on `:3000` with a single `npm run dev` server, so OIDC and other browser-navigation auth flows work locally.

## 0.1.10

### Patch Changes

- f42c604: Stack names are derived from a `stackId` in `.blocks/config.json`, generated at scaffold time, as `<stackId>-prod` for production and `<stackId>-<username(8)>-<random(6)>` for a sandbox. Templates import `getStackId()` and `getSandboxId()` from `@aws-blocks/blocks/scripts`.

## 0.1.9

### Patch Changes

- 95efe42: Honor `--skip-install` when creating a fresh project so scaffolding can complete without running `npm install`.

## 0.1.8

### Patch Changes

- 6c7bb69: Adding Blocks to an existing project uses the template you pass with `--template` for the copied `aws-blocks/` workspace, `cdk.json`, and devDeps. It always used the `default` template before.

## 0.1.7

### Patch Changes

- a98fa95: The react template uses `aws-cdk-lib` `^2.257.0` instead of `2.245.0`, so `npm run dev` no longer breaks with `Failed to resolve import "@aws-blocks/bb-realtime/mock-middleware"`.

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

- 7b80811: The `@aws-blocks/blocks` package ships a `docs/` folder with every Building Block README and a generated `index.md`, at `node_modules/@aws-blocks/blocks/docs/`. The AGENTS.md templates of `@aws-blocks/create-blocks-app` point to it.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements

## 0.1.0

Initial version
