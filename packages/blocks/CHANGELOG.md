# aws-cdk-blocks

<!-- doc-snippet: skip-file — release notes show the API of past releases, including the removed AuthBasic and AuthOIDC blocks -->

## 1.0.0

The first stable release. The changes since 1.0.0-rc.2 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/blocks` 0.x

- The package is now `aws-cdk-blocks`. Install it in place of `@aws-blocks/blocks`, and change the import specifiers.
- be8864c: Check conversation ownership in `stream()`, `resume()`, `getConversation()` and `getPendingInterrupts()`, and scope `getChannel()` to the caller.
- c4e4e67: Scope `inferenceOnly` sessions to the user by default.
- 5f55dac: A web frontend served from another origin than its API can sign in with a federated provider.
- 5f55dac: `Auth` can share its user pool with a frontend that signs in directly against Cognito, such as one built with the Amplify client libraries.
- 5f55dac: Adds `AuthErrors`, the auth error names, with the `AuthErrorName` type and the `isAuthError()` and `isAuthErrorName()` guards.
- 5f55dac: `AuthBasic`, `AuthCognito` and `AuthOIDC` are removed.
- c95d7c7: `Auth` lets you keep end users from writing an attribute your app relies on for authorization.
- 5f55dac: Show local social and SAML sign-in as unavailable.
- 5f55dac: The local user pool can check authenticator-app (TOTP) codes as Cognito does.
- 5f55dac: `Auth` options: a block-level `store` and one `providers` map.
- 5f55dac: Accept a `Secret` as a provider client secret.
- 5f55dac: `Auth` can send its user pool's email through your own Amazon SES identity, with the `email` option.
- 5f55dac: Add auth test helpers to `aws-cdk-blocks/utils`.
- 5f55dac: A signed-in user can set up an authenticator app (TOTP) through `auth.createApi()`, with no backend code.
- 5f55dac: `subscribeAuthState`, `getAuthStateSnapshot` and a shared auth-state store behind `submitAuthAction`. A sign-in or sign-out reaches every component and tab once.
- 5f55dac: Add `Auth` (`@aws-cdk-blocks/bb-auth`), the single authentication Building Block, exported from `aws-cdk-blocks`.
- 7c1eec5: An app that deployed a SQL block of an earlier release keeps its database.
- c67048e: `Database` is the only SQL block. `@aws-blocks/bb-data` and `@aws-blocks/bb-distributed-data` are removed. See "Upgrade from `@aws-blocks/bb-data`" in the `bb-database` README.
- 7c23ab9: Upload URLs carry signed constraints, download disposition is opt-in, key validation is stricter, and invalid input returns 400.
- 684e22d: `npm run dev` starts the Nuxt and Astro dev servers.
- b2eb306: Lifecycle tasks return 0 for success, 1 for failure, 2 for invalid usage and 130 for an interruption. `--output json` gives a structured result.
- 792e269: Migration moves recognized generated script wrappers to package tasks and carries generated dev settings into `package.json#blocks.dev`.
- a34c850: The documentation tasks read the docs shipped with the installed `aws-cdk-blocks`, including in hoisted workspaces.
- c42ba42: The hidden `.blocks/` folder is now `.cdk-blocks/`, and local data moves from `.bb-data/` to `.cdk-blocks/local/data/`.
- 703238f: The scaffolded backend folder is `cdk-blocks/` instead of `aws-blocks/`.
- 45a05d1: The per-deploy state directory is now `.cdk-blocks-sandbox/`.
- 1de6ea4: The reserved URL prefix is now `/cdk-blocks/` (`/cdk-blocks/api`, `/cdk-blocks/auth/*` and others). `/aws-blocks/` still works as an alias.
- 9ebf67a: An API namespace can run on a `container` compute.
- 5f55dac: Opt in to HTTP error statuses for an API namespace.
- 4665f81: `defaults.appIdentity` gives each app an identity, so many apps can share one AWS account.
- 8894669: Telemetry follows your CDK CLI telemetry setting. The old opt-out (`AWS_BLOCKS_DISABLE_TELEMETRY`) is removed. To opt out, run `cdk cli-telemetry --disable` or set `CDK_DISABLE_CLI_TELEMETRY=1`.
- 2c9005f: Reject malformed native declarations instead of dropping them.
- 44c7377: `defaults.strictNamespacePlacement` serves each API namespace only on the compute it is placed on.
- 227a856: `withAuth(fn, cookies, { allowAnonymous: true })` runs `fn` signed out when no cookies are found, instead of throwing a `401`.
- afad513: A plain `allowedOrigins` entry such as `https://app.example.com` now matches exactly, ignoring case.
- 5f55dac: New apps now use the unified `Auth` block.
- 9801a5b: Each deploy stage has its own CDK outputs file.
- 64f7247: `EmailClient.sendBatch()` now takes at most 100 messages per call by default.
- 93d533a: Add `allowPlainHttp`, an explicit opt-out for builders who need a plain-HTTP front door in production.
- adb6077: A production synth fails for a front door that would carry sign-in, session cookies or the origin-verify secret over plain HTTP. To keep such a door, set `allowPlainHttp`.
- fb29c06: Lock the CloudFront door's server origin with a random secret, a regional web ACL and opt-in access logs.
- 40d25ec: Keep credentialed and cookie-setting SSR responses out of the shared edge cache.
- d51b8ee: Add `KnowledgeBase.asAgentTool()`, which returns a search tool for an Agent's `tools` callback.
- 6d3077e: `KVStore` is the only key-value block: `DistributedTable` is folded in. A store of release 0.4.0 or earlier needs `LegacyKVStore`. See "Upgrade from release 0.4.0 or earlier" in the `bb-kv-store` README.
- e1e4844: Tasks run as package scripts (`npm run dev`, `npm run deploy` and the others) instead of the `cdk-blocks` executable. Run `npm run migrate` to update an older app.
- 2095f31: `ctx.request.url.pathname` no longer includes the API Gateway stage when deployed.
- 42b84b2: Add `getChannel(namespace, channel, { scope: 'exact' })` and validate channel names.
- eb60b04: Bind channel handles to the signed-in user, re-check subscriptions on ping, and add `revokeAccess()`.
- 8894669: The `telemetry` app task is gone.
- 58817b0: Service-principal trust policies get `aws:SourceAccount` and `aws:SourceArn` conditions, and the synth checks for them.

### Since 1.0.0-rc.2

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The docs correct the API Gateway throttling defaults and separate a WAF on the gateway stage from one on the Hosting distribution. `MIGRATING-FROM-SCRIPTS.md` lists what `npm run migrate` rewrites, keeps, and deletes.

## 1.0.0-rc.1

### Minor Changes

- c42ba42: **Breaking: the hidden `.blocks/` folder is now `.cdk-blocks/`, and local data moves from `.bb-data/` to `.cdk-blocks/local/data/`.**

  To upgrade:

  1. Run `mkdir -p .cdk-blocks && git mv .blocks/config.json .cdk-blocks/config.json`, then delete the empty `.blocks/` folder.
  2. In your tsconfig `include`, change `.blocks/**/*.d.ts` to `.cdk-blocks/**/*.d.ts`.
  3. Run `npm run typegen` and commit `.cdk-blocks/hosting-values.d.ts`.

  Local data is copied to the new location the first time each block opens its store. Pull request #1607 has the full notes.

### Patch Changes

- d380931: `createChat` and `useChat` no longer show the previous turn's answer as the new one when the chat reconnects before a turn has streamed any text. The client keeps waiting for the turn's own chunks.
- 3081521: The deployed Lambda handler reads the `x-blocks-user-agent` request header in any letter case. Before, a client that sent the header in another casing over HTTP/1.1 lost its `client/<lang>/<version>` attribution.
- e529b00: `asRole()` works after the first deploy of a cluster that `Database` provisions, and a migration can grant a role to the app role. Write the app role as `${app_role}`, for example `GRANT authenticated TO ${app_role} WITH INHERIT FALSE, SET TRUE;`.
- e529b00: A migration on a local `aurora` cluster can run `CREATE EXTENSION` for the contrib extensions that PGlite ships and Aurora PostgreSQL supports, such as `citext`, `pgcrypto`, and `pg_trgm`. An extension that PGlite does not ship, such as `vector`, still fails locally.
- 6b1086b: The `Agent` and `KnowledgeBase` READMEs are corrected and reorganized. Model presets and Bedrock access for `Agent` moved to `MODELS.md`, which ships in the package.
- 6ae587a: The READMEs document `Auth` setup, options, and error handling, and the `auth-common` README lists the auth error names. They note that sessions default to 30 days and that users sign in again after migrating from `AuthCognito`.
- 8fbbeca: The hosting docs cover front-door compatibility, hosting options, and synth errors, and the package ships the custom front-door guide. The pipeline quick start uses `Pipeline.create()` and documents the pipeline options and their defaults.
- e529b00: A sandbox table that the index manager recreates keeps its encryption key, TTL, tags, point-in-time recovery, stream, and table class, and a `protection: 'locked'` table is no longer deleted. A key from `KVStore.fromKmsKey()` must allow the index manager's role in its key policy.
- 23692f1: Every CLI command sends one usage event, and the CDK CLI telemetry opt-out still turns all of it off. `generate types --watch` stops cleanly on Ctrl-C or SIGTERM.
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

- be8864c: **Breaking: `getConversation()`, `getPendingInterrupts()`, and `getChannel()` require the caller's `userId`, and `stream()` and `resume()` reject a conversation that user does not own.**

  To upgrade:

  1. Change `getPendingInterrupts(id)` to `getPendingInterrupts(id, { userId })`.
  2. Change `getConversation(id)` to `getConversation(id, { userId })`.
  3. Change `getChannel(channelId)` to `getChannel(channelId, { userId })`.
  4. Create each conversation with `createConversationId()` before you pass its `conversationId` to `stream()`.
  5. On AWS, pass a `conversationId` instead of reusing a `channelId` to keep memory across turns.
  6. Reload chat sessions that were open across the upgrade.

  Take the `userId` from the authenticated session, never from a request parameter.

- c4e4e67: **Breaking: an `inferenceOnly` agent keys each session by the `userId` together with the `conversationId`, and requires `options.userId`.**

  To upgrade:

  1. Pass the authenticated user's id as `options.userId` to `stream()`, `resume()`, and `getChannel()`, which throw `AgentErrors.InvalidUsage` without one.
  2. To key sessions by the `conversationId` alone, as before, set `sessionScope: 'shared'`, but only if callers can't choose the `conversationId` or `channelId`.

  Sessions previously keyed by the bare `conversationId` are no longer resumed, and with `'shared'` an agent cannot use `resume()` or tools that set `needsApproval` or `interrupt`.

- 5f55dac: Adds `createAuthClient()` in the new `@aws-cdk-blocks/bb-auth/browser-client` entry, for a web frontend served from another origin than its API. It replaces `AuthOIDC`'s `getClient()` browser client, and the README section "Frontend on a different origin" lists the backend settings.
- 5f55dac: Adds `users.caseSensitive`, `allowBearerAuth: { clientIds }`, and `user.federatedIdentity`, so `Auth` can share its user pool with a frontend that signs in directly against Cognito. The README section "Planning to use Amplify client libraries?" covers them.
- 5f55dac: Adds `AuthErrors`, the shared vocabulary of auth error names, with the `AuthErrorName` type and the `isAuthError()` and `isAuthErrorName()` guards. Match an auth failure by name with `isAuthError(e, AuthErrors.NotAuthenticated)`, on the server and in the browser.

- 5f55dac: **Breaking: `AuthBasic`, `AuthCognito`, and `AuthOIDC` are removed, and `Auth` replaces all three.**

  To upgrade:

  1. From your app's root, run `npx @aws-cdk-blocks/bb-auth migrate --dry-run` to preview the changes.
  2. Run `npx @aws-cdk-blocks/bb-auth migrate` to rewrite the files.
  3. Resolve each `TODO(aws-blocks-auth-migrate)` comment and follow `MIGRATION.md` in `@aws-cdk-blocks/bb-auth`.
  4. Keep every block's id exactly as it is, because changing it replaces the user pool and deletes its users.
  5. If you implement `BlocksAuth` yourself, add `requireRole`, which is now required.

  `AuthBasic` users sign up again, `AuthOIDC` users sign in once more, and a `cognitoFederated()` provider's user pool is replaced. Telemetry in `@aws-cdk-blocks/core` counts `Auth` as an official Building Block, and no longer counts the three removed blocks.

- c95d7c7: Adds `UserAttribute.userWritable` to `Auth`, which you set to `false` to stop end users from writing an attribute, and `admin.updateUserAttributes(username, attributes)`. With `userPool: Auth.fromExisting(…)`, declare a custom attribute in `users.attributes` to keep it user-writable.
- 5f55dac: In `npm run dev`, `getAuthState()` marks social, SAML, and `type: 'oidc'` sign-in actions on the default store with a new optional `AuthAction.unavailable` reason. The `Authenticator` renders those buttons disabled, and API clients get a `501` JSON error named `ProviderUnavailableException`.
- 5f55dac: Adds the local-only option `totpVerification: 'rfc6238'`, which makes the local user pool accept only the RFC 6238 code of the user's shared secret instead of any six digits. `totpCodeFor(sharedSecret, time?)` from `aws-cdk-blocks/utils` computes the code an authenticator app would show, for tests.
- 5f55dac: `Auth` takes a block-level `store` and one `providers` map, keyed by provider id and tagged with its `type`. The default `store: 'cognito'` keeps users in a Cognito user pool, and `store: 'builtin'` has no user pool, so your backend verifies each provider itself.
- 5f55dac: A provider's `clientSecret` and Sign in with Apple's `privateKey` accept a string-valued `Secret` as well as an `AppSetting` created with `secret: true`. Create the `Secret` with `generate: true`, then after the first deploy set the real value with `npm run secret` and deploy again.
- 5f55dac: Adds the `email` option to `Auth`, which sends the user pool's email through your own Amazon SES identity and is required for email MFA and `users.preferredChallenge: 'EMAIL_OTP'`. `fromAddress` must be a verified SES identity, and the deploying role needs `iam:CreateServiceLinkedRole`.
- 5f55dac: Adds the Node-only test helpers `getLastAuthCode` and `createTestClient` to `aws-cdk-blocks/utils`. `getLastAuthCode` returns the verification code the local pool sent to a user, and `createTestClient` returns the app's typed clients with a cookie jar of their own.
- 5f55dac: `setAuthState` from `auth.createApi()` takes `setUpTotp`, `verifyTotpSetup`, `getMfaPreference`, and `updateMfaPreference` actions, and the new `MfaSettings` panel from `aws-cdk-blocks/ui` renders them. Native code that matches exhaustively over the `setAuthState` input needs the four new cases.
- 5f55dac: Adds `subscribeAuthState` and `getAuthStateSnapshot`, exported from `aws-cdk-blocks/ui` and `@aws-cdk-blocks/auth-common/ui`. `submitAuthAction` notifies every `onAuthChange` subscriber in this tab and in other tabs, so use it instead of calling `authApi.setAuthState(...)` directly.
- 5f55dac: **Breaking: adds `Auth`, the single authentication Building Block, which replaces `AuthBasic`, `AuthCognito`, and `AuthOIDC`.** Names that `aws-cdk-blocks` exported for the old blocks, such as `stubIdp`, `github`, `PasswordPolicy`, and `SignInResult`, now refer to `Auth`'s versions. See `MIGRATION.md` in `@aws-cdk-blocks/bb-auth` for the per-block steps and the `npx @aws-cdk-blocks/bb-auth migrate` codemod. An `AuthCognito` app that switches to `Auth` with the same block id keeps its user pool, its users, and their sessions.
- 7c1eec5: An app that deployed `DistributedDatabase` or the `@aws-blocks/bb-data` `Database` keeps its database, and `docs/guides/upgrading-older-apps.md` has the steps. Adds `DatabaseCluster.fromExisting({ dataApi: { clusterArn, secretArn, database } })` for an Aurora cluster through the RDS Data API.

- c67048e: **Breaking: `Database` from `@aws-cdk-blocks/bb-database` is the only SQL Building Block, and `@aws-blocks/bb-data`, `@aws-blocks/bb-distributed-data`, and `@aws-blocks/data-common` are removed.**

  To upgrade:

  1. Import `Database`, `DatabaseCluster`, `DatabaseErrors`, and `sql` from `aws-cdk-blocks`.
  2. To keep an old `@aws-blocks/bb-data` cluster, make that line a `LegacyDatabaseCluster` and put a `Database` with a new id on it.
  3. Replace `DistributedDatabase` with a `Database` of the same id, which keeps its cluster.
  4. Replace `Database.fromExisting()` with `DatabaseCluster.fromExisting()`, passed as `cluster`.
  5. Replace `withRLS()` with `asUser()` or `asRole()`, and use `DatabaseDialect` from `@aws-cdk-blocks/bb-database/kysely` for Kysely.
  6. Store the connection string of an existing database with `npm run db -- connect --stage <stage>`, not a `*_DB_URL` or `*_CONNECTION_STRING` environment variable.

  Data is not moved, and `crud()`, `ensureSecrets`, and the `npm run db` commands `pull` and `generate-types` are removed.

- 7c23ab9: **Breaking: `putUrl()` and `createUploadHandle()` always sign a `Content-Type`, which is `application/octet-stream` when you pass no `contentType`.**

  To upgrade:

  1. Pass to `putUrl()` the `contentType` the client will send, or send `Content-Type: application/octet-stream` with the upload.
  2. Pass `contentType: file.type` to `createUploadHandle()` to keep storing the browser's file type.
  3. Allow `Content-Type` in the `allowedHeaders` of your `corsRules`.

  Also adds the `contentLength`, `attachment`, `allowedContentTypes`, and `maxUploadBytes` options, validates keys more strictly, and answers `ValidationFailed` with HTTP 400 instead of 500.

- 684e22d: Without a `frontendCommand`, `npm run dev` and `npm run sandbox` detect `nuxt` and `astro` in the app's dependencies and start their dev servers. If your app starts `nuxt dev` or `astro dev` itself, remove that process or set `"blocks": { "dev": { "frontend": false } }`.
- b2eb306: AWS Blocks app tasks run through package scripts such as `npm run deploy`, and return 0 for success, 1 for failure, 2 for invalid usage, and 130 for interruption. Get the deployment result with `npm run -s deploy -- --output json` or `npm run -s deploy -- --query apiUrl`.
- 792e269: Migration moves recognized generated script wrappers to package tasks, carries generated dev settings into `package.json#blocks.dev`, and keeps customized wrappers. It requires a clean tracked working tree unless forced, and `--dry-run` previews the plan.
- a34c850: `npm run docs` lists the blocks and guides shipped with the installed version of `aws-cdk-blocks`. Run `npm run docs KVStore` for a block README, `npm run docs:api KVStore` for API details, or `npm run docs:search KVStore` to search the installed docs.

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

- 9ebf67a: An `ApiNamespace` can run on a `container` compute, and clients call it as before. A container that serves API namespaces needs a running task, so `scaling.minInstances: 0` fails synth, and `runContainer()` takes the backend module as `runContainer({ backend })`.
- 5f55dac: With the new `ApiNamespace` option `httpErrorStatus: true`, a call that throws an `ApiError` with a 4xx status is answered with that HTTP status instead of 200. `Hosting` then fails synth with `HttpErrorStatusErrorPagesError` if its distribution maps 403 or 404 to a page, so remove those pages.
- 4665f81: Adds `defaults.appIdentity: { id, reportOnly? }`, which tags every resource and IAM role AWS Blocks creates `app=<id>` and checks that derived names start with `<id>-`. It is opt-in, and the core README section "Running many apps in one AWS account" has the full notes.
- 8894669: **Breaking: telemetry follows your CDK CLI telemetry setting, and the AWS Blocks opt-out is removed.** `AWS_BLOCKS_DISABLE_TELEMETRY`, the `cdk-blocks telemetry` command, the `blocks-telemetry` binary, and the `telemetry.enabled` key in `.blocks/config.json` are gone, so if you opted out that way you are opted back in. Opt out with `CDK_DISABLE_CLI_TELEMETRY` set to `1` or `true`, with `cdk cli-telemetry --disable`, or with `cli-telemetry: false` in the `context` of `cdk.json` or `~/.cdk.json`.
- 2c9005f: **Breaking: spec generation exits 1 for a `null` or non-object `aws-blocks` key and for an unrecognized binding field, where it wrote a spec before.** Remove the offending key or field.
- 44c7377: Adds `defaults.strictNamespacePlacement`, which is `false` in both presets. Set `strictNamespacePlacement: true` so each compute serves only the namespaces placed on it, and a call to a namespace placed elsewhere gets a `-32601` "method not found" error.
- 227a856: Adds `withAuth(fn, cookies, { allowAnonymous: true })`, which runs `fn` signed out when no cookies are found instead of throwing a `401`. Responses to requests without cookies can be edge-cached, so check that the anonymous HTML of these pages is safe to cache.
- afad513: Plain origins in `defaults.allowedOrigins`, such as `https://app.example.com`, match exactly, and regex entries must escape `.`. Glob-style entries such as `https://*.example.com` are rejected and fail `cdk synth`, so use `https://[a-z0-9-]+\\.example\\.com` for subdomains.
- 5f55dac: Every template that signs users in uses `Auth` instead of `AuthBasic` or `AuthCognito`, and sign-up confirms the email address with a 6-digit code. The `auth-cognito` template is now `auth`, and the `amplify` overlay's `requireGroup()` is now `requireRole()`.

- 9801a5b: **Breaking: a production deploy writes its CDK outputs to `.cdk-blocks-sandbox/outputs.production.json` instead of `.cdk-blocks-sandbox/outputs.json`.**

  To upgrade:

  1. If a script, a CI step, or a launcher reads `.cdk-blocks-sandbox/outputs.json` for production, read `.cdk-blocks-sandbox/outputs.production.json` instead.
  2. If you call `openConsole({ outputsFile })` directly on an app that deployed production before upgrading, run `npm run sandbox` once or delete the stale file.

  `OUTPUTS_FILE` from `@aws-cdk-blocks/core/scripts` carries both paths.

- 64f7247: `EmailClient.sendBatch()` takes at most 100 messages per call by default and throws `InvalidInputException` for a larger batch, where it took any number before. Split the messages across calls, or set the new `maxBatchSize` option to raise the cap.
- 93d533a: Adds `allowPlainHttp` to the `alb`, `custom`, and stacked doors, an opt-out for a plain-HTTP front door in production. To keep serving plain HTTP in production, add `allowPlainHttp: true` to the door and acknowledge the `@aws-cdk-blocks/hosting:PlainHttpAllowedInProduction` warning.

- adb6077: **Breaking: a production synth fails when a front door would carry sign-in, session cookies, or the router's origin-verify secret over plain HTTP.**

  To upgrade:

  1. For `{ kind: 'alb' }` with an API, add a `certificate` and `features.domain`, or use the CloudFront or stacked door.
  2. For a `{ kind: 'custom', door }` whose URL is `http://`, return an `https://` url.
  3. For `{ kind: 'stacked', edge: 'cloudfront', router: 'alb' }` with an internet-facing router, give the router a `certificate` and `features.router.domain`, or set `internal: true`.

  A sandbox deploy warns as before, and outside a sandbox `Auth` throws `AuthErrors.InsecureTransport` instead of issuing a session over plain HTTP.

- fb29c06: The CloudFront door's server origin requires a random `Referer` value from Secrets Manager, and `waf: { enabled: true }` adds a second, REGIONAL web ACL per stack. To avoid SSR 403s while upgrading, deploy once with `serverOrigin: { acceptLegacyVerifyHeader: true }`, then again without it.

- 40d25ec: **Breaking: hosting no longer edge-caches SSR responses that set cookies, or that answer a request with `Authorization` or a cookie outside the cache key.**

  To upgrade:

  1. To keep a credentialed route cacheable, list its session cookie in `cacheKeyCookies` or `'authorization'` in `cacheKeyHeaders`.
  2. List analytics and consent cookies that never affect the rendered output, such as `_ga`, in `frontDoor.features.cacheGuardIgnoredCookies` to keep pages cacheable for visitors that carry them.

  The SSR cache policy's maximum TTL drops from 1 year to 1 day, so an origin `s-maxage` longer than a day is clamped to a day.

- d51b8ee: Adds `KnowledgeBase.asAgentTool()`, which returns a search tool for an Agent's `tools` callback. A required `filter` callback derives the metadata filter from the per-call tool context, and the tool is marked `untrustedOutput: true`.

- 6d3077e: **Breaking: `KVStore` takes over the data model of `DistributedTable`, and the `@aws-blocks/bb-distributed-table` package is removed.**

  To upgrade:

  1. Replace a `DistributedTable` with `new KVStore(scope, id, { schema, key, indexes, ttl })`, which keeps the table in place.
  2. Change `put(item)` to `put({ pk: item.pk, sk: item.sk }, item)` and `putBatch([item])` to `putBatch([{ key, value: item }])`.
  3. Change `for await (const item of table.query(o))` to `for await (const { value: item } of store.query(o))`.
  4. Change `DistributedTableErrors` to `KVStoreErrors`.
  5. On an existing `KVStore`, drop `ttl: true`, replace `removalPolicy`/`deletionProtection` with `protection`, and replace `ifValueEquals` on an object value with `ifFieldEquals`.
  6. For an existing `KVStore` table, destroy the stack and deploy again in a sandbox, or follow the README section "Upgrade from release 0.4.0 or earlier" for data you must keep.

  A deployed `KVStore` table cannot stay in place because the stored item format changed, and the mock converts local data the first time it loads it.

- e1e4844: **Breaking: the `cdk-blocks` executable is removed, and AWS Blocks tasks run through your app's package manager.**

  To upgrade:

  1. Upgrade `aws-cdk-blocks`.
  2. From the app directory, run `node --input-type=module -e "import 'aws-cdk-blocks/run'" -- migrate --dry-run` and review the plan.
  3. Run the same command without `--dry-run` from a clean Git working tree.
  4. Change by hand the custom wrappers that the migration reports.

  Structured tasks such as `npm run docs KVStore`, `npm run docs:api KVStore`, and `npm run docs:search "partition key"` print text in a terminal and JSON on a pipe or redirect.

- 2095f31: `ctx.request.url.pathname` is the route path in every environment and no longer includes the API Gateway stage when deployed. If you build an absolute link from it while clients call the API Gateway URL directly, add the stage yourself or build the link from your app's configured origin.
- 42b84b2: Adds `getChannel(namespace, channel, { scope: 'exact' })`, whose token authorizes the channel only and none of its sub-channels. `publish()`, `subscribe()`, and `getChannel()` throw `RealtimeErrors.ValidationFailed` for a channel name that is empty or has an empty, `.`, or `..` segment.

- eb60b04: **Breaking: Realtime tokens now carry `iat` and `jti`, and handles issued before the upgrade stop working.**

  To upgrade:

  1. Pass the session's user id, `user.userSub`, as `principal` in `getChannel(namespace, channel, { principal })` for every channel that belongs to a user.
  2. To revoke a user's access, call the new `rt.revokeAccess(principal)`, and make your app's `refresh` endpoint refuse that user too.

  Clients that pass `refresh` recover on their next reconnect, and other clients must call your API method again. Subscriptions are re-checked on every keep-alive ping and at fan-out.

- 8894669: **Breaking: the `telemetry` app task is gone, so `npm run telemetry` fails in a new or migrated app.** Telemetry follows your CDK CLI telemetry setting. Opt out with `CDK_DISABLE_CLI_TELEMETRY` set to `1` or `true`, with `cdk cli-telemetry --disable`, or with `cli-telemetry: false` in the `context` of `cdk.json` or `~/.cdk.json`.
- 58817b0: The IAM roles AWS Blocks creates scope every service-principal trust to the stack's account with `aws:SourceAccount` and `aws:SourceArn`. Synth warns about a role your app creates without them, and "Service-principal trust" in the `@aws-cdk-blocks/core` README shows how to resolve it.

### Patch Changes

- 3d7479a: On reconnect, `createChat` and `useChat` end a turn that failed while the chat was disconnected and pass the recorded error to `onError`. They no longer keep loading for about 11 minutes and then report a timeout.
- 36f3720: The stream no longer sends a `tool-call` chunk, or the `tool-result` chunk that follows, for a tool call that the user denied or that `maxToolIterations` stopped. Conversation history is unchanged.
- d46dfaf: create-blocks-app's Amplify overlay writes `"generateClient": false` in `package.json#blocks.dev`, so `npm run dev` keeps the overlay's own `cdk-blocks/client.js`. `npm run migrate` adds the same setting to an existing Amplify overlay.
- c6a3357: `AppSetting.put()` on AWS enforces the documented 4 KB limit before writing, the same way the local mock does. A non-secret value whose JSON serialization exceeds 4096 UTF-8 bytes throws `AppSettingErrors.ValidationFailed` and is not sent to SSM.
- 5f55dac: Adds two read-only properties to `AppSetting`'s CDK construct at synth time, `parameterName` and `secret`. `parameterName` is the SSM parameter name the setting resolves to, including an explicit `name` or an `AppSetting.fromExisting()` name.
- 5f55dac: `admin.scan` checks its filter before it reaches Cognito's `ListUsers`, in the local pool and on AWS alike. The attribute must be one Cognito can search on, and a value that contains a double quote, a backslash, or a control character is refused with `InvalidParameterException`.
- 5f55dac: `Auth` gives the same error for the same invalid sign-up or attribute update under `npm run dev` and on AWS. On a pool with `emailPassword: { selfSignUp: false }`, `signUp` always fails with `401 NotAuthorizedException`.
- 208115d: Adds `audit: true` to `Auth`, which writes one JSON log line for every session issued, failed sign-in, sign-out, and session revocation. The option is off by default, and records never contain a password, code, token, session id, or error message.
- 5f55dac: The `Authenticator` renders each action as a `<form>`, and its inputs carry `autocomplete` hints. A `<button>` without a `type` inside a field's `render` override submits the action, so give a button that should not submit `type="button"`.
- 5f55dac: On AWS, `Auth` checks user-attribute values itself before it calls Amazon Cognito. A client that sends a value that isn't a string gets `400 InvalidParameterException`, as under `npm run dev`, instead of `500 InternalErrorException`.
- 5f55dac: When synth refuses a change against the user-pool immutability baseline, the error also covers a change that was synthesized but never deployed. It gives the re-baseline command, `BLOCKS_AUTH_REBASELINE=<fullId>`, for that case.
- 5f55dac: `Auth` checks the values of its boolean options at construction, in `npm run dev`, at synth, and in Lambda alike. A non-boolean value such as `emailPassword: { selfSignUp: 0 }` is rejected with an error that names the option and the value it got.
- 5f55dac: A federated sign-in callback honours `error` and `error_description` only when they carry the `state` of the sign-in in progress. Any other callback gets `InvalidStateException`.
- ac4d4a1: `cdk synth` fails when a route of one `Auth` block collides with any other route, with a message naming both blocks and the fix. A single block whose own `redirects.callbackPath` or `redirects.signOutPath` lands on another of its routes fails synth too.
- 5f55dac: The cookie helpers' documentation now names `bb-auth` as their caller and refers to `bb-auth-basic`, `bb-auth-cognito` and `bb-auth-oidc` as the removed blocks they replaced.
- 5f55dac: Auth broadcasts are tagged per API, so `onAuthChange` for one API no longer receives another API's user. `broadcastAuthChange(user, api)` takes an optional `api` to tag a message the same way.
- 5f55dac: The `AuthFieldOverride` reference documentation no longer names `bb-auth-supabase`, a package AWS Blocks does not ship.
- 5f55dac: Federated sign-in callbacks compare the returned `state` and the ID token's `nonce` in constant time. A `state` or `nonce` of the wrong length or encoding is rejected with the usual `InvalidStateException` or `IdpErrorException`.
- 5f55dac: `auth.createApi()` is typed by the block's options, so `setAuthState` takes only the actions the configuration supports and `AuthState.user` has the block's own groups and attributes. Adds types such as `AuthActionInputOf<O>`, `AuthStateUser<O>`, and `AuthUserOf<A>`.
- 2eb62fa: The `hasAuthError` example in the `@aws-cdk-blocks/core` README and JSDoc submits the action with `submitAuthAction` from `aws-cdk-blocks/ui`. A direct `authApi.setAuthState()` call signs the user in but never notifies `onAuthChange` or `AuthenticatedContent`.
- 5f55dac: `Auth` answers 409 `PasskeysNotEnabledException` for a passkey action on a block without `passkeys`, and 409 `MfaNotEnabledException` for an MFA challenge with MFA off. `AuthErrors` in `@aws-cdk-blocks/auth-common` gains `PasskeysNotEnabled` and `MfaNotEnabled`.
- 5f55dac: The `Authenticator` and `AccountMenuBar` show a signed-in user's email address instead of a generated id. `AuthState.user` has an optional `displayName` for display only, so keep keying data on `userId` or `userSub`.
- 5f55dac: Synth warns with `@aws-cdk-blocks/bb-auth:FirstBaselineWithoutPool` when a block's first baseline records no user pool of its own, because that deploy can delete an existing pool and its users. `MIGRATION.md` says to deploy the codemod's output unchanged first and commit the baseline it writes.
- 5f55dac: When account state is hidden, `Auth` logs at `warn` the answers it withholds from the client on `resendSignUpCode`, `resetPassword`, `confirmSignUp`, and `confirmResetPassword`. The marker that lets the PreSignUp trigger skip a second `validateUser` call is signed with its own key.
- 5f55dac: With `emailPassword.revealExistingUsers` off, the default, `confirmSignUp`, `resendSignUpCode`, `resetPassword`, and `confirmResetPassword` give identical answers for an unknown, an unconfirmed, and an already-confirmed user. Set `revealExistingUsers: true` to get the informative errors.
- 5f55dac: `requireAuth().attributes` and `getCurrentUser().attributes` hold the ID token's string claims, so they don't include `updated_at` or `address`. To read either as a string, call `auth.getUserAttributes(context)`.
- 5f55dac: A failed federated sign-in shows the fixed `IdpErrorException` message `The identity provider '<id>' refused the sign-in.` instead of the identity provider's own error text. The provider's text goes to the server log.
- 5f55dac: `bb-auth migrate` moves `@aws-blocks/bb-auth-cognito/ui` imports to `@aws-cdk-blocks/bb-auth/ui` and renames their names to `Auth`'s, such as `cognitoOverrides` to `authOverrides`. It also follows `import * as blocks from 'aws-cdk-blocks'` and merges old imports that end up on the same module.
- 5f55dac: Under `npm run dev`, the local user pool keeps an email or phone unique, as Cognito does. `confirmSignUp`, `admin.createUser`, and `updateUserAttributes` can answer `AliasExistsException` when another account already has the email or phone.
- 5f55dac: Under `npm run dev`, `signUp`, `updateUserAttributes`, and `admin.createUser` check user attributes against your user pool's schema, as Amazon Cognito does. An undeclared attribute fails with `InvalidParameterException`, so declare a custom attribute in `users: { attributes: [{ name: 'team' }] }`.
- 5f55dac: Under `npm run dev`, confirming a sign-up verifies only the contact the code was sent to, as Amazon Cognito does. To verify the other one after sign-in, call `auth.sendUserAttributeVerificationCode(context, 'phone_number')` and `auth.confirmUserAttribute(context, 'phone_number', code)`.
- 5f55dac: `requireAuth().attributes` and `getCurrentUser().attributes` don't include `email_verified` or `phone_number_verified`, locally or on AWS. To check whether a user's email or phone number is verified, call `auth.getUserAttributes(context)`.
- ac4d4a1: `createOidcApi().getClient()` also sends `sessionCookieName`, the name of the session cookie this block's `/exchange` sets. A native client that signs out locally can remove only that block's cookie.
- 5f55dac: `Auth` rejects `emailPassword: false` combined with `passkeys`, `users.deviceTracking`, or `mfa` other than `'off'` when you construct it, in `npm run dev`, at synth, and in Lambda alike. `passkeys` without `users.authFlow: 'USER_AUTH'` is refused the same way.
- 5f55dac: Only the `Auth` block that owns a user pool's PreSignUp trigger answers it, so `validateUser` still runs when another block wraps the pool with `userPool: Auth.fromExisting(…)`. Two `Auth` blocks claiming one user pool's PreSignUp trigger fail `cdk synth`.
- 5f55dac: Adds `auth.protect`, which returns an `ApiNamespace` that is deny by default. It checks the session before any of its `methods` runs, and a signed-out call to a name that isn't a `public` method gets 401 `NotAuthenticatedException`.
- 5f55dac: The `Auth` README has a "Recipes" section of complete, compile-checked snippets for MFA with an authenticator app, roles, the first admin, and social sign-in. `@aws-cdk-blocks/bb-auth` ships its `API.md`.
- 5f55dac: `Auth` rejects options it doesn't recognise, so a misspelled or misplaced setting is never silently ignored. The constructor throws an error that names each unknown option's path and the likely intended one.
- 5f55dac: `relayOrigin()`'s `RelayConfigError` keeps its name when it crosses the wire, so `isBlocksError(e, 'RelayConfigError')` matches on the client. Sign-in failures from an identity provider never carry the provider's raw text.
- 5f55dac: Fixes made to `AuthCognito`, `AuthOIDC`, and `AuthBasic` since their last release ship in `Auth`. `Auth` has no `metrics` option, no per-username sign-in lockout, and no `additionalCallbackUrls` or `additionalLogoutUrls` options, and you import `AuthActionInput` from `aws-cdk-blocks`.
- 5f55dac: After `confirmResetPassword` succeeds, every session the user had is rejected with 401 `NotAuthenticatedException`. `updatePassword` and `auth.admin.setUserPassword` leave other sessions signed in, so call `auth.admin.revokeUserSessions(username)` to end them.
- 5f55dac: `Auth` accepts `redirectPath`, `redirects.postSignInPath`, and `redirects.postSignOutPath` only when the path resolves to your app's origin. The sign-in route answers an unsafe `redirectPath` with `400`, and an unsafe `postSignInPath` or `postSignOutPath` fails at construction.
- 5f55dac: `Auth` decides whether its cookies are `Secure` from deploy configuration, never from a request header. Cookies from `npm run sandbox` keep `Secure` even though the page is on `http://localhost`, and `npm run dev` drops it for its loopback requests.
- 1c7e0dd: Adds `isLocalDevRequest(ctx)` to `@aws-cdk-blocks/auth-common/cookies`, which is `true` only when the process itself is local and the request comes from a loopback origin. On deployed compute a request that sends `Origin: http://localhost` cannot drop `Secure` from the cookie.
- 5f55dac: `Auth` refreshes a session consistently when requests overlap, and a refresh that completes after `signOut()` no longer restores the session. `signOut()` reports the new `AuthErrors.SignOutIncomplete`, a 503 `SignOutIncompleteException`, when it can't delete the session row.
- 5f55dac: `signIn`, `confirmSignIn`, and `autoSignIn` return `SignInResult<O>`, whose `nextStep` carries only the steps the configuration can produce. An `auth.admin` call without `admin` in the options, or an `updateMfaPreference` factor that `mfa.types` leaves out, is a compile error that names its cause.
- 5f55dac: `signIn`, `confirmSignIn`, and `autoSignIn` fail with `InternalErrorException` naming the step when the user pool returns a step the block's options do not enable. In `npm run dev`, the local pool offers only the factors `mfa.types` lists.
- 5f55dac: The `stubIdp()` provider's authorize endpoint accepts only the stub's own `client_id` and a registered `redirect_uri`, and answers anything else with a `400` error page. Its token endpoint redeems an authorization code once, and a second redemption gets `400 invalid_grant`.
- 5f55dac: The `stubIdp()` provider serves an OIDC end-session endpoint at `/cdk-blocks/auth/idp/<id>/logout`. It redirects only to a registered `post_logout_redirect_uri`, and any other URI or an unknown `client_id` gets a `400` error.
- 5f55dac: `stubIdp()` runs in a sandbox deployment as well as in `npm run dev`, and anyone who can reach the sandbox can sign in as any of the stub's users. Restart `npm run sandbox` once after upgrading.
- 5f55dac: `AuthenticatedUser` has an optional `claims` field with the provider's verified claims for users of a `store: 'builtin'` block. Postgres RLS sees the identity provider's raw `sub` as `request.jwt.claims.sub` for those users, as it did with `AuthOIDC`.
- 5f55dac: With `validateUser` set on a pool `Auth` creates, a Cognito PreSignUp trigger runs it for every user Cognito is about to create, including users created outside your app. Cognito waits at most 5 seconds for the trigger, so keep `validateUser` fast.
- 5f55dac: `Auth` synthesizes when you vendorize it with `npm run vendorize -- Auth`. Synth bundles its deploy-time Lambda handlers from the vendorized source with your app's `esbuild`, and tells you to install it if it is missing.
- 5f55dac: Error messages sent to clients carry a fixed message for each error `name`, such as `Invalid parameter` for `InvalidParameterException`, instead of Amazon Cognito's raw text. The error `name`, HTTP status, and `retriable` are not affected, and Cognito's own text is written to the server log.
- 6eaa40c: Bedrock's Anthropic use case details refusal is reported as `AgentErrors.ModelUnavailable` when it arrives as `ResourceNotFoundException`, as it does from `ConverseStream` on a new account. It reached clients as `StreamFailed` before.
- b9ecc99: The README has a new "Password policy" section that covers `emailPassword.passwordPolicy`, each `PasswordPolicy` field and its default, and the `InvalidPasswordException` a client receives.
- 5f55dac: `getSdkIdentifiers(auth)` for an `Auth` block is typed with optional fields. An `Auth` with `store: 'builtin'` has no user pool and registers none of them, so code that reads `userPoolId` must check that it is defined.
- d46dfaf: A closed terminal or pipe no longer ends the CLI of AWS Blocks package tasks while its runner still works. The CLI drops `EPIPE` and `EIO` write errors.
- b2eb306: `npm run config -- remove KEY --help` shows help without removing the key. Deployment confirmations identify the effective credentials and warn when environment credentials override an exported profile.
- b2eb306: Lifecycle tasks validate options and query paths before they run, and keep structured results off stdout on failure. Use `npm run -s deploy -- --query apiUrl` for a clean result.
- b2eb306: Adds `npm run sandbox:preview`, which deploys a hosted preview once and prints its URL. Run `npm run -s sandbox:preview -- --query url` for the recorded URL.
- 184df0b: `npm run dev`, `sandbox`, `deploy`, and `generate client` run the backend with `cdk-blocks/tsconfig.json` when the app has one, so `jsx` or `paths` set there apply. They set `TSX_TSCONFIG_PATH` only when it is not set already.
- b2eb306: On Windows, Ctrl-C in `npm run dev` no longer prints `ps: unknown option -- A`. An installed `@aws-cdk-blocks/core` that does not match `aws-cdk-blocks` fails there with the `cannot load @aws-cdk-blocks/core …, which does not match it` error instead of a raw `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- d46dfaf: A SIGTERM to `npm run dev` waits for its runner's cleanup on procps-ng 3.3.10 too, as on CentOS 7 and Amazon Linux 2.
- a389add: `npm run dev` restarts a dev server that crashes after it started, with a backoff that starts at 500 ms and doubles up to 5 s. After 5 restarts within 60 s, the next crash ends `npm run dev` with exit code 1.
- b2eb306: A SIGTERM to the process group of `npm run dev` or `npm run sandbox` stops it cleanly. The dev server stops its frontend before it exits, so `next dev` or Vite no longer keeps running.
- d46dfaf: `npm run dev:stop` prints the message for a still-bound port on stderr instead of stdout. When another process holds the port, the message names that process, and `--output json` reports it under `stopped[].holders`.
- e098c7a: The JSDoc on each Building Block re-export points at the docs bundled in this package at `docs/<package>/README.md`, instead of a `node_modules` package directory.
- d46dfaf: Migration rewrites `package.json` before it removes unused wrappers, and reports each failed deletion with the wrapper path and error code. After you correct permissions, rerun migration with `--force` to remove leftovers.
- 94d5900: The production settings of `FileBucket` live in a `PRODUCTION.md` next to the block's `README.md`, which links to it. It covers access logging, KMS encryption, Object Lock, scaling, and cost.
- 5938d8b: CLI output names the project AWS CDK Blocks, including `create-blocks-app` progress and help text, the `blocks` CLI, and the first-run telemetry notice. The `.gitignore` section that `create-blocks-app` adds to an existing project is headed `# AWS CDK Blocks`.
- f133ff8: On the `apiFrontDoor: 'cloudfront'` tier, CloudFront routes a `container` API namespace straight to the container's load balancer, so a call can run up to 60 seconds instead of ~29. Those calls skip the gateway's throttling and access logs, and synth warns when the distribution has no web ACL.
- c1fabce: `deploy`, `destroy`, `startSandbox`, `destroySandbox`, and `startDevServer` read `BLOCKS_LOG_LEVEL`, which takes `quiet`, `normal`, `verbose`, or `debug`. `BLOCKS_LOG_STREAM=stderr` moves progress to stderr, so stdout keeps only the results.
- 41968b7: **Breaking: `AWS_BLOCKS_DISABLE_TEMPLATE_METADATA` is renamed to `CDK_BLOCKS_DISABLE_TEMPLATE_METADATA`.** The old name is no longer read, so update any script or CI job that sets it. `AWS_BLOCKS_FRAMEWORK_SINK` is renamed to `CDK_BLOCKS_FRAMEWORK_SINK`, which is internal and needs no action.
- d46dfaf: The dev server, `startSandbox`, `destroySandbox`, `deploy`, and `destroy` keep running when their output pipe or terminal closes, instead of crashing with `write EPIPE` or `write EIO`. Adds the exports `ignoreClosedOutput()` and `CLOSED_OUTPUT_CODES` to `@aws-cdk-blocks/core/scripts`.

- d46dfaf: **Breaking: a deploy no longer writes its AWS `apiUrl` to `.cdk-blocks-sandbox/config.json`, which only a dev server writes.**

  To upgrade:

  1. In scripts that read a deployed URL from `config.json`, read `config.sandbox.json` or `config.production.json`, or run `npm run -s sandbox:deploy -- --query apiUrl`.
  2. Run `npm run dev`, `npm run deploy`, `npm run sandbox:deploy`, or a destroy once, or set `BLOCKS_API_URL`, because the Node.js client refuses a `config.json` that still holds a deployed URL.

  The template e2e tests call the dev server unless you set `TEST_URL` to the URL a deployed app's API is under.

- d46dfaf: `destroy` and `sandbox destroy` stop at once when no AWS Region is set, or when the account or credentials can't be resolved, instead of retrying. Before the credential pre-check, `sandbox destroy` loads `.env.local`, so an `AWS_PROFILE` or `AWS_REGION` set there is the target that gets checked.
- d46dfaf: With `--host <address>` or `BLOCKS_DEV_HOST`, the dev server's banner, `config.json` `apiUrl`, realtime URL, and CORS use that address instead of localhost. Adds the export `devUrlHost(host)`.
- d46dfaf: Adds a `generateClient` setting for the dev server. Set `"generateClient": false` in `package.json#blocks.dev`, or pass `startDevServer({ generateClient: false })`, to keep an existing `cdk-blocks/client.js` instead of regenerating it at every start.
- d46dfaf: Stopping `npm run dev` no longer leaves `.cdk-blocks-sandbox/dev-server.<port>.pid` behind.
- d46dfaf: The dev-server pidfile no longer goes missing for a moment while `tsx watch` restarts the dev server, so `npm run dev:stop` at that moment finds the dev server.
- d46dfaf: The dev server no longer kills other processes that hold its port or frontend port, except a frontend left by this app's previous dev server. When anything else holds the port, it exits with code 1, so stop that process or choose another port with `--port` or `--frontend-port`.
- d46dfaf: A second `npm run dev` of the same app on another port exits 1, and `npm run sandbox` refuses while a dev session of the app runs. Stop the running server with `npm run dev:stop -- --port <port>`.
- d46dfaf: A second `npm run dev` on a port whose dev server already runs, or any failed start, prints the reason and exits with code 1 instead of hanging. When two dev servers start at the same moment on one port, exactly one runs and the other exits.
- d46dfaf: `npm run dev:stop` right after a backend edit stops the dev server. Before, it printed "nothing to stop" and left the server running.
- d46dfaf: `npm run dev:stop` stops a `npm run dev` that is still starting, and a second `npm run dev` on the port is refused at once. Adds the export `@aws-cdk-blocks/core/scripts/dev-pidfile`, and `StopResult.via` can be `cli`.
- d46dfaf: When another process holds the port, `dev stop` names it by pid and command, and `StopResult` has a new `holders` field. A pidfile that `dev stop` can't parse is removed, so `dev stop --all` stops listing its port.
- d46dfaf: A dev server bound to all interfaces with `--host 0.0.0.0` or `::` gives a browser the API at the address it opened the app on. It answers `/.blocks-sandbox/config.json` with the same-origin `apiUrl` `/cdk-blocks/api`.
- 384827f: The `@aws-cdk-blocks/core` README lists what a deployed `/.blocks-sandbox/config.json` holds, which is `apiUrl`, `__blocksBuildId`, and your `backendConfig`. It never holds the account, the stack name, or an ARN.
- 58daa51: The `RpcErrors` metric publishes to the `CDKBlocks` CloudWatch namespace instead of `AWSBlocks`. Update any alarm or dashboard on `AWSBlocks` / `RpcErrors` to `CDKBlocks` / `RpcErrors` after upgrading.
- 6151940: Each failed RPC call on Lambda writes the `CDKBlocks` / `RpcErrors` metric to CloudWatch, with the dimensions `FunctionName` and `StatusClass`. The error message is never written to the metric line.
- d46dfaf: `sandbox destroy` deletes the SSM parameter `/<sandbox stack>-db-url`, where the sandbox deploy stores a `*_DB_URL` or `*_CONNECTION_STRING` from `.env.local`. If SSM refuses the delete, it warns with the `aws ssm delete-parameter` command to run.
- d46dfaf: A failed sandbox deploy suggests destroying the sandbox only when the stack is left `*_FAILED` or `ROLLBACK_COMPLETE`, or its state can't be read. For other causes, the hint says what to do instead, such as to fix a synth error and re-run.
- d46dfaf: `npm run sandbox` and `sandbox deploy` work in a project path that contains a space, a quote, `$`, or `%`.
- 1ec956f: Test temp directories are created with `mkdtempSync`, so two tests that start in the same millisecond no longer share a path.
- 072c3ff: An unrecognized `encryption` value on `KVStore` or `FileBucket` fails the synth instead of emitting an `UnknownEncryption` warning and falling back to the AWS-managed key. If you hit the error, correct the value.
- 184df0b: The Vite templates check the browser and the backend as separate TypeScript projects, so a Node global in `src/` is a type error. To move an older app to this layout, see "Keep Node types out of the frontend" in `docs/guides/upgrading-older-apps.md`.
- 05a88e1: When AWS denies the credential check before `npm run deploy` or `npm run sandbox`, the warning says so and says whether an AWS Organizations policy denied the request. A credential failure message names the profile and the deployment Region.
- 3ae8592: `CronJob` takes the same `compute` and `timeoutSeconds` options as `AsyncJob`. Assign a container `Compute` to run a scheduled job longer than a serverless compute's 15-minute limit.
- f32185c: Adds the `blocks dashboard` command, which starts the Blocks Admin UI for the app on a free loopback port and opens it with a session token. `blocks dashboard doctor` prints a diagnostic report instead, and `@aws-cdk-blocks/admin-ui` is offered for install when the app does not have it.
- f32185c: Every deploy is recorded in `.blocks/deploy-history.jsonl`, with one `IN_PROGRESS` record when it starts and one terminal record with the same id when it ends. A history file that cannot be written never fails the deploy.
- 201e59e: The local dev server handles API and raw-route requests through the same dispatcher as deployed handlers, so cookie and error responses match. Handlers in local dev can read the request cookies, the client user agent, and `ctx.request.signal` through the request context.
- 5f55dac: The local dev server no longer exits on an unhandled promise rejection from request handling. It logs `[unhandled-rejection] <namespace.method>: <error>` with a hint about the missing `await` and keeps serving.
- 9d69412: The docs state that session cookies default to `SameSite=Lax`, that an `inferenceOnly` agent still creates its S3 session bucket, and that `objectLock` can be added to a deployed `FileBucket` as an in-place update.
- d01c34c: The docs state that a conditional KVStore `put` or `delete` is atomic for its item, with no transaction across items. They also cover what `withAuth` detects, the test helpers in `aws-cdk-blocks/utils`, and the dev server's error responses in `TROUBLESHOOTING.md`.
- d01c34c: Adds `docs/IMPORTS.md`, a generated reference that lists each app-facing entry of `aws-cdk-blocks`, where it runs, and every name it exports. For code that runs under the `browser` condition, it says where to import each root value instead.
- 5f55dac: Docs and editor hover text point at `Auth` instead of the removed `AuthBasic`, `AuthCognito`, and `AuthOIDC`. The `aws-cdk-blocks` README adds a "Choosing a sign-in method" table.
- 0ff1e1f: `VPC.md` and `VPC-DESIGN.md` describe the shipped VPC support without PR numbers.
- d01c34c: A new test checks the code samples of every doc shipped in `docs/` against the packages. The bb-auth README's frontend sample matches with `isBlocksError(e, 'NotAuthenticatedException')` from `aws-cdk-blocks/client` instead of importing `AuthErrors` from `aws-cdk-blocks`.
- 450e25f: `EmailClient` warns at synth when `fromAddress` is on a reserved domain that SES can never verify, such as `example.com` or anything under `.test`. The demo template's sender is an `EMAIL_SENDER` constant, which you replace with a verified SES identity before deploying to production.
- e8673cd: The docs and `UnsupportedCompute` errors state that `AsyncJob` and `CronJob` support Lambda and container delivery, while `Realtime` requires default Lambda compute. Omitting container concurrency allows five in-flight deliveries per job per instance, not one per vCPU, and the docs now say so.
- 8fb67ec: Deleting the newest stored version in a local FileBucket makes the next stored version the current body and metadata, or removes the current copies when none remain.
- f643a76: Return HTTP 404 for local presigned downloads of unknown or permanently deleted file versions instead of serving the current file's content.
- c6a59f4: The Next.js adapter accepts `@opennextjs/aws` 4.1.x without the out-of-range warning. An app that doesn't declare `@opennextjs/aws` builds with 4.1.14 instead of 4.0.3, and the build warns for `next` versions below `>=15.5.28 <16 || >=16.4.1`.
- 1e4d08d: The Hosting README states that behind a standalone ALB door with no certificate, `Auth` omits `Secure` from its same-origin session cookie, so the cookie travels in clear text. It recommends a certificate for anything beyond testing.
- e6c989d: `frontDoor: 'none'` always warns at synth with `@aws-cdk-blocks/hosting:PlainHttpFrontDoor`, including for a static site with no backend API. If `'none'` is intended, call `Annotations.of(stack).acknowledgeWarning('@aws-cdk-blocks/hosting:PlainHttpFrontDoor')`.
- 60360c1: `npm run destroy` and `npm run sandbox:destroy` reuse the frontend build output on disk instead of rebuilding. Set `BLOCKS_SKIP_FRONTEND_BUILD=1` to make a deploy reuse it too.

- dd1c554: **Breaking: the shared execution role's overflow managed policies get new logical IDs, `BlocksOverflowPolicy<hash>` instead of `...OverflowPolicyN`, and new generated names.**

  To upgrade:

  1. Update anything keyed on the old logical IDs, such as stack policies or template tests.
  2. If synth fails on the per-role managed policy quota and your account has an increased quota, set the `@aws-cdk-blocks/core:managedPoliciesPerRoleQuota` context, up to 25.
  3. Make a resource depend on the whole role instead of one specific grant, or use a separate role, when CloudFormation reports a circular dependency.

  For an app whose role already overflows, the first deploy after upgrading replaces each overflow policy, and creates the new one before it deletes the old one.

- 8ece10a: Synth also checks that a KMS key policy `Allow` statement for an AWS service principal carries `aws:SourceAccount` or `aws:SourceArn`. A key your app creates gets a warning, which you can acknowledge with the id `@aws-cdk-blocks/core:kmsKeyPolicyWithoutSourceCondition`.
- 287be20: `IngestionFailedException` from `isSynced()` and `waitUntilSynced()` has a fixed message, and Bedrock's `failureReasons` go to the server log and the error's `cause`. If your server code read the reasons from `err.message`, read `failureReasons` from `err.cause` instead, and treat it as optional.
- d1a473f: The `encryption` docstring states that the dedicated KMS key of a `'disposable'` table is scheduled for deletion with the table. Each public `KVStore` method has an `@example`, and the `LegacyKVStore` docs say what the class has.
- 92798e1: `KVStore` rejects calls that DynamoDB rejects, the same way locally and on AWS, with `KVStoreErrors.InvalidQuery` or `KVStoreErrors.ValidationFailed`. Code that matched DynamoDB's `ValidationException` should match the `KVStoreErrors` names instead.
- 92798e1: The local `KVStore` stores and returns copies of items, so changing an object after `put()` no longer changes what the next read returns. Values that DynamoDB can't store, such as an empty `Set`, a `Date`, or `NaN`, fail locally as they do on AWS.
- d8a86ee: The `LambdaCompute` README and design doc describe how the compute reaches an app, its options, and its VPC, CORS, tracing, and dashboard behavior.
- c607deb: Behind a Blocks CloudFront front door, a Lambda handler's `ctx.request.url` is the URL the client called, not the gateway's `execute-api` URL. `getRequestBaseUrl()` is unchanged, and each CloudFront door adds one CloudFront Function to the account.
- 836af43: Adds `LegacyKVStore`, a deprecated class that keeps the table of a `KVStore` from release 0.4.0 or earlier usable while you move its data to a new `KVStore`. The README section "Upgrade from release 0.4.0 or earlier" has the steps.
- 4e92168: On the Lambda functions AWS Blocks runs through `createLambdaHandler`, every `Logger` line carries `awsRequestId`, the invocation's request id. The field is reserved, so your context can't replace it, and block authors can read the id with `currentRequestId()` from `@aws-cdk-blocks/core/bb-utils`.
- c6a3357: Adds a repository check that every Building Block with both a local mock and an AWS runtime entry ships a `parity.test.ts` and calls its shared `validation.ts` from both entries.
- 8a5726c: Test-only change that checks `defaults.permissionsBoundary` coverage for Auth, Compute, ContainerCompute, CronJob, and Dashboard. No runtime or synth behavior changes.
- 8940cfd: Internal test fix for the legacy sandbox directory check. No change to the published package.
- 80ce128: `npm run sandbox` deploys infrastructure changes made while it watches, such as a new `Database` or `Realtime`. The watch passes `--hotswap-fallback`, so a code-only change still hotswaps and any other change runs a full deploy of the stack.
- 5f55dac: The scaffolded `AGENTS.md` says that a method is called as `<exported name>.<method>`, not by the second argument to `new ApiNamespace(…)`.
- 70ea280: `Secret` schema-validation errors no longer include the secret value. `get()` and `put()` throw `SecretErrors.ValidationFailed` with a fixed message, and the original issues stay on the error's non-enumerable `cause` for server-side logging.
- e286b16: The first-run telemetry notice lists what an event can include and never includes, says the collection endpoint receives your IP address, and names the opt-out, which is CDK's. What is collected and when has not changed.
- c00ab16: The first-run telemetry notice and the `aws-cdk-blocks` README say that the collection endpoint does not store your IP address, except in logs of requests that its firewall blocks. Events are kept for up to 1 year, and logs of all requests, blocked or not, for up to 10 years.
- 5f55dac: In the `demo` and `auth` templates, `updateTodo` copies only `completed`, `priority`, and `title` from the request, and new apps key per-user data on `user.userSub`. If you scaffolded an app from either template, make the same change to its `updateTodo`.
- 58980c7: `npm run sandbox:destroy` works on Windows. `sandbox` deploy, synth, and watch also work when the project path contains a space.

## 0.9.0

### Minor Changes

- 0765f84: Adds an optional fourth argument `{ compute }` to `ApiNamespace` that runs the namespace's methods on a `Compute` instead of the app's default compute. Only `serverless` computes can serve API namespaces, and the gateway still caps API calls at about 29 seconds.
- 5572341: Adds an `apiWaf` prop to `BlocksStack` and `BlocksBackend` that puts AWS WAF in front of the backend API, off by default. `{ enabled: true, rateLimit? }` creates a web ACL with a per-IP rate limit, and `{ webAclArn }` attaches a web ACL you already have.
- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.
- 1076ccc: Synth warns with id `blocks:apigateway:access-logging-disabled` on every durable stack with API Gateway access logging off, including the default `BlocksPresets.production`. With `--strict`, synth fails until you set `accessLogging: true` in the backend's `defaults` or acknowledge the warning.
- 928c48a: `cognitoFederated()` registers the deployed app's callback and sign-out URLs on the Cognito app client. URLs you added to the app client outside of CDK are replaced on the next deploy, so add them through `additionalCallbackUrls` and `additionalLogoutUrls`.

- 4d5ea86: **Breaking: `stubIdp()` providers work only in local development and sandbox deployments, and synth fails when a non-sandbox stack configures one.**

  To upgrade:

  1. Select providers by deployment type with the new `getDeploymentType()`, so that `stubIdp()` is used only for local and sandbox.
  2. Restart `npm run sandbox` once after upgrading, because the stub IdP routes return 404 until its full deploy runs.

- 1d58d60: Bedrock model-access refusals are reported as `AgentErrors.ModelUnavailable` with a message that explains what to do. `complete()` rejects with `ModelUnavailableException` instead of `StreamFailedException` for these failures and for health-check failures.

- 7114399: **Breaking: `Database` reports request errors as named 4xx errors instead of a generic 500 `QueryFailed`.**

  To upgrade:

  1. Where your code matched these failures with `isBlocksError(e, DatabaseErrors.QueryFailed)` or a 500 status, match `DatabaseErrors.PermissionDenied`, `DatabaseErrors.CheckViolation`, `DatabaseErrors.NotNullViolation`, or `DatabaseErrors.ForeignKeyViolation`.
  2. For `withRLS()` on PostgreSQL 16 and later, add `GRANT authenticated TO CURRENT_USER;` and the same for `anon` to your migrations.

  The new errors have the statuses 403, 400, 400, and 409 in that order.

- 92909f8: **Breaking: `withRLS({ userId, role, claims })` no longer lets `claims` override `sub` or `role` in `request.jwt.claims`.** If you relied on `claims.sub` or `claims.role`, pass the value as `userId` or `role`, or put it under a different claim name.
- 33edca2: `@aws-blocks/blocks/ui` re-exports `submitAuthAction`, so a custom auth UI can import it without reaching into `@aws-blocks/auth-common`.
- 48c35f6: Node clients resend a call once when the connection closes before the response headers arrive, which makes delivery at-least-once. Keep state-changing methods idempotent, or pass `retryStaleConnection: false` to `ApiNamespaceClient` or `generateClient` for at-most-once delivery.
- 9a32674: The shared config bucket `BlocksConfigBucket` sets `enforceSSL: true` and `versioned: true`, and every stack gets an additional bucket for its S3 server access logs. S3 can move a versioned bucket only to Suspended, never back to unversioned.
- 4553866: Adds `defaults.permissionsBoundary`, which attaches an IAM permissions boundary to every IAM role AWS Blocks creates. Every synth writes an IAM report to `cdk.out/<stack>.blocks-iam.json`.
- 48c35f6: Synth fails when a renamed or removed Building Block would let CloudFormation delete a stateful resource recorded in a baseline file under `aws-blocks/baselines/<stack>/`. Restore the block's old id or re-baseline with the block's re-baseline variable, and commit the baseline files with your app.
- e68e653: A retained `DistributedTable` keeps its global secondary indexes when you delete the stack or remove the table from the app. Upgrade and deploy a stack first, then delete it or remove a table or its `indexes` in a later deploy.

- 3142985: **Breaking: the deployed `EmailClient` validates addresses before calling SES, and the shared execution role is granted only `ses:SendEmail` and `ses:SendBulkEmail`.**

  To upgrade:

  1. Handle `InvalidInputException` from `send()`, and `failed` results from `sendBatch()`, for addresses that SES accepted but the validator rejects, such as quoted local parts or non-ASCII domains.
  2. If your app calls the SES SDK directly and relied on this block's grant of `ses:SendRawEmail`, `ses:SendTemplatedEmail`, or `ses:SendBulkTemplatedEmail`, grant those actions yourself.

  `sendBatch()` sends a message without `html` as plain text only, as `send()` already does.

- 9c96135: Adds `encryption` and `objectLock` options to `FileBucket`, and `BlocksDefaults.storageAccessLogging` for S3 server access logging on every `FileBucket`. With Object Lock, `putUrl()` and `createUploadHandle()` throw `FileBucketErrors.PresignedUploadUnsupported`, so upload with `put()`.
- ce5dfa9: Adds the `Compute` Building Block, `new Compute(scope, id, { type, ...options })`, where the type is `serverless` or `container`. `AsyncJob({ compute })` runs a job on a container on AWS Fargate, and Blocks provisions one shared VPC per backend for containers.
- 7477b6e: Adds `compute.type: 'web-function'`, which runs the SSR server on AWS Lambda Web Functions behind CloudFront with no API Gateway and no Lambda Web Adapter. Tune it with the `maxConcurrencyPerEnvironment`, `maxEnvironments`, and `rateLimit` fields of `compute.webFunction`.
- dd5e807: `blocks-generate-spec` writes `x-blocks-type-args` for an `oidc/client` result from the provider names the type checker infers. `AuthOIDC.createApi()`'s `getClient()` carries the configured provider names as a string enum, so native clients can generate a provider type.
- 8565ef7: Adds a `compute` option to `Scope`, which places everything created under it on one `Compute`, and to `CronJob`, serverless only. A `CronJob` or `AsyncJob` whose compute belongs to a different backend fails synth with an error naming the compute.
- 3d83cb6: **Breaking: a `Secret` is read-only at runtime by default, so it has no `put()` method and the execution role is not granted `PutSecretValue`.** Pass `allowRuntimeWrite: true` to each secret that your app writes at runtime.
- 82ea78a: A project config can no longer re-enable telemetry that a global config disabled. If you relied on that, re-enable globally with `npx blocks-telemetry --enable --global`.
- f704a68: Adds `StatusMessage` to `@aws-blocks/auth-common/ui`, re-exported from `@aws-blocks/blocks/ui`, a themed status line for loading, success, and error states. `StatusMessage(options?)` returns `{ element, set }`, so you mount `element` and call `set(kind, text)`.

### Patch Changes

- 5dc1d98: An `openai-api` model whose `endpoint` is a Bedrock Mantle URL and has no `apiKey` authenticates with the AWS credentials the agent runs with. `OPENAI_API_KEY` is not used for Mantle endpoints.
- 48c35f6: `Agent` reads and writes its session state under the session bucket's real name, which `FileBucket` shortens when the `fullId` is over 63 characters.
- 763f67e: AuthBasic invalidates a sign-up confirmation or password-reset code after 5 consecutive wrong guesses, and the user must request a fresh one. Every failed guess returns the same `InvalidCodeException`.
- aaa90b6: AuthBasic revokes the session at sign-out, so `requireAuth` rejects a replayed cookie with `AuthBasicErrors.SessionRevoked`. `signOut` throws `AuthBasicErrors.SignOutIncomplete` when the revocation write fails, and the next `cdk deploy` enables DynamoDB TimeToLive on the `codes` store in place.
- 72c8165: Adds the `lockout` option to AuthBasic, which locks an account for `lockoutSeconds` after `maxAttempts` consecutive failed sign-ins within `windowSeconds`. A locked sign-in fails with `AuthBasicErrors.AccountLocked` and status 429, and lockout is off unless you pass the option.
- ee69cd7: The docs say that `corsRules` is required for browser uploads and downloads. Without it, uploads and downloads that work under `npm run dev` fail after you deploy to a sandbox or production stack.
- e15fe58: `TROUBLESHOOTING.md` ships at the package root, so the README link to `./TROUBLESHOOTING.md` works on npm and in `node_modules/@aws-blocks/blocks/`.
- 943d405: Frontend code can import Building Block error constants, such as `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, `LoggingErrors`, and `RealtimeErrors`, to match errors with `isBlocksError`. `CronJobErrors.ScheduleNotSupported` is no longer `undefined` in the browser.
- 50b8c94: `npm run deploy` and `npm run sandbox` check that CDK has been bootstrapped in the target account and Region before they synthesize. If it has not, they stop with the command to run, `npx cdk bootstrap aws://<account-id>/<region> --app=`.
- 943d405: The `cdk` entry of `@aws-blocks/blocks` exports the types that were missing from it, such as `SubscribeOptions`, `RealtimeChannel`, and the `AuthCognito` admin types, so backend code that imports them type-checks.
- a3969b5: A Building Block runtime method called at the top level of a backend module throws `<Class>.<method>() cannot be called during CDK synth` instead of `TypeError: x is not a function`.
- 48c35f6: The `cdk` and `browser` entry points export the names they were missing, so importing them during `cdk synth` or in a browser bundle no longer fails. The `browser` entries add the error constants `AgentErrors`, `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, and `LoggingErrors`.
- 48c35f6: The Lambda handler routes Cognito user pool trigger events to the Building Block registered for that user pool under `EventSourceMapping.COGNITO_USER_POOL`. It rejects an event for a pool that no block handles.
- 48c35f6: An RPC error response passes a `Set-Cookie` through only when every browser would delete that cookie. A cookie with several `Expires` attributes, or one that is not a strict HTTP date, is no longer treated as a deletion.
- 8c73a24: `packages/core` declares `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` as devDependencies for its tests, with no change for apps.
- 48c35f6: An RPC error response no longer passes through a `Set-Cookie` whose `Max-Age` is malformed but could be read as a positive lifetime, such as `+999` or `999abc`.
- 48c35f6: `Scope.registerLambdaEventHandler()` throws when a handler is already registered for the same event source and identifier, instead of replacing the first one. A misconfigured app, such as two blocks consuming the same queue, gets an error naming the duplicate.
- 54e9443: A method typed from a resolved type keeps its `x-blocks-type-args`. Spec generation no longer fails with `found 0` type args for an arity-1 transferable reached that way.
- 48c35f6: An API error response forwards a `Set-Cookie` only when it has an integer `Max-Age` of `0` or less, or an `Expires` that is an IMF-fixdate at or before now. Values such as `Expires=0` no longer count as a deletion.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 48c35f6: `deploy()` in production mode no longer hangs after the deploy finishes. It no longer loads local mocks, so it does not apply migrations to, or write data into, your local `.bb-data/` database.
- d062eeb: `npm run deploy` and `npm run sandbox` print the deployment target before they deploy, with the credentials, the Region, the account name, and the AWS account plan. Account IDs, ARNs, error text, and plan credits are not printed.
- 48c35f6: `FileBucket` no longer fails `cdk synth` when its derived S3 bucket name is longer than 63 characters. It shortens such a name to the start of the name plus `-` and an 8-character hash, and names that already fit are unchanged.
- 63b154f: The typed RPC client POSTs to `/aws-blocks/api/{namespace}`, and the shared gateway routes each namespace to the compute that hosts it. Deploy the backend before clients built against it, pass the base URL in `ApiNamespaceClientOptions.url`, and make your own proxy forward `/aws-blocks/api/*`.
- 8565ef7: Synth errors for a compute that can't serve API namespaces, or for an export name API Gateway can't route, give the compute's full construct path, for example `MyStack/app/reports/backing`.
- dde6340: Adds the `frontDoor` prop to `Hosting`, which picks CloudFront, an Application Load Balancer, Amazon API Gateway, a stacked door, no door, or your own door built with `defineFrontDoor`. The top-level settings props are deprecated but still supported, so move each to `frontDoor.features.<x>`.
- f8bfab1: With an ISR or SWR route rule that names a folder in `public/`, pages under that folder that render on demand go to the server instead of returning 404. `RouteBehavior` has a new optional `exact` field that keeps a route in its own row of the front door's route table.
- 3ae22e6: The Next.js adapter builds with `@opennextjs/aws@4.0.3` when the app does not declare `@opennextjs/aws`, and warns when the app's `next` version is outside OpenNext's peer range. Run `npm install --save-dev @opennextjs/aws@~4.0.3` to declare it.
- 48c35f6: Scripts that use a local `Database` or `DistributedDatabase` exit when they finish instead of running forever. The local engine shuts down cleanly, so the next start no longer logs `Removed stale postmaster.pid`.
- d366907: Closing a local Database or DistributedData engine before its first query no longer hangs with PGlite 0.5.10.
- 48c35f6: An API method that throws can clear cookies in the same response, and any other cookie set before the throw is still dropped. Multiple `Set-Cookie` values are delivered on API Gateway HTTP API and Function URL events.
- 48c35f6: Every `Set-Cookie` value that an `ApiNamespace` method sets in one response is delivered on AWS. Before, only one cookie reached the browser.
- 72e3259: `npm run sandbox` no longer prints a DEP0190 deprecation warning on Node 24.
- b16e5b6: Every deployable template has an `npm run sandbox:deploy` script that deploys once and exits. In an existing app, pass `deployOnly: process.argv.includes('--deploy-only')` to `startSandbox({ ... })` and add the script `"sandbox:deploy": "tsx aws-blocks/scripts/sandbox.ts --deploy-only"`.
- 48c35f6: `npm run sandbox` telemetry reports which Building Blocks your app uses when telemetry is enabled. The sandbox generates the deployed client before deploying, so an error in the backend surfaces before the deploy.
- 0d4ede3: `bb-kv-store` and `bb-distributed-table` share one internal helper in `@aws-blocks/core` for point-in-time-recovery and encryption resolution. The synth output is unchanged.
- 63b154f: The `@aws-blocks/core` README has a new "Shared API gateway" section, and the `bb-lambda-compute` design notes describe the multi-compute routing.
- b6b8ade: The native-client spec generator reads the `ApiNamespace` handler argument itself, whatever follows it. A namespace with an options object after the handler no longer gets `unknown` types in the Swift, Kotlin, and Dart bindings.
- 48c35f6: Vendorized apps that use `DistributedTable` with an index, `Database` with migrations, or `DistributedDatabase` synthesize instead of failing with `Cannot find asset` or `Cannot find entry file`.

## 0.8.0

### Minor Changes

- ec7eebe: Adds the `Secret` Building Block, `@aws-blocks/bb-secret`, which stores one application secret in AWS Secrets Manager with `get()`, `put()`, `listVersions()`, and `Secret.fromExisting(arn)`. A new secret is empty, so `get()` returns `null` until a value is set, unless you pass `generate: true`.

- 8f725b6: **Breaking: `Database` retains automated backups for 15 days and exports the PostgreSQL engine log to CloudWatch Logs, so existing stacks show a CloudFormation diff.**

  To upgrade:

  1. Review the diff and snapshot before deploying.
  2. To encrypt storage, set the `@aws-blocks/bb-data:encryptStorageByDefault` context flag, as the new `cdk.json` templates do, or pass `storageEncryptionKeyArn`.
  3. On an already-provisioned cluster, first snapshot it, restore it with encryption enabled, then cut over.

  Turning encryption on or off for a deployed cluster replaces it with a new, empty cluster that has no schema.

- 4ae500e: Adds a `dev:stop` npm script to every standalone template, so `npm run dev:stop` stops the local dev server. `@aws-blocks/core/scripts` exports `stopDevServer`, `runStopCli`, `stopMessage`, and the `StopResult` type.
- 6d764f7: `AWS_BLOCKS_DISABLE_TELEMETRY` accepts `true` and `yes` in addition to `1`, case-insensitive and trimmed. If you already export `AWS_BLOCKS_DISABLE_TELEMETRY=true` or `=yes` for another tool, Blocks telemetry is disabled where it was still on before.
- 94a914a: Spec generation rejects a native package's Dart `name` or `library`, or a binding's `export`, that would break codegen, such as `My-Package`, `lib/x.dart`, or `device link`. A Dart `name` of `blocks_runtime` is also rejected.
- cb0ec01: `blocks.spec.json` can carry two top-level OpenRPC extensions, `x-blocks-native-packages` and `x-blocks-native-bindings`, for native codegen. `generateSpec` and `writeSpec` take a new trailing `SpecGenerationOptions`, and invalid metadata throws `NativeCatalogError`.
- 005c095: `blocks-generate-spec` reads the `aws-blocks.native` key in each installed block's `package.json` and emits the `x-blocks-native-packages` and `x-blocks-native-bindings` catalogs. It exits non-zero without writing a file when a block's declarations are invalid.

- 66f4be2: **Breaking: `BlocksStack.handler`, `BlocksBackend.handler`, and `Scope.handler` are removed.**

  To upgrade:

  1. Replace `blocksStack.handler.addEnvironment('KEY', value)` with `registerConfig(blocksStack, 'KEY', value)`.
  2. Replace `resource.grantRead(blocksStack.handler)` with `resource.grantRead(blocksStack.executionRole)`.
  3. Replace `blocksStack.handler.addToRolePolicy(statement)` with `blocksStack.executionRole.addToPrincipalPolicy(statement)`.
  4. In a custom Building Block, replace `this.handler` with `this.executionRole` or `registerConfig(this, …)`.
  5. Replace `handler.addEnvironment('CORS_ALLOWED_ORIGINS', …)` with `defaults: { ...BlocksPresets.production, allowedOrigins: [...] }`.

  A real environment variable of the same name wins over a `registerConfig` entry, where the last `addEnvironment` call won before.

- 122c49c: **Breaking: an opted-out run with `--telemetry-file` writes no identifiers, prints no notice, writes no file, and sends no HTTP.** To capture events without sending them, use `BLOCKS_TELEMETRY_ENDPOINT=http://127.0.0.1:1 <cmd> --telemetry-file=<path>` instead of combining the flag with `AWS_BLOCKS_DISABLE_TELEMETRY`. That run is consented, so it still writes the installation ID and prints the notice.
- 8ca3692: Adds a `ui-theme` design-token layer with a light and dark palette, used by the shared Auth components and the `create-blocks-app` templates. `@aws-blocks/blocks/ui` exports `injectTheme`, `THEME_CSS`, and `THEME_STYLE_ID`, and the new `@aws-blocks/blocks/theme` subpath exports only the token layer.

### Patch Changes

- f8fbc6e: When a deployed `Agent`'s session snapshot cannot be read for a reason other than a missing object, `runAgent` logs the cause's `name`, `httpStatusCode`, and `requestId` at `error` level. The read still fails instead of starting a fresh conversation.
- 59c9dde: The `bb-auth-basic` README shows how to mount the login UI with `Authenticator` and `AuthenticatedContent` from `@aws-blocks/blocks/ui` and gate the app shell behind an authenticated session.
- e682ba7: `LambdaCompute` reports `bbName`/`bbVersion` to `Scope`, so the default compute appears in telemetry like every other Building Block.
- e9241b5: Adds integration tests for the shared REST API gateway wiring through `LambdaCompute`, with no runtime or public API change.
- 3a7eb9e: The `cdk` entry points export the runtime values they were missing, such as `InterruptError` in `@aws-blocks/bb-agent` and `BatchSubmitFailedError` in `@aws-blocks/bb-async-job`. Importing them in a backend file no longer crashes `cdk synth`.
- 78f4396: CORS guidance points at the stack's `defaults.allowedOrigins`. The runtime warning for a disallowed origin says to add it to `defaults.allowedOrigins` instead of setting the `CORS_ALLOWED_ORIGINS` environment variable.
- 440ecce: When the AWS credential check before `npm run deploy` and `npm run sandbox` fails, the message names the profile and the command that fixes its credentials. `@aws-blocks/core` requires AWS SDK for JavaScript clients 3.936.0 or later.
- 92fa27b: Internal refactor that creates named errors through `@aws-blocks/core`'s `blocksError`. No behavior change.
- 023f02c: An internal refactor routes the remaining per-package errors through core's `blocksError`. Two realtime timeout rejections that were unbranded are now wire-safe.
- 5d6656a: Adds the `apiFrontDoor` prop, and `publicApiUrl` on `BlocksStack` and `BlocksBackend` for the URL clients should call. Setting `apiFrontDoor: "cloudfront"` puts a CloudFront distribution in front of the API, and switching tiers changes the API's endpoint domain and signs every user out.
- 8b5ef4a: The hosting SSR `RestApi` sets `cloudWatchRole: false`, so `cdk destroy` no longer leaves an unused IAM role behind. Before you delete a previously retained role by hand, run `aws apigateway get-account` and check that `cloudwatchRoleArn` does not point at it.
- 382dac6: The image-optimization Lambda no longer follows redirects on remote image fetches, so a 3xx fails the image request. If an allowlisted image host serves its images through a redirect, allowlist the final location instead.
- c6d9e49: With `dangerouslyAllowSVG` / `IMAGE_ALLOW_SVG` off, the image-optimization Lambda rejects SVG content with a `415` by checking the image bytes, not the file extension. An SVG served from `/logo` or `/logo.png` no longer passes the gate.
- 8a1a4a9: Test-only change that covers npm's `ci/<vendor>` user-agent token in the shared `isCI()` case table.
- 2be3318: Test-only change. The `bb-knowledge-base` CDK test stub grants through the shared `executionRole` like the Building Block does.
- 38ce80c: `npm run dev` listens on `127.0.0.1` instead of every interface, and the local realtime WebSocket rejects a client-sent `publish` and checks `Origin`. For a container or remote devbox, set `BLOCKS_DEV_HOST=0.0.0.0`, and publish from the server with `Realtime.publish()`.
- fd10117: `cognitoFederated()` no longer fails at `cdk synth` with `CannotFindAsset`. The published `@aws-blocks/bb-auth-oidc` package ships the bundled Lambda at `dist/idp-registration-lambda/index.js` again.
- 03ce866: The local dev server stays alive when a PGlite init failure aborts the migrations that a `Database` or `DistributedDatabase` with `migrationsPath` runs in its constructor. A query after a failed init throws `QueryFailedException`, and the next query runs the migrations again.
- 2da2fd4: A RawRoute whose handler throws an uncaught exception returns a generic `500` with `"Internal error"` instead of the error's raw name and message. A Building Block error or `ApiError` keeps its name and message, and the full error is still logged server-side.
- 30fc4c2: Use `dsql-lint` for local and synth-time Aurora DSQL compatibility checks, allow foreign keys, and refresh the PostgreSQL compatibility guidance.
- 32a4b73: `AuthOIDC` is reported as the parent block of its session store, and `core` adds the `computeScopeFullId` and `buildingBlockParent` exports. In local and other non-Lambda runs the session cookie name changes, for example to `oidc_my-app-auth`, so existing sessions there are signed out once.
- da6d4c7: **Breaking: shared Blocks resources are scoped to the `BlocksStack` or `BlocksBackend` instead of the enclosing `cdk.Stack`.** An app that embeds a `BlocksBackend` inside a customer `cdk.Stack` and uses realtime or cron sees those resources replaced on upgrade. For realtime, the WebSocket API URL changes and the stack output key changes from `RealtimeWsUrl` to `BlocksRealtimeWsUrl<hash>`, so update scripts that read that output by name. Single-`BlocksStack` apps see no resource replacement.
- ec7eebe: The docs recommend `Secret` for any credential that protects a production app, and describe `AppSetting` with `secret: true` as a free, encrypted fallback for a low-value secret.
- f1eb149: `--telemetry-file` keeps every event of a run instead of only the first, appended to the same JSON array. Update anything that asserts the file holds exactly one event.
- 7c19c4f: Adds an opt-in `--wait-live` flag to `npm run deploy`. With it, the deploy prints `BLOCKS_DEPLOYED` only once the new build is served, and exits non-zero if that is not confirmed within `--wait-live-timeout=<seconds>`, default 180.

## 0.7.0

### Minor Changes

- 20be3f0: `KVStore` honors `defaults.pointInTimeRecovery` and defaults to the `aws/dynamodb` KMS key instead of the AWS-owned key, so the next deploy updates tables in place and adds charges. Remove `removalPolicy`, `deletionProtection`, and `ttl` from `fromExisting()` calls, or `cdk synth --strict` fails.

### Patch Changes

- 8da1d1f: Adds `createChat({ transport, api })` and `realtimeTransport(...)`, a client streaming API that keeps the same frontend code across runtimes. The `useChat` client hook is marked `@deprecated`, superseded by `createChat`.
- 773cef2: The Astro adapter accepts an empty or absent `dist/client` for a pure-SSR build instead of throwing `AstroBuildOutputMissingError`. It requires only `dist/server/entry.mjs`.
- ea5f91c: The confirm-signup and confirm-reset forms of `AuthBasic` carry the username in a hidden, prefilled field, so the user no longer retypes it.
- 2e72825: `requireRole` reads group membership live instead of from the `cognito:groups` token claim, so admin group changes take effect without a re-login.
- 4456fd7: The auth READMEs document the full `AuthState` shape returned by `getAuthState()`/`setAuthState()`. `bb-auth-cognito` and `bb-auth-oidc` consumers import the type from `@aws-blocks/auth-common`.
- 39628cb: Each `CORS_ALLOWED_ORIGINS` entry matches the whole origin, so `^https://app\.example\.com` no longer matches `https://app.example.com:8443`. If you relied on prefix matching, append `(:\d+)?` or `.*` to the entry, and set `CORS_HOSTING_ORIGINS` to a raw, unescaped origin.
- d4b32f2: `@aws-blocks/create-block` ships `README.md` and `DESIGN.md` in the published package.
- a649895: A successful `npm run deploy` or `npm run sandbox` prints one stable last line, `BLOCKS_DEPLOYED url=<frontend> api=<backend>`, that a script can grep. For a backend-only app and for `npm run sandbox`, the line omits `url=`.
- 251aed2: On AWS, `get()` returns `null` and `delete()` is a no-op for an unknown `versionId`, as in the mock. `restoreVersion()` throws the new `FileBucketErrors.VersionNotFound`.
- 6b7fe4c: A stack delete completes instead of hanging on the `IsrTagTableSeed` custom resource and failing with `DELETE_FAILED`.
- dae7a86: Synth emits a deprecation warning when a compute resource pins `nodejs18.x` or `nodejs20.x`. Use `nodejs22.x` or `nodejs24.x`, or omit the runtime to use the default.
- 5454763: On AWS, `delete(key, { ifValueEquals: undefined })` no longer fails with a marshalling error, and `delete()` applies both `ifExists` and `ifValueEquals` when both are set. Both cases match the mock.
- a23b8d8: **Breaking: a plain `Error` thrown from an API method reaches the client as a generic `500` with `"Internal error"` instead of its raw message.** To send a specific status, name, and message to the client, throw an `ApiError`, for example `new ApiError("Todo not found", 404, { name: "TodoNotFoundException" })`. Building Block errors keep their name and message on the wire.
- 7b7a59f: The EventBridge Scheduler role's trust policy is limited to schedules in the stack's account and region. Hosting removes a redundant CloudFront `kms:Decrypt` statement from the SSE-KMS key policy.
- 465a002: Telemetry uses ci-info for CI detection, so Taskcluster, Netlify, Vercel, and 40+ other CI providers are identified. It honors `CI=false`.
- e57da06: Report bbName/bbVersion in telemetry.

## 0.6.0

### Minor Changes

- d7312f9: **Breaking: logging, tracing, and the dashboard are driven by each compute, and `Logger` drops its `retention` option and the `LOG_LEVEL` environment variable.**

  To upgrade:

  1. Replace the `retention` option of `LoggingOptions` with the `logRetention` prop on `LambdaCompute`, which falls back to `defaults.logRetention`.
  2. Set the log level with the `level` option of each `Logger`, which defaults to `'info'`, instead of the `LOG_LEVEL` environment variable.
  3. Remove uses of the `LoggerBBRef` and `TracerBBRef` dashboard types.

  Creating any `Tracer` in the app enables X-Ray on every compute, and `DashboardOptions` gains the `logs` and `traces` display toggles.

### Patch Changes

- 7b86b8e: `cognitoFederated()` registers the identity provider with a deploy-time custom resource, so the stack deploys instead of failing at change-set creation. `@aws-blocks/bb-app-setting` exports `SECRETS_BULK_CONSTRUCT_ID`, the construct id of the shared per-stack secret-init custom resource.
- 4342149: `bb-dashboard` declares its `@aws-blocks/bb-lambda-compute` devDependency as `^0.4.0`, with no runtime or API change.
- e2c3c62: `DistributedDatabase` re-issues the DSQL role grant during a deploy that replaces the app's IAM role. Before, every query failed with SQLSTATE `28000` after the role was replaced, as happens when an upgrade of `@aws-blocks/core` moves the app to the shared `BlocksRole`.
- f552ebe: `blocks-generate-spec` keeps the parameter and result schemas of an `ApiNamespace` that is built in a factory, destructured, and then exported, such as `const { api } = new Factory().build()`.
- 9aa0814: `blocks-generate-spec` keeps the schemas of two `ApiNamespace`s apart when they share a method name, such as `widgets.create` and `subscriptions.create`. Before, one overwrote the other in the generated OpenRPC document.
- 81609a8: `KVStore.put` accepts `ifNotExists` and `ifValueEquals` together. The write succeeds when the key is absent or its current value matches.
- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.
- 21443ba: Optimistic-concurrency and conditional-write conflicts reach clients as JSON-RPC error code 409 instead of 500. Code that matches conflicts by name with `isBlocksError` is unaffected, but code that branched on `error.status === 500` now sees `409`.
- acd1628: A RawRoute registered through one copy of `@aws-blocks/core` is dispatched by a duplicate copy instead of silently returning 404. Unmatched routes log a diagnostic, and a duplicate core copy warns once.
- 6496713: Replaces `registerVpcEndpoint` with `registerVpcGatewayEndpoint` and `registerVpcInterfaceEndpoint`, and reduces `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`.
- bd67438: `stubIdp()` takes an optional `users?: StubUser[]` to declare test users inline. Inline `users` take precedence over `users.json` and the built-in default.
- a47d71c: A duplicate-key violation in `@aws-blocks/bb-data` or `@aws-blocks/bb-distributed-data` reaches clients as JSON-RPC error code 409 instead of 500. If your code checks `error.status === 500` for these conflicts, check for `409` or match by name with `isBlocksError`.
- 0385f7e: `UseChatOptions.api.sendMessage` and `resume` are typed to return `Promise<unknown>` instead of `Promise<void>`, so you can pass a backend method that returns an object without a wrapper.
- daf523a: The `useChat` docs have a React example that holds the instance in a `useRef` and cleans up with `chat.destroy()` on unmount.
- 6496713: `Database` in a bring-your-own VPC places its Aurora cluster in the isolated subnets when the VPC has them, and in `PRIVATE_WITH_EGRESS` subnets otherwise. Synth no longer fails with "no isolated subnet groups in this VPC".
- 6496713: A Building Block passes its VPC requirements to the `BuildingBlockScope` constructor, and Blocks creates one shared VPC when a block declares `requiresVpc: true` and you bring none. `Database` accepts an optional `subnets` placement for its Aurora cluster.
- 6496713: Interface endpoints accept 443 only from the Blocks Lambda SG instead of the whole VPC CIDR. Replaces `VpcRequirements.subnetRole` with `requiresEgress`, and synth fails with a clear error when the runtime's placement has no egress or the VPC lacks a requested subnet tier.
- 6496713: Replaces `VpcRequirements.runtimeSubnet` with `requiresEgress?: boolean`. The SSM interface endpoint is provisioned only when a Building Block needs it, and the S3 gateway endpoint is always provisioned.
- 302090a: The local dev server no longer crashes when a WebSocket client resets its connection during the upgrade.

## 0.5.0

### Minor Changes

- 9111c0c: Adds `maxLlmCalls` and `maxToolIterations` to `AgentConfig`, which cap model and tool calls per turn and both default to `20`. A turn over a cap is cancelled with an `error` chunk, so raise the cap or set it to `false` for agents that need more.

- c45eb92: **Breaking: `BlocksDefaults` gains three required fields, `logRetention`, `throttling`, and `accessLogging`, and the presets now throttle the API stages and replace the shared handler Lambda log group.**

  To upgrade:

  1. Add the three fields to any hand-written literal `BlocksDefaults` object, which is not needed when you spread a `BlocksPresets` preset.
  2. If your app serves above 1000 rps / 2000 burst in production, raise the limit with `defaults: { ...BlocksPresets.production, throttling: { rateLimit, burstLimit } }`.
  3. Delete the old `/aws/lambda/<fn>` log group manually if you want its history gone.

  Sandbox is capped at 200 rps / 400 burst, and Blocks-managed log groups keep events for `ONE_WEEK` in sandbox and `ONE_YEAR` in production.

- 4a830a6: AsyncJob, CronJob, and Realtime attach their resources to a compute resolved at synth, and fail synth with an `UnsupportedCompute` error on anything but a Lambda compute. `@aws-blocks/core` exports `blocksError(name, message)` and `sanitizeConfigKey(id)`.
- f2f186c: The `DeleteOldBuilds` lifecycle rule expires only superseded builds after `buildRetentionDays`, never the build that is currently served. `buildRetentionDays` is now configurable from `@aws-blocks/core`.
- 46b7c89: Adds a `blocks-generate-client` bin to `@aws-blocks/blocks` that generates the local `aws-blocks` package's client entry point. The templates run it as `"prebuild": "blocks-generate-client"`, so a fresh checkout resolves the package and `cdk synth` no longer fails.
- 2cb9d74: **Breaking: `structuredOutput` is removed from `AgentConfig`.** The field never did anything, so delete it from your configuration.

### Patch Changes

- fe0f04a: Removes `jobQueueUrl` from the `Agent` `getSdkIdentifiers` overload, because the field resolved to `undefined` at runtime. The overload returns `conversationsTableName`, `messagesTableName`, `sessionBucketName`, `realtimeWsUrl`, and `realtimeCallbackUrl`.
- 585feea: Document AuthCognito setAuthState error-state semantics, including retriable challenge failures and CodeMismatch handling.
- 64ddd74: An internal refactor makes `finalizeConfigRegistry` grant `s3:GetObject` on the config object to the shared execution role and set `BLOCKS_CONFIG_BUCKET` and `BLOCKS_CONFIG_KEY` on every compute.
- 165093b: `CronJob` validates the schedule and timezone at synth and throws `CronJobErrors.InvalidSchedule` or `CronJobErrors.InvalidTimezone` before any infrastructure is created. The local mock throws the new `CronJobErrors.ScheduleNotSupported` for valid `cron(...)` forms it cannot simulate.
- 8de4a56: The `DistributedTable` mock orders items that share a GSI sort key by the base-table primary key, matching DynamoDB, instead of by insertion order.

## 0.4.0

### Minor Changes

- 08ab129: Adds `pointInTimeRecovery: boolean | { retentionDays: number }` to `BlocksDefaults` and `BlocksPresets`. The preset value is `true` in `production` and `false` in `sandbox`.

### Patch Changes

- 1ff9d03: Adds `kmsKeyArn` to `AppSetting` and `AppSetting.fromExisting` to encrypt a secret with a customer-managed KMS key instead of the default `aws/ssm` key. `kmsKeyArn` is only valid with `secret: true` and must be a non-empty ARN.
- 5798492: `AsyncJob` batches SQS messages with a default `batchSize: 10`, up from `batchSize: 1`, and a new `maxBatchingWindowSeconds` option with a default of 5. Set `batchSize: 1` and `maxBatchingWindowSeconds: 0` to opt out.
- ca8cfb6: `submitBatch` accepts up to 10,000 payloads and splits them into SQS requests, where it rejected more than 10 with `BatchTooLarge` before. A batch that spans several chunks is not atomic, and the `BatchSubmitFailed` error carries `.jobIds` and `.failed[]` so you can retry only the failed indexes.

- f00adb0: **Breaking: the Lambda function and API Gateway move under the default compute, so a redeploy replaces them and the API URL changes.**

  To upgrade:

  1. Before you upgrade, confirm that anything wired to the current API Gateway URL, such as an Amplify Gen2 frontend, can absorb a URL change.
  2. If you call `BlocksStack.create()` or `BlocksBackend.create()` from `@aws-blocks/core` directly, import `BlocksStack` from `@aws-blocks/blocks/cdk` instead, or pass a `defaultComputeFactory` on the props.

  Apps built on `@aws-blocks/blocks` need no code change, and the new `Scope.compute` getter resolves the compute a block runs on.

- de4f209: `KnowledgeBase.retrieve` rejects a fractional or non-finite `maxResults` with `KnowledgeBaseErrors.ValidationError` in both the mock and AWS runtimes, before any search or Bedrock request.
- f00adb0: `LambdaCompute` defaults the function to `arm64` instead of `x86_64`, so the next deploy updates the handler function's architecture in place. There is no per-app override yet, so check any x86-only native dependency that your backend bundles.
- 27346f3: AuthOIDC `requireAuth()` throws `ApiError(401, NotAuthenticatedException)`, so the documented `handle401()` redirect pattern works for a signed-out protected call. Before, the client received a `500`.
- 5bfae0a: `parseRpcRequest` caps a JSON-RPC request body at 10 MiB and returns a `413` error named `PayloadTooLarge`. The local dev server rejects the same oversized body that API Gateway rejects in production.
- 0ac3879: `sandbox` and `deploy` check AWS credentials before the synth and exit with guidance when they are missing, expired, or invalid. A network or service error only warns, and the check is skipped with a warning when no region is set in `AWS_REGION` or `AWS_DEFAULT_REGION`.

## 0.3.1

### Patch Changes

- 448a47c: `@aws-blocks/bb-lambda-compute` gains package metadata and a `prebuild` version script, and depends on `@aws-blocks/core` `^0.2.0` instead of `*`. `@aws-blocks/blocks` depends on `@aws-blocks/bb-lambda-compute` `^0.2.0` instead of `*`.

## 0.3.0

### Minor Changes

- 7b4c62d: **Breaking: `BlocksStack.create` and `BlocksBackend.create` require a `defaults` field.** Pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`, which replaces the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin. A per-block option still wins over `defaults`. The experimental `hardening` prop is removed with its `resolve*` helpers.

### Patch Changes

- 6df9e2d: `bb-data` and `bb-distributed-data` declare the `data-common` TypeScript project reference, so build order comes from the project-reference graph. The published packages are unchanged.
- 3614a09: The handler bundling shims `import.meta.url`, `import.meta.dirname`, and `import.meta.filename`, so `fileURLToPath(import.meta.url)` no longer crashes the deployed Lambda at load. Inside the bundle these resolve to the bundled output location, not your source tree.
- edbf1aa: The ingestion custom resource sets `installLatestAwsSdk: false`, which removes roughly 15-30s of cold start from the provider Lambda. Expect one ingestion job to start on the first deploy after upgrading.
- 5262062: `LambdaCompute` moves into a new package, `@aws-blocks/bb-lambda-compute`. The package is CDK-only and its sole export is internal, so customers cannot instantiate a compute yet.
- bfb9a63: The PGlite init-retry helper in `data-common` retries only on specific WASM-trap signatures, including memory-pressure aborts such as `Aborted(OOM)`. Its four init-retry exports are marked `@internal`.
- e4b1498: `PGliteEngine` and `DsqlMockEngine` retry PGlite's WASM initialization on the intermittent `_pg_initdb` `unreachable` trap, so the dev server recovers instead of crashing.
- 8966cfb: Telemetry reports runs on Render and Taskcluster as `ci:true`, detected from `RENDER` and `TASKCLUSTER_ROOT_URL`.

## 0.2.7

### Patch Changes

- 1e37c67: `@aws-blocks/blocks` ships one docs folder per Building Block under `docs/<block>/` and a Building Block catalog in the package README. The scaffolded `AGENTS.md` tells agents to locate docs with `require.resolve('@aws-blocks/blocks/docs/<block>/README.md')`.

## 0.2.6

### Patch Changes

- 75f5446: Add optional `fallback` parameter to `AuthenticatedContent` for rendering alternative content when the user is not authenticated.
- 2ed4177: Adds stable `data-testid` hooks to the auth UI components, so e2e suites can target the shipped `Authenticator` instead of forking it. CUSTOMIZING-AUTH-UI.md documents the full selector contract.
- 5b2aede: `DistributedTable` reads apply the schema through a new `readValidation` option, whose default `'coerce'` fills defaults and narrows types without dropping data. Pass `readValidation: 'off'` to restore raw reads.
- feb5be4: Re-exports the `auth.admin` types `AdminOptions`, `AdminUser`, `AdminCreateInit`, `GroupAdmin`, `LifecycleAdmin`, `AdminSurface`, `AdminGetterOf`, and `AdminDisabled` from `@aws-blocks/blocks`.
- 9de27dd: `npm run deploy` streams CloudFormation progress to stdout, and a single SIGTERM or any SIGHUP no longer ends a deploy in progress. The `Deployment failed.` banner moved from stderr to stdout, so anything that greps stderr for it no longer matches.
- 58f77dd: The docs cover runtime config resolution, `RawRoute`, server-initiated OIDC sign-in, and error and RPC semantics.
- b83aaba: Adds opt-in TTL to `KVStore` with the `ttl` construct option and `put(key, value, { ttlSeconds })` or `{ expiresAt }`. `AuthCognito` uses it for session records, so your next `cdk deploy` enables TTL on the existing sessions table, and only sessions written after the upgrade expire.
- f583c75: Adds opt-in job status tracking to `AsyncJob`. Pass `trackStatus: true`, which provisions one DynamoDB table with a 24 hour TTL, then read a job's states with `getStatus(jobId)` and `waitUntilComplete(jobId, options?)`.
- 3c56267: `AuthBasic` and `Logger` report `bbName`/`bbVersion` to `Scope`, so telemetry names them like every other Building Block and `totalCount` rises for most applications. Telemetry still names only blocks on the official list, and customer-chosen block names stay counted but unnamed.
- 0491157: `Metrics`, `Tracer`, and `DistributedDatabase` report `bbName` and `bbVersion` to `Scope`, so they appear in telemetry like every other Building Block.

## 0.2.5

### Patch Changes

- 0f3c73c: Migration and mock validation reject `ALTER TABLE DROP COLUMN` locally, including the shorthand `ALTER TABLE t DROP col`, because DSQL does not support it. Before, the error only surfaced on deploy.

## 0.2.4

### Patch Changes

- 09b94b8: The `Database` block's default Aurora PostgreSQL engine version is `16.13` instead of the retired `16.4`, which failed deployments with `Cannot find version 16.4 for aurora-postgresql`. Adds a `postgresVersion` option on `DatabaseOptions` to override the engine version.

## 0.2.3

### Patch Changes

- fc8cfad: Republishes the umbrella `@aws-blocks/blocks` package so its tarball matches the updated APIs it re-exports from `@aws-blocks/core` and `@aws-blocks/bb-agent`, and the synced block docs.

## 0.2.2

### Patch Changes

- d898838: Include synced building block documentation updates.

## 0.2.1

### Patch Changes

- 8de7091: Include synced building block documentation updates.

## 0.2.0

### Minor Changes

- b6fb281: Adds `isSynced()` and `waitUntilSynced()` to KnowledgeBase, which tell whether the data source's most recent ingestion job is complete. `waitUntilSynced()` polls until synced and throws `KnowledgeBaseTimeoutException` on timeout or `IngestionFailedException` on a failed job.

## 0.1.9

Dependency updates only.

## 0.1.8

Dependency updates only.

## 0.1.7

Dependency updates only.

## 0.1.6

### Patch Changes

- 1da34f1: `AuthState` carries an optional `errorName` that `setAuthState()` fills from the thrown `ApiError.name`. Adds the `hasAuthError(state, name)` type guard in `@aws-blocks/core` to branch on the returned state.

## 0.1.5

### Patch Changes

- ba3bf7b: Adds a `DESIGN.md` to each building-block package that describes its architecture, API surface, mock implementation, and key design decisions. It ships on npm alongside `README.md`.

## 0.1.4

### Patch Changes

- 7fd51e0: **Breaking: `SignInResult` has a string `status` of `'signedIn' | 'continueSignIn'`, and `isSignedIn` is removed.** Narrow with `if (result.status === 'signedIn')` instead.

## 0.1.3

### Patch Changes

- 835c425: Documents the `AgentStreamChunk` types and `Message` roles.

## 0.1.2

### Patch Changes

- 7b80811: The `@aws-blocks/blocks` package ships a `docs/` folder with every Building Block README and a generated `index.md`, at `node_modules/@aws-blocks/blocks/docs/`. The AGENTS.md templates of `@aws-blocks/create-blocks-app` point to it.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements

## 0.1.0

Initial version
