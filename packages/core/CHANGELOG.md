# @aws-cdk-blocks/core

<!-- doc-snippet: skip-file — release notes show the API of past releases, including the removed AuthOIDC block -->

## 1.0.0

The first stable release. The changes since 1.0.0-rc.2 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/core` 0.x

- The package is now `@aws-cdk-blocks/core`. Install it in place of `@aws-blocks/core`, and change the import specifiers.
- 5f55dac: `Auth` has `protect()`, for an API namespace that is deny by default.
- c67048e: `Database` is the only SQL block. `@aws-blocks/bb-data` and `@aws-blocks/bb-distributed-data` are removed. See "Upgrade from `@aws-blocks/bb-data`" in the `bb-database` README.
- c42ba42: The hidden `.blocks/` folder is now `.cdk-blocks/`, and local data moves from `.bb-data/` to `.cdk-blocks/local/data/`.
- 703238f: The scaffolded backend folder is `cdk-blocks/` instead of `aws-blocks/`.
- 45a05d1: The per-deploy state directory is now `.cdk-blocks-sandbox/`.
- 1de6ea4: The reserved URL prefix is now `/cdk-blocks/` (`/cdk-blocks/api`, `/cdk-blocks/auth/*` and others). `/aws-blocks/` still works as an alias.
- f133ff8: With `apiFrontDoor: 'cloudfront'`, CloudFront routes a namespace on a `container` compute straight to its load balancer, so a call can run up to 60 seconds.
- 9ebf67a: An API namespace can run on a `container` compute.
- 5f55dac: Opt in to HTTP error statuses for an API namespace.
- 4665f81: `defaults.appIdentity` gives each app an identity, so many apps can share one AWS account.
- c1fabce: Honor `BLOCKS_LOG_LEVEL` and `BLOCKS_LOG_STREAM` in the lifecycle scripts.
- 41968b7: `AWS_BLOCKS_DISABLE_TEMPLATE_METADATA` is renamed to `CDK_BLOCKS_DISABLE_TEMPLATE_METADATA`.
- 8894669: Telemetry follows your CDK CLI telemetry setting. The old opt-out (`AWS_BLOCKS_DISABLE_TELEMETRY`) is removed. To opt out, run `cdk cli-telemetry --disable` or set `CDK_DISABLE_CLI_TELEMETRY=1`.
- 5f55dac: The OpenRPC spec generator describes every schema under a type name with the right shape, and gets an experimental tag for Building Block authors.
- d46dfaf: A deploy no longer points the local dev loop at AWS.
- 81113a3: The local dev server refuses cross-site `text/plain` `POST` requests to the API. Deployed APIs are unchanged.
- 2c9005f: Reject malformed native declarations instead of dropping them.
- ebfe2ed: Constructing a `Scope` whose `fullId` is already used by a different scope path now logs a warning that names both paths.
- 99660fd: `cdk synth` fails when a scope or block id puts a character into a resource name that the resource's service rejects.
- c1fabce: Read the deploy identity and credentials without deploying.
- 5f55dac: The OpenRPC spec generator describes a TypeScript tuple as a JSON array of positional elements, and a rest parameter typed as a tuple as one parameter per element.
- 44c7377: `defaults.strictNamespacePlacement` serves each API namespace only on the compute it is placed on.
- 072c3ff: An unrecognized `encryption` value on `KVStore` or `FileBucket` fails the synth instead of falling back to the default key.
- c67048e: `VpcRequirements` gains `endpointClientSecurityGroups` and `endpointClientDependents`, for a block that provisions its own compute.
- 227a856: `withAuth(fn, cookies, { allowAnonymous: true })` runs `fn` signed out when no cookies are found, instead of throwing a `401`.
- afad513: A plain `allowedOrigins` entry such as `https://app.example.com` now matches exactly, ignoring case.
- f32185c: Adds the dashboard command, which starts the Admin UI against your app on a free loopback port.
- f32185c: Every deploy is recorded in `.cdk-blocks/deploy-history.jsonl`.
- 9801a5b: Each deploy stage has its own CDK outputs file.
- 93d533a: Add `allowPlainHttp`, an explicit opt-out for builders who need a plain-HTTP front door in production.
- adb6077: A production synth fails for a front door that would carry sign-in, session cookies or the origin-verify secret over plain HTTP. To keep such a door, set `allowPlainHttp`.
- dd1c554: The shared execution role's statements are merged before CDK moves any overflow into managed policies. No permission is added.
- 8ece10a: Require source conditions on KMS key policies that name a service principal.
- c607deb: Behind a CloudFront front door, `ctx.request.url` is the URL the client called, not the API Gateway URL.
- 2095f31: `ctx.request.url.pathname` no longer includes the API Gateway stage when deployed.
- d354055: Add `secretsStore: 'ssm' | 'secrets-manager'` to `BlocksDefaults`.
- 58817b0: Service-principal trust policies get `aws:SourceAccount` and `aws:SourceArn` conditions, and the synth checks for them.

### Since 1.0.0-rc.2

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.2

### Patch Changes

- cad7bb8: The Agent on AgentCore Runtime no longer fails every turn with `BLOCKS_RT_CALLBACK_URL not set` after a first deploy. A turn that arrives before the app config file is readable is rejected, so `stream()` throws.
- 0b422ee: The docs correct statements about `allowedOrigins` matching, the local port, JSON-RPC `params` errors, the `publicApiUrl` output, and the IAM report `condition` field. The shared-account platform guide is now `SHARED-ACCOUNT.md`.

## 1.0.0-rc.1

### Minor Changes

- c42ba42: **Breaking: the hidden `.blocks/` folder is now `.cdk-blocks/`, and local data moves from `.bb-data/` to `.cdk-blocks/local/data/`.**

  To upgrade:

  1. Run `mkdir -p .cdk-blocks && git mv .blocks/config.json .cdk-blocks/config.json`, then delete the empty `.blocks/` folder.
  2. In your tsconfig `include`, change `.blocks/**/*.d.ts` to `.cdk-blocks/**/*.d.ts`.
  3. Run `npm run typegen` and commit `.cdk-blocks/hosting-values.d.ts`.

  Local data is copied to the new location the first time each block opens its store. Pull request #1607 has the full notes.

### Patch Changes

- e529b00: The README error examples import the error constants and `isBlocksError` from `aws-cdk-blocks`, which works in backend and client code.
- 3081521: The deployed Lambda handler reads the `x-blocks-user-agent` request header in any letter case. Before, a client that sent the header in another casing over HTTP/1.1 lost its `client/<lang>/<version>` attribution.
- 23692f1: Every CLI command sends one usage event, and the CDK CLI telemetry opt-out still turns all of it off. `generate types --watch` stops cleanly on Ctrl-C or SIGTERM.

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

- 5f55dac: Adds `auth.protect`, which returns an `ApiNamespace` that is deny by default. It checks the session before any of its `methods` runs, and a signed-out call to a name that isn't a `public` method gets 401 `NotAuthenticatedException`.

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

- f133ff8: On the `apiFrontDoor: 'cloudfront'` tier, CloudFront routes a `container` API namespace straight to the container's load balancer, so a call can run up to 60 seconds instead of ~29. Those calls skip the gateway's throttling and access logs, and synth warns when the distribution has no web ACL.
- 9ebf67a: An `ApiNamespace` can run on a `container` compute, and clients call it as before. A container that serves API namespaces needs a running task, so `scaling.minInstances: 0` fails synth, and `runContainer()` takes the backend module as `runContainer({ backend })`.
- 5f55dac: With the new `ApiNamespace` option `httpErrorStatus: true`, a call that throws an `ApiError` with a 4xx status is answered with that HTTP status instead of 200. `Hosting` then fails synth with `HttpErrorStatusErrorPagesError` if its distribution maps 403 or 404 to a page, so remove those pages.
- 4665f81: Adds `defaults.appIdentity: { id, reportOnly? }`, which tags every resource and IAM role AWS Blocks creates `app=<id>` and checks that derived names start with `<id>-`. It is opt-in, and the core README section "Running many apps in one AWS account" has the full notes.
- c1fabce: `deploy`, `destroy`, `startSandbox`, `destroySandbox`, and `startDevServer` read `BLOCKS_LOG_LEVEL`, which takes `quiet`, `normal`, `verbose`, or `debug`. `BLOCKS_LOG_STREAM=stderr` moves progress to stderr, so stdout keeps only the results.
- 41968b7: **Breaking: `AWS_BLOCKS_DISABLE_TEMPLATE_METADATA` is renamed to `CDK_BLOCKS_DISABLE_TEMPLATE_METADATA`.** The old name is no longer read, so update any script or CI job that sets it. `AWS_BLOCKS_FRAMEWORK_SINK` is renamed to `CDK_BLOCKS_FRAMEWORK_SINK`, which is internal and needs no action.
- 8894669: **Breaking: telemetry follows your CDK CLI telemetry setting, and the AWS Blocks opt-out is removed.** `AWS_BLOCKS_DISABLE_TELEMETRY`, the `cdk-blocks telemetry` command, the `blocks-telemetry` binary, and the `telemetry.enabled` key in `.blocks/config.json` are gone, so if you opted out that way you are opted back in. Opt out with `CDK_DISABLE_CLI_TELEMETRY` set to `1` or `true`, with `cdk cli-telemetry --disable`, or with `cli-telemetry: false` in the `context` of `cdk.json` or `~/.cdk.json`.
- 5f55dac: The OpenRPC spec generator describes two different schemas under one type name separately, so native clients decode each with the right shape. Adds the experimental `@blocksCodegenDefaultTypeArgs` tag for Building Block authors.

- d46dfaf: **Breaking: a deploy no longer writes its AWS `apiUrl` to `.cdk-blocks-sandbox/config.json`, which only a dev server writes.**

  To upgrade:

  1. In scripts that read a deployed URL from `config.json`, read `config.sandbox.json` or `config.production.json`, or run `npm run -s sandbox:deploy -- --query apiUrl`.
  2. Run `npm run dev`, `npm run deploy`, `npm run sandbox:deploy`, or a destroy once, or set `BLOCKS_API_URL`, because the Node.js client refuses a `config.json` that still holds a deployed URL.

  The template e2e tests call the dev server unless you set `TEST_URL` to the URL a deployed app's API is under.

- 81113a3: The local dev server answers `403 Forbidden` to a `POST`, `PUT`, `PATCH`, or `DELETE` request whose `Origin` names another site. A JSON-RPC call must send `Content-Type: application/json` or it gets `415 Unsupported Media Type`, so with `curl` pass `-H 'Content-Type: application/json'`.
- 2c9005f: **Breaking: spec generation exits 1 for a `null` or non-object `aws-blocks` key and for an unrecognized binding field, where it wrote a spec before.** Remove the offending key or field.
- ebfe2ed: A `Scope` whose `fullId` is already used by a different scope path logs a warning, which at `cdk synth` is a CDK annotation with the id `blocks:scope:fullIdCollision`. Rename one of the scopes, because a future release will reject the collision.
- 99660fd: `cdk synth` fails when a scope or block id puts a character into a resource name that the resource's service rejects, such as `new Scope('@acme/shop')` with a `KVStore` under it. Use lowercase letters, digits, and hyphens in ids.
- c1fabce: Adds `readAwsIdentity()` and `describeDeploymentCredentials()` to `@aws-cdk-blocks/core/scripts`, and exports `resolveDeploymentTarget()`. The two new functions return the credentials and Region that a deploy would use, without deploying.
- 5f55dac: **Breaking: the OpenRPC spec generator describes a TypeScript tuple as a JSON array of positional elements, which changes generated native clients.** In Dart clients, tuple-typed params and results are records such as `(num, String)` instead of `dynamic`, so update call sites. A rest parameter typed as a tuple becomes one parameter per element, so native clients call `tablePut(item, options)`, not `tablePut(args)`.
- 44c7377: Adds `defaults.strictNamespacePlacement`, which is `false` in both presets. Set `strictNamespacePlacement: true` so each compute serves only the namespaces placed on it, and a call to a namespace placed elsewhere gets a `-32601` "method not found" error.
- 072c3ff: An unrecognized `encryption` value on `KVStore` or `FileBucket` fails the synth instead of emitting an `UnknownEncryption` warning and falling back to the AWS-managed key. If you hit the error, correct the value.
- c67048e: `VpcRequirements` gains `endpointClientSecurityGroups` and `endpointClientDependents`, so the Blocks-managed interface endpoints admit compute that a Building Block provisions itself. With `provisionEndpoints: false`, Blocks warns with `blocks:vpc:endpoint-client-unadmitted` instead.
- 227a856: Adds `withAuth(fn, cookies, { allowAnonymous: true })`, which runs `fn` signed out when no cookies are found instead of throwing a `401`. Responses to requests without cookies can be edge-cached, so check that the anonymous HTML of these pages is safe to cache.
- afad513: Plain origins in `defaults.allowedOrigins`, such as `https://app.example.com`, match exactly, and regex entries must escape `.`. Glob-style entries such as `https://*.example.com` are rejected and fail `cdk synth`, so use `https://[a-z0-9-]+\\.example\\.com` for subdomains.
- f32185c: Adds the `blocks dashboard` command, which starts the Blocks Admin UI for the app on a free loopback port and opens it with a session token. `blocks dashboard doctor` prints a diagnostic report instead, and `@aws-cdk-blocks/admin-ui` is offered for install when the app does not have it.
- f32185c: Every deploy is recorded in `.blocks/deploy-history.jsonl`, with one `IN_PROGRESS` record when it starts and one terminal record with the same id when it ends. A history file that cannot be written never fails the deploy.

- 9801a5b: **Breaking: a production deploy writes its CDK outputs to `.cdk-blocks-sandbox/outputs.production.json` instead of `.cdk-blocks-sandbox/outputs.json`.**

  To upgrade:

  1. If a script, a CI step, or a launcher reads `.cdk-blocks-sandbox/outputs.json` for production, read `.cdk-blocks-sandbox/outputs.production.json` instead.
  2. If you call `openConsole({ outputsFile })` directly on an app that deployed production before upgrading, run `npm run sandbox` once or delete the stale file.

  `OUTPUTS_FILE` from `@aws-cdk-blocks/core/scripts` carries both paths.

- 93d533a: Adds `allowPlainHttp` to the `alb`, `custom`, and stacked doors, an opt-out for a plain-HTTP front door in production. To keep serving plain HTTP in production, add `allowPlainHttp: true` to the door and acknowledge the `@aws-cdk-blocks/hosting:PlainHttpAllowedInProduction` warning.

- adb6077: **Breaking: a production synth fails when a front door would carry sign-in, session cookies, or the router's origin-verify secret over plain HTTP.**

  To upgrade:

  1. For `{ kind: 'alb' }` with an API, add a `certificate` and `features.domain`, or use the CloudFront or stacked door.
  2. For a `{ kind: 'custom', door }` whose URL is `http://`, return an `https://` url.
  3. For `{ kind: 'stacked', edge: 'cloudfront', router: 'alb' }` with an internet-facing router, give the router a `certificate` and `features.router.domain`, or set `internal: true`.

  A sandbox deploy warns as before, and outside a sandbox `Auth` throws `AuthErrors.InsecureTransport` instead of issuing a session over plain HTTP.

- dd1c554: **Breaking: the shared execution role's overflow managed policies get new logical IDs, `BlocksOverflowPolicy<hash>` instead of `...OverflowPolicyN`, and new generated names.**

  To upgrade:

  1. Update anything keyed on the old logical IDs, such as stack policies or template tests.
  2. If synth fails on the per-role managed policy quota and your account has an increased quota, set the `@aws-cdk-blocks/core:managedPoliciesPerRoleQuota` context, up to 25.
  3. Make a resource depend on the whole role instead of one specific grant, or use a separate role, when CloudFormation reports a circular dependency.

  For an app whose role already overflows, the first deploy after upgrading replaces each overflow policy, and creates the new one before it deletes the old one.

- 8ece10a: Synth also checks that a KMS key policy `Allow` statement for an AWS service principal carries `aws:SourceAccount` or `aws:SourceArn`. A key your app creates gets a warning, which you can acknowledge with the id `@aws-cdk-blocks/core:kmsKeyPolicyWithoutSourceCondition`.
- c607deb: Behind a Blocks CloudFront front door, a Lambda handler's `ctx.request.url` is the URL the client called, not the gateway's `execute-api` URL. `getRequestBaseUrl()` is unchanged, and each CloudFront door adds one CloudFront Function to the account.
- 2095f31: `ctx.request.url.pathname` is the route path in every environment and no longer includes the API Gateway stage when deployed. If you build an absolute link from it while clients call the API Gateway URL directly, add the stage yourself or build the link from your app's configured origin.
- d354055: Adds the required field `secretsStore: 'ssm' | 'secrets-manager'` to `BlocksDefaults`, which sets where AWS Blocks stores the keys it generates for its own Building Blocks. A hand-written `BlocksDefaults` object must add it, and apps that spread a preset need no change.
- 58817b0: The IAM roles AWS Blocks creates scope every service-principal trust to the stack's account with `aws:SourceAccount` and `aws:SourceArn`. Synth warns about a role your app creates without them, and "Service-principal trust" in the `@aws-cdk-blocks/core` README shows how to resolve it.

### Patch Changes

- d01c34c: Adds exports for the types `AgentBase`, `ConversationManagerConfig`, `MessageMetadata`, `GuardrailsConfig`, and `InferenceConfig` in `@aws-cdk-blocks/bb-agent`, `InferMessage` in `@aws-cdk-blocks/bb-realtime`, and `ApiNamespaceConstructor` and `AsyncAPI` in `@aws-cdk-blocks/core`.
- 75c5d98: Copies of `auth.admin` methods are never served over RPC, so a copy such as `{ ...auth.admin }` or a destructured method answers method not found. To serve an admin action, write your own method that checks the caller and then calls `auth.admin`.
- 5f55dac: Auth broadcasts are tagged per API, so `onAuthChange` for one API no longer receives another API's user. `broadcastAuthChange(user, api)` takes an optional `api` to tag a message the same way.
- 2eb62fa: The `hasAuthError` example in the `@aws-cdk-blocks/core` README and JSDoc submits the action with `submitAuthAction` from `aws-cdk-blocks/ui`. A direct `authApi.setAuthState()` call signs the user in but never notifies `onAuthChange` or `AuthenticatedContent`.

- 5f55dac: **Breaking: `AuthBasic`, `AuthCognito`, and `AuthOIDC` are removed, and `Auth` replaces all three.**

  To upgrade:

  1. From your app's root, run `npx @aws-cdk-blocks/bb-auth migrate --dry-run` to preview the changes.
  2. Run `npx @aws-cdk-blocks/bb-auth migrate` to rewrite the files.
  3. Resolve each `TODO(aws-blocks-auth-migrate)` comment and follow `MIGRATION.md` in `@aws-cdk-blocks/bb-auth`.
  4. Keep every block's id exactly as it is, because changing it replaces the user pool and deletes its users.
  5. If you implement `BlocksAuth` yourself, add `requireRole`, which is now required.

  `AuthBasic` users sign up again, `AuthOIDC` users sign in once more, and a `cognitoFederated()` provider's user pool is replaced. Telemetry in `@aws-cdk-blocks/core` counts `Auth` as an official Building Block, and no longer counts the three removed blocks.

- 5f55dac: Adds the Node-only test helpers `getLastAuthCode` and `createTestClient` to `aws-cdk-blocks/utils`. `getLastAuthCode` returns the verification code the local pool sent to a user, and `createTestClient` returns the app's typed clients with a cookie jar of their own.
- 5f55dac: `setAuthState` from `auth.createApi()` takes `setUpTotp`, `verifyTotpSetup`, `getMfaPreference`, and `updateMfaPreference` actions, and the new `MfaSettings` panel from `aws-cdk-blocks/ui` renders them. Native code that matches exhaustively over the `setAuthState` input needs the four new cases.
- b2eb306: Adds `npm run sandbox:preview`, which deploys a hosted preview once and prints its URL. Run `npm run -s sandbox:preview -- --query url` for the recorded URL.
- aaf419f: The sandbox, deploy, and destroy scripts run their `cdk` commands without a shell. Only the sandbox's local dev-server command still runs under a shell.
- 5938d8b: CLI output names the project AWS CDK Blocks, including `create-blocks-app` progress and help text, the `blocks` CLI, and the first-run telemetry notice. The `.gitignore` section that `create-blocks-app` adds to an existing project is headed `# AWS CDK Blocks`.
- a5e754b: The second parameter of the `ApiNamespace` constructor is named `label`, and its JSDoc says that clients never send it. No runtime change.
- 76fd75c: The container compute's default image, `public.ecr.aws/docker/library/node:24-slim`, is pinned by digest, so every task start pulls the same image. A custom `image` is still used exactly as written.
- 3ae8592: A deploy no longer resets the task count of an autoscaled container `Compute` to `minInstances`. A job that is running when its task is stopped gets up to 120 seconds to finish, up from 25 seconds.
- e5822ed: A container compute on the default image runs as the image's unprivileged `node` user instead of root, boots from `/home/node/app`, and starts in `/home/node`. Write scratch files under `/tmp`, or set `image` explicitly to the stock Node image if your app needs root.
- 3ae8592: A container `Compute` with `scaling: { minInstances: 0 }` starts a task when a job is waiting. Scaling to zero requires at least one `AsyncJob` or `CronJob` on the compute and the default or `queue-depth` scaling strategy, otherwise synth fails.
- 9059918: Internal refactor of the Lambda handler's HTTP request handling into a shared module. Lambda responses are unchanged.
- 1deb34b: The `defaults.appIdentity` IAM report also flags resource policies that let in someone outside the app and resources named outside the app's prefix. Lambda layer names truncated to 140 characters end in a hash of the whole logical id, so two long logical ids no longer get the same name.
- d46dfaf: The `npx cdk bootstrap` command in the "not bootstrapped" message names the profile that the deploy uses, such as `--profile prod` after `npm run deploy -- --profile prod`.
- b2eb306: The production `destroy()` loads `.env.production`, as `deploy()` does, so it deletes with the credentials and Region the deploy used. It takes an optional `stackName` and runs no `cdk destroy` when CloudFormation has no stack of that name or the CDK app does not define it.
- 0cf1aa2: The typed API client rejects with an `ApiError` instead of resolving `undefined` when a response is not a JSON-RPC envelope, such as a gateway's `429` or `502` reply. The error carries the HTTP status and the gateway's `message` when present.
- 15e65b4: `@aws-cdk-blocks/core/client` bundles for React Native with Hermes. Reading `.cdk-blocks-sandbox/config.json` now requires Node.js 22.3 or later, so on Node.js 22.0 to 22.2 set `BLOCKS_API_URL` or upgrade Node.js.
- d46dfaf: The dev server, `startSandbox`, `destroySandbox`, `deploy`, and `destroy` keep running when their output pipe or terminal closes, instead of crashing with `write EPIPE` or `write EIO`. Adds the exports `ignoreClosedOutput()` and `CLOSED_OUTPUT_CODES` to `@aws-cdk-blocks/core/scripts`.
- c1fabce: `DeployOptions.onDeployed`, when set, is called with the stack name, API URL, and frontend URL right after `deploy()` reads them and before the `--wait-live` wait.
- d46dfaf: `destroy` and `sandbox destroy` stop at once when no AWS Region is set, or when the account or credentials can't be resolved, instead of retrying. Before the credential pre-check, `sandbox destroy` loads `.env.local`, so an `AWS_PROFILE` or `AWS_REGION` set there is the target that gets checked.
- d46dfaf: With `--host <address>` or `BLOCKS_DEV_HOST`, the dev server's banner, `config.json` `apiUrl`, realtime URL, and CORS use that address instead of localhost. Adds the export `devUrlHost(host)`.
- d46dfaf: The dev server closes its local databases when it stops or reloads, so a stop no longer leaves `postmaster.pid` in `.bb-data`. Adds the export `closeLocalEngines()` to core's dev-server module.
- d46dfaf: Adds a `generateClient` setting for the dev server. Set `"generateClient": false` in `package.json#blocks.dev`, or pass `startDevServer({ generateClient: false })`, to keep an existing `cdk-blocks/client.js` instead of regenerating it at every start.
- d46dfaf: Stopping `npm run dev` no longer leaves `.cdk-blocks-sandbox/dev-server.<port>.pid` behind.
- d46dfaf: The dev-server pidfile no longer goes missing for a moment while `tsx watch` restarts the dev server, so `npm run dev:stop` at that moment finds the dev server.
- d46dfaf: A stop while the dev server starts, or a backend that fails to load, no longer leaves a stale pidfile. `npm run dev:stop -- --all` no longer lists such a port.
- d46dfaf: The dev server no longer kills other processes that hold its port or frontend port, except a frontend left by this app's previous dev server. When anything else holds the port, it exits with code 1, so stop that process or choose another port with `--port` or `--frontend-port`.
- c045273: The local dev server answers `403 Forbidden` to any request whose `Host` header isn't `localhost`, `127.0.0.1`, `[::1]`, or the host set with `BLOCKS_DEV_HOST` or `startDevServer({ host })`. To open the app by a hostname, set `BLOCKS_DEV_HOST` to that hostname.
- d46dfaf: A second `npm run dev` of the same app on another port exits 1, and `npm run sandbox` refuses while a dev session of the app runs. Stop the running server with `npm run dev:stop -- --port <port>`.
- d46dfaf: A second `npm run dev` on a port whose dev server already runs, or any failed start, prints the reason and exits with code 1 instead of hanging. When two dev servers start at the same moment on one port, exactly one runs and the other exits.
- d46dfaf: `npm run dev:stop` right after a backend edit stops the dev server. Before, it printed "nothing to stop" and left the server running.
- d46dfaf: `npm run dev:stop` stops a `npm run dev` that is still starting, and a second `npm run dev` on the port is refused at once. Adds the export `@aws-cdk-blocks/core/scripts/dev-pidfile`, and `StopResult.via` can be `cli`.
- d46dfaf: `npm run dev:stop` waits for `tsx watch` to exit, and SIGKILLs it when its runner was killed and it ignores SIGTERM. The stop also stops the frontend that the runner recorded, and `StopResult` gains `killed: true`.
- d46dfaf: When another process holds the port, `dev stop` names it by pid and command, and `StopResult` has a new `holders` field. A pidfile that `dev stop` can't parse is removed, so `dev stop --all` stops listing its port.
- d46dfaf: `npm run dev:stop` stops the frontend that a killed dev server left running on the frontend port, and reports `via: "frontend"`. When a port stays taken at startup, the message ends with an exact command to run.
- d46dfaf: A dev server bound to all interfaces with `--host 0.0.0.0` or `::` gives a browser the API at the address it opened the app on. It answers `/.blocks-sandbox/config.json` with the same-origin `apiUrl` `/cdk-blocks/api`.
- d46dfaf: On Windows, `npm run dev:stop` ends the whole `npm run dev` session and the frontend it left running, and the next dev server reclaims the frontend port. A failed first start exits 1 instead of hanging, and the port hints name `taskkill` and `netstat` commands.
- 369b175: Adds `escapeRegExp()` and `escapeHtml()` to `@aws-cdk-blocks/core/bb-utils`. The local `GET /cdk-blocks/settings` page escapes the file path it shows, and on Windows it opens `.bb-data/settings.json` with `explorer.exe` instead of `cmd /c start`.
- d7f62f3: Spec generation rejects a binding's `export` that is longer than 64 characters, and names the block that declared it. The Kotlin parser rejects the same length.
- 3be61fa: Long-running processes that deploy repeatedly, such as watch and sandbox loops, no longer gain one `exit` listener per deploy, which eventually triggered `MaxListenersExceededWarning`.
- 36888a1: The core telemetry framework-sink test for opted-out runs checks a private temporary directory, so other tests can no longer make it fail.
- fcf087d: `BlocksStack.create()` and `BlocksBackend.create()` without `defaults` fail with an error that names the fix, `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`. `docs/guides/upgrading-older-apps.md` shows the `index.cdk.ts` edits for older `create-blocks-app` templates.
- 384827f: The `@aws-cdk-blocks/core` README lists what a deployed `/.blocks-sandbox/config.json` holds, which is `apiUrl`, `__blocksBuildId`, and your `backendConfig`. It never holds the account, the stack name, or an ARN.
- 58daa51: The `RpcErrors` metric publishes to the `CDKBlocks` CloudWatch namespace instead of `AWSBlocks`. Update any alarm or dashboard on `AWSBlocks` / `RpcErrors` to `CDKBlocks` / `RpcErrors` after upgrading.
- 6151940: Each failed RPC call on Lambda writes the `CDKBlocks` / `RpcErrors` metric to CloudWatch, with the dimensions `FunctionName` and `StatusClass`. The error message is never written to the metric line.
- b7c262c: An API request whose body is the JSON literal `null` now gets a JSON-RPC Invalid Request (-32600) error instead of crashing the handler.
- 73feb71: A method that resolves to `undefined` answers `{"jsonrpc":"2.0","result":null,"id":1}` instead of leaving out `result`, so the Kotlin and Swift native clients no longer throw "Missing result field". The TypeScript client resolves such a call to `null` instead of `undefined`.
- d46dfaf: `sandbox destroy` deletes the SSM parameter `/<sandbox stack>-db-url`, where the sandbox deploy stores a `*_DB_URL` or `*_CONNECTION_STRING` from `.env.local`. If SSM refuses the delete, it warns with the `aws ssm delete-parameter` command to run.
- d46dfaf: `npm run sandbox` ends, with its `cdk watch`, when its dev server exits. A `npm run dev:stop` reports that it stopped the sandbox session, whose AWS resources stay deployed until you run `npm run sandbox:destroy`.
- d46dfaf: A failed sandbox deploy suggests destroying the sandbox only when the stack is left `*_FAILED` or `ROLLBACK_COMPLETE`, or its state can't be read. For other causes, the hint says what to do instead, such as to fix a synth error and re-run.
- d46dfaf: `npm run sandbox` and `sandbox deploy` work in a project path that contains a space, a quote, `$`, or `%`.
- d46dfaf: A sandbox deploy or a destroy ignores a first SIGTERM or a SIGHUP while cdk runs, and a second SIGTERM or a Ctrl-C stops the whole cdk tree. An operator stop throws `DeployProcessError` with `aborted: true` and the new `operatorSignal`.
- d46dfaf: `npm run deploy` works while `npm run sandbox` watches the same app, and a sandbox deploy or destroy refuses to start during that watch. Existing apps can add `"cdk-blocks/client.js"` to `watch.exclude` in their `cdk.json`.
- 5f55dac: The OpenRPC spec generator honours `@blocksSkipCodegen` on methods of an `auth.protect()` namespace, so a tagged method no longer reaches the generated Swift, Kotlin, and Dart clients.
- cd533c0: A stack name that starts with `aws` in any letter case is an error at synth, for `BlocksStack` and for a `BlocksBackend` inside such a stack. Use a name that does not start with `aws`, and in a scaffolded app change `stackId` in `.blocks/config.json`.
- 1ec956f: Test temp directories are created with `mkdtempSync`, so two tests that start in the same millisecond no longer share a path.
- c1fabce: `BLOCKS_TSX_IMPORT`, when set, replaces `tsx` with another specifier in the client-generation step of `deploy()` and `startSandbox()`.
- 4d81f11: The OpenRPC spec records the name of a union declared as a non-generic type alias. An inline `oneOf` for `type AuthActionInput = ...` carries `"x-blocks-type-name": "AuthActionInput"`, so native code generators can name the union after the alias.
- 5f55dac: The deploy's wait for the new build to go live trims trailing slashes from the hosting URL in linear time.
- ba80bbd: Generated apps keep their npm lifecycle script names without `cdk-blocks/scripts/*.ts` wrappers. Backend-only templates default to port 3001, and production destroy requires confirmation in a terminal or `npm run destroy -- --yes` in automation.
- 05a88e1: When AWS denies the credential check before `npm run deploy` or `npm run sandbox`, the warning says so and says whether an AWS Organizations policy denied the request. A credential failure message names the profile and the deployment Region.
- a86bccb: `sandbox:destroy` and production `destroy` recognise a throttled teardown even when the throttle check itself is throttled. The delete then gets the longer throttle backoff instead of the short 60s and 120s waits.
- b2eb306: The local dev server waits, within its 1.5 s grace, for every process its frontend command started before it exits, then SIGKILLs any that remain. A second Ctrl-C or SIGTERM during that wait no longer ends the dev server before its frontend has stopped.
- df25d97: `npm run dev:stop` and `npm run cleanup` stop a dev server that was started at the same time as another one, such as `npm run dev &` followed at once by `npm run test:e2e`.
- 201e59e: The local dev server handles API and raw-route requests through the same dispatcher as deployed handlers, so cookie and error responses match. Handlers in local dev can read the request cookies, the client user agent, and `ctx.request.signal` through the request context.
- 5f55dac: The local dev server no longer exits on an unhandled promise rejection from request handling. It logs `[unhandled-rejection] <namespace.method>: <error>` with a hint about the missing `await` and keeps serving.
- a5f39c3: The docs describe the status 409 of a failed `KVStore` condition, the local data files of `KVStore` and `AppSetting`, and how a `RawRoute` fills `params` under `npm run dev`.
- d01c34c: The docs state that a conditional KVStore `put` or `delete` is atomic for its item, with no transaction across items. They also cover what `withAuth` detects, the test helpers in `aws-cdk-blocks/utils`, and the dev server's error responses in `TROUBLESHOOTING.md`.
- 5f55dac: Docs and editor hover text point at `Auth` instead of the removed `AuthBasic`, `AuthCognito`, and `AuthOIDC`. The `aws-cdk-blocks` README adds a "Choosing a sign-in method" table.
- 0ff1e1f: The core README describes the installed version, and the `BLOCKS_LOG_LEVEL` table states what an unset level prints.
- d01c34c: A new test checks the code samples of every doc shipped in `docs/` against the packages. The bb-auth README's frontend sample matches with `isBlocksError(e, 'NotAuthenticatedException')` from `aws-cdk-blocks/client` instead of importing `AuthErrors` from `aws-cdk-blocks`.
- f7e28b4: The Astro, Nitro, and SvelteKit adapters and `Hosting`'s `buildCommand` run the app's build without the `cdk` export condition, however it is written, such as `--conditions cdk` or `-C cdk`. A build or `prebuild` script that loads `@aws-cdk-blocks/*` no longer fails during a deploy or destroy.
- 60360c1: `npm run destroy` and `npm run sandbox:destroy` reuse the frontend build output on disk instead of rebuilding. Set `BLOCKS_SKIP_FRONTEND_BUILD=1` to make a deploy reuse it too.
- 4e92168: On the Lambda functions AWS Blocks runs through `createLambdaHandler`, every `Logger` line carries `awsRequestId`, the invocation's request id. The field is reserved, so your context can't replace it, and block authors can read the id with `currentRequestId()` from `@aws-cdk-blocks/core/bb-utils`.
- bfdd06f: Spec generation rejects a malformed `swift.module`, `android.group`, `android.artifact`, or `android.kotlinPackage` native package field, and names the block that declared it. `swift.identity` and `swift.product` stay non-blank only.
- 6d3077e: Docstrings, READMEs, and design notes that pointed at `DistributedTable` describe `KVStore` with a `schema` and a `key`.

- e1e4844: **Breaking: the `cdk-blocks` executable is removed, and AWS Blocks tasks run through your app's package manager.**

  To upgrade:

  1. Upgrade `aws-cdk-blocks`.
  2. From the app directory, run `node --input-type=module -e "import 'aws-cdk-blocks/run'" -- migrate --dry-run` and review the plan.
  3. Run the same command without `--dry-run` from a clean Git working tree.
  4. Change by hand the custom wrappers that the migration reports.

  Structured tasks such as `npm run docs KVStore`, `npm run docs:api KVStore`, and `npm run docs:search "partition key"` print text in a terminal and JSON on a pipe or redirect.

- 6d3077e: The RPC client leaves trailing `undefined` arguments out of `params`, so an optional argument that the caller leaves out stays absent on the server instead of arriving as `null`. An `undefined` before a later argument still arrives as `null`.
- 80ce128: `npm run sandbox` deploys infrastructure changes made while it watches, such as a new `Database` or `Realtime`. The watch passes `--hotswap-fallback`, so a code-only change still hotswaps and any other change runs a full deploy of the stack.
- e286b16: The first-run telemetry notice lists what an event can include and never includes, says the collection endpoint receives your IP address, and names the opt-out, which is CDK's. What is collected and when has not changed.
- c00ab16: The first-run telemetry notice and the `aws-cdk-blocks` README say that the collection endpoint does not store your IP address, except in logs of requests that its firewall blocks. Events are kept for up to 1 year, and logs of all requests, blocked or not, for up to 10 years.
- 58980c7: `npm run sandbox:destroy` works on Windows. `sandbox` deploy, synth, and watch also work when the project path contains a space.

## 0.8.0

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

- 48c35f6: Node clients resend a call once when the connection closes before the response headers arrive, which makes delivery at-least-once. Keep state-changing methods idempotent, or pass `retryStaleConnection: false` to `ApiNamespaceClient` or `generateClient` for at-most-once delivery.
- 48c35f6: The Lambda handler routes Cognito user pool trigger events to the Building Block registered for that user pool under `EventSourceMapping.COGNITO_USER_POOL`. It rejects an event for a pool that no block handles.
- 9a32674: The shared config bucket `BlocksConfigBucket` sets `enforceSSL: true` and `versioned: true`, and every stack gets an additional bucket for its S3 server access logs. S3 can move a versioned bucket only to Suspended, never back to unversioned.
- 4553866: Adds `defaults.permissionsBoundary`, which attaches an IAM permissions boundary to every IAM role AWS Blocks creates. Every synth writes an IAM report to `cdk.out/<stack>.blocks-iam.json`.
- 48c35f6: Two Building Blocks that would handle the same Lambda event, or that register the same config key with different values, fail `cdk synth`. Ids such as `orders-a` and `orders_a` collide on the config key, so rename one of the blocks.
- 48c35f6: Synth fails when a renamed or removed Building Block would let CloudFormation delete a stateful resource recorded in a baseline file under `aws-blocks/baselines/<stack>/`. Restore the block's old id or re-baseline with the block's re-baseline variable, and commit the baseline files with your app.
- 9c96135: Adds `encryption` and `objectLock` options to `FileBucket`, and `BlocksDefaults.storageAccessLogging` for S3 server access logging on every `FileBucket`. With Object Lock, `putUrl()` and `createUploadHandle()` throw `FileBucketErrors.PresignedUploadUnsupported`, so upload with `put()`.
- 63b154f: The typed RPC client POSTs to `/aws-blocks/api/{namespace}`, and the shared gateway routes each namespace to the compute that hosts it. Deploy the backend before clients built against it, pass the base URL in `ApiNamespaceClientOptions.url`, and make your own proxy forward `/aws-blocks/api/*`.
- ce5dfa9: Adds the `Compute` Building Block, `new Compute(scope, id, { type, ...options })`, where the type is `serverless` or `container`. `AsyncJob({ compute })` runs a job on a container on AWS Fargate, and Blocks provisions one shared VPC per backend for containers.
- dde6340: Adds the `frontDoor` prop to `Hosting`, which picks CloudFront, an Application Load Balancer, Amazon API Gateway, a stacked door, no door, or your own door built with `defineFrontDoor`. The top-level settings props are deprecated but still supported, so move each to `frontDoor.features.<x>`.
- 7477b6e: Adds `compute.type: 'web-function'`, which runs the SSR server on AWS Lambda Web Functions behind CloudFront with no API Gateway and no Lambda Web Adapter. Tune it with the `maxConcurrencyPerEnvironment`, `maxEnvironments`, and `rateLimit` fields of `compute.webFunction`.
- d79a0bd: Adds `HostingPresets` and four `Hosting` props, `imageOptimization`, `incrementalRegeneration`, `edgeRoutes`, and `buildId`. `HostingPresets.preview` sets all four plus `frontDoor: { kind: 'apiGateway' }`, and a setting the chosen door can't serve fails synth with `UnsupportedHostingSettingError`.
- dd5e807: `blocks-generate-spec` writes `x-blocks-type-args` for an `oidc/client` result from the provider names the type checker infers. `AuthOIDC.createApi()`'s `getClient()` carries the configured provider names as a string enum, so native clients can generate a provider type.
- d79a0bd: Adds `npm run sandbox:preview`, which deploys a hosted preview sandbox, prints the hosted site URL, and exits. A plain sandbox deploy removes the preview, because they deploy one stack, and `npm run sandbox:destroy` tears a preview sandbox down.
- 8565ef7: Adds a `compute` option to `Scope`, which places everything created under it on one `Compute`, and to `CronJob`, serverless only. A `CronJob` or `AsyncJob` whose compute belongs to a different backend fails synth with an error naming the compute.
- 48c35f6: **Breaking: `hosting-secret remove --force` and `blocks secret remove --force` need `--yes` or `-y` to confirm, in every stage.** Add `--yes` to scripts that run `remove --force`.
- 82ea78a: A project config can no longer re-enable telemetry that a global config disabled. If you relied on that, re-enable globally with `npx blocks-telemetry --enable --global`.
- e44ac0c: CLI telemetry for deploy and sandbox reports the hosting framework, one of `nextjs`, `nitro`, `nuxt`, `astro`, `sveltekit`, `spa`, or `static`. Backend-only projects report no framework.
- b003705: The `AWSToolsMetrics.AWSBlocks` template metadata can be turned off with `AWS_BLOCKS_DISABLE_TEMPLATE_METADATA=1`, the CDK context `blocks:template-metadata=false`, or by turning off CDK version reporting, for example with `cdk deploy --no-version-reporting`.

### Patch Changes

- 90c1b12: Stabilize the core telemetry HTTP tests by waiting for delivery instead of fixed delays and cleaning up their local servers, temporary files and environment even when a test fails or times out.
- 50b8c94: `npm run deploy` and `npm run sandbox` check that CDK has been bootstrapped in the target account and Region before they synthesize. If it has not, they stop with the command to run, `npx cdk bootstrap aws://<account-id>/<region> --app=`.
- ce5dfa9: Container compute deploys without a local Docker daemon. The task runs a stock public Node image, `public.ecr.aws/docker/library/node:24-slim` by default, so the base image moves from Node 22 to Node 24. An `image` you set is used as is and must provide a Node 24 runtime.
- 48c35f6: An RPC error response passes a `Set-Cookie` through only when every browser would delete that cookie. A cookie with several `Expires` attributes, or one that is not a strict HTTP date, is no longer treated as a deletion.
- 8c73a24: `packages/core` declares `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` as devDependencies for its tests, with no change for apps.
- 48c35f6: An RPC error response no longer passes through a `Set-Cookie` whose `Max-Age` is malformed but could be read as a positive lifetime, such as `+999` or `999abc`.
- 48c35f6: `Scope.registerLambdaEventHandler()` throws when a handler is already registered for the same event source and identifier, instead of replacing the first one. A misconfigured app, such as two blocks consuming the same queue, gets an error naming the duplicate.
- 48c35f6: `removeSecret()` from `@aws-blocks/core/scripts` accepts `force: true`, which deletes the secret immediately instead of scheduling it for deletion.
- 54e9443: A method typed from a resolved type keeps its `x-blocks-type-args`. Spec generation no longer fails with `found 0` type args for an arity-1 transferable reached that way.
- 48c35f6: An API error response forwards a `Set-Cookie` only when it has an integer `Max-Age` of `0` or less, or an `Expires` that is an IMF-fixdate at or before now. Values such as `Expires=0` no longer count as a deletion.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 91ed1fc: `npm run deploy` passes `--all` to `cdk deploy`, so an app that synthesizes more than one stack deploys instead of failing.
- 48c35f6: `deploy()` in production mode no longer hangs after the deploy finishes. It no longer loads local mocks, so it does not apply migrations to, or write data into, your local `.bb-data/` database.
- d062eeb: `npm run deploy` and `npm run sandbox` print the deployment target before they deploy, with the credentials, the Region, the account name, and the AWS account plan. Account IDs, ARNs, error text, and plan credits are not printed.
- c22eeee: `npm run sandbox:destroy` removes every top-level stack the app synthesizes in sandbox mode with `cdk destroy --all`, including a stack you add yourself. Give such a stack a name derived from the sandbox's stack name, and don't create one in sandbox mode if it must outlive the sandbox.
- 1546160: `sandbox:destroy` and production `destroy` retry a throttled teardown with exponential backoff for about 20 minutes instead of giving up after the fixed 60s and 120s waits. A destroy that stays throttled can run for about 30 minutes before it fails.
- 8565ef7: Synth errors for a compute that can't serve API namespaces, or for an export name API Gateway can't route, give the compute's full construct path, for example `MyStack/app/reports/backing`.
- 515089c: A multi-page static site with no 404 page of its own and no `errorPages.notFound` gets the default 404 page, at HTTP 404, behind every front door, not only CloudFront. A bring-your-own door receives it as `DoorInput.app.errorPages.notFound`.
- d79a0bd: Preview deploys are faster. `HostingConstruct` takes `inPlaceBuild`, a preview re-deploy passes `--method direct` next to `--hotswap-fallback`, and a Next.js build with `imageOptimization: false` no longer installs `sharp`.
- 6a53068: The API and auth CloudFront behaviors attach a response headers policy, so their responses carry headers such as HSTS and X-Frame-Options from the next synth. `CdnConstruct` and `HostingConstruct` expose the policy as a public `securityHeadersPolicy` field.
- db15b5e: The API Gateway integration timeout is written to the template as an explicit `TimeoutInMillis: 29000`, with no runtime change. Hosting monitoring warns at synth when an alarm topic has no subscriber.
- 48c35f6: Calls to a non-enumerable property of an API method map, or to a method of a Building Block instance that a handler returns, get a `-32601` "Method not found" error.
- 48c35f6: An API method that throws can clear cookies in the same response, and any other cookie set before the throw is still dropped. Multiple `Set-Cookie` values are delivered on API Gateway HTTP API and Function URL events.
- 48c35f6: Every `Set-Cookie` value that an `ApiNamespace` method sets in one response is delivered on AWS. Before, only one cookie reached the browser.
- 72e3259: `npm run sandbox` no longer prints a DEP0190 deprecation warning on Node 24.
- 48c35f6: `npm run sandbox` telemetry reports which Building Blocks your app uses when telemetry is enabled. The sandbox generates the deployed client before deploying, so an error in the backend surfaces before the deploy.
- 0d4ede3: `bb-kv-store` and `bb-distributed-table` share one internal helper in `@aws-blocks/core` for point-in-time-recovery and encryption resolution. The synth output is unchanged.
- 63b154f: The `@aws-blocks/core` README has a new "Shared API gateway" section, and the `bb-lambda-compute` design notes describe the multi-compute routing.
- b6b8ade: The native-client spec generator reads the `ApiNamespace` handler argument itself, whatever follows it. A namespace with an options object after the handler no longer gets `unknown` types in the Swift, Kotlin, and Dart bindings.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).
- 48c35f6: Vendorized apps that use `DistributedTable` with an index, `Database` with migrations, or `DistributedDatabase` synthesize instead of failing with `Cannot find asset` or `Cannot find entry file`.

## 0.7.0

### Minor Changes

- 4ae500e: Adds a `dev:stop` npm script to every standalone template, so `npm run dev:stop` stops the local dev server. `@aws-blocks/core/scripts` exports `stopDevServer`, `runStopCli`, `stopMessage`, and the `StopResult` type.
- 6d764f7: `AWS_BLOCKS_DISABLE_TELEMETRY` accepts `true` and `yes` in addition to `1`, case-insensitive and trimmed. If you already export `AWS_BLOCKS_DISABLE_TELEMETRY=true` or `=yes` for another tool, Blocks telemetry is disabled where it was still on before.
- 5d6656a: Adds the `apiFrontDoor` prop, and `publicApiUrl` on `BlocksStack` and `BlocksBackend` for the URL clients should call. Setting `apiFrontDoor: "cloudfront"` puts a CloudFront distribution in front of the API, and switching tiers changes the API's endpoint domain and signs every user out.
- 94a914a: Spec generation rejects a native package's Dart `name` or `library`, or a binding's `export`, that would break codegen, such as `My-Package`, `lib/x.dart`, or `device link`. A Dart `name` of `blocks_runtime` is also rejected.
- cb0ec01: `blocks.spec.json` can carry two top-level OpenRPC extensions, `x-blocks-native-packages` and `x-blocks-native-bindings`, for native codegen. `generateSpec` and `writeSpec` take a new trailing `SpecGenerationOptions`, and invalid metadata throws `NativeCatalogError`.
- 005c095: `blocks-generate-spec` reads the `aws-blocks.native` key in each installed block's `package.json` and emits the `x-blocks-native-packages` and `x-blocks-native-bindings` catalogs. It exits non-zero without writing a file when a block's declarations are invalid.
- b8649dc: The two pg-based Building Blocks report the block's user-agent chain as the Postgres `application_name`, in the form `aws-blocks/<core> bb/Database/<version>`. An `application_name` in your connection string or your `PGAPPNAME` is used instead, and a custom block's name never enters the chain.

- 66f4be2: **Breaking: `BlocksStack.handler`, `BlocksBackend.handler`, and `Scope.handler` are removed.**

  To upgrade:

  1. Replace `blocksStack.handler.addEnvironment('KEY', value)` with `registerConfig(blocksStack, 'KEY', value)`.
  2. Replace `resource.grantRead(blocksStack.handler)` with `resource.grantRead(blocksStack.executionRole)`.
  3. Replace `blocksStack.handler.addToRolePolicy(statement)` with `blocksStack.executionRole.addToPrincipalPolicy(statement)`.
  4. In a custom Building Block, replace `this.handler` with `this.executionRole` or `registerConfig(this, …)`.
  5. Replace `handler.addEnvironment('CORS_ALLOWED_ORIGINS', …)` with `defaults: { ...BlocksPresets.production, allowedOrigins: [...] }`.

  A real environment variable of the same name wins over a `registerConfig` entry, where the last `addEnvironment` call won before.

- da6d4c7: **Breaking: shared Blocks resources are scoped to the `BlocksStack` or `BlocksBackend` instead of the enclosing `cdk.Stack`.** An app that embeds a `BlocksBackend` inside a customer `cdk.Stack` and uses realtime or cron sees those resources replaced on upgrade. For realtime, the WebSocket API URL changes and the stack output key changes from `RealtimeWsUrl` to `BlocksRealtimeWsUrl<hash>`, so update scripts that read that output by name. Single-`BlocksStack` apps see no resource replacement.
- e9241b5: `BlocksStack` and `BlocksBackend` build one shared REST API for the stack, and `gateway` and `apiUrl` are available only once `create()` resolves. `LambdaCompute` no longer exposes `apiGateway` or `apiUrl`, so read the stack's `gateway` and `apiUrl` instead.
- 122c49c: **Breaking: an opted-out run with `--telemetry-file` writes no identifiers, prints no notice, writes no file, and sends no HTTP.** To capture events without sending them, use `BLOCKS_TELEMETRY_ENDPOINT=http://127.0.0.1:1 <cmd> --telemetry-file=<path>` instead of combining the flag with `AWS_BLOCKS_DISABLE_TELEMETRY`. That run is consented, so it still writes the installation ID and prints the notice.

### Patch Changes

- ec7eebe: Adds the `Secret` Building Block, `@aws-blocks/bb-secret`, which stores one application secret in AWS Secrets Manager with `get()`, `put()`, `listVersions()`, and `Secret.fromExisting(arn)`. A new secret is empty, so `get()` returns `null` until a value is set, unless you pass `generate: true`.
- e682ba7: `LambdaCompute` reports `bbName`/`bbVersion` to `Scope`, so the default compute appears in telemetry like every other Building Block.
- e7e96e6: The AWS credential check before `npm run deploy` and `npm run sandbox` finds the Region in your AWS profile and in `cdk.json`, not only in `AWS_REGION` and `AWS_DEFAULT_REGION`. The secret upload to SSM uses the same Region.
- 9ebda66: Emit the AWS Blocks version and deployment mode in CloudFormation template metadata under `AWSToolsMetrics.AWSBlocks`.
- 78f4396: CORS guidance points at the stack's `defaults.allowedOrigins`. The runtime warning for a disallowed origin says to add it to `defaults.allowedOrigins` instead of setting the `CORS_ALLOWED_ORIGINS` environment variable.
- 440ecce: When the AWS credential check before `npm run deploy` and `npm run sandbox` fails, the message names the profile and the command that fixes its credentials. `@aws-blocks/core` requires AWS SDK for JavaScript clients 3.936.0 or later.
- 1a5c18e: Production `destroy` retries a failed teardown with backoff and empties each stack's versioned S3 buckets before each retry, as the sandbox destroy does. A destroy that fails for a non-transient reason takes the full backoff of 60s then 120s to report the error.
- 60616b1: The local dev server reuses HTTP connections to the frontend server.
- a50fb46: The generate-spec-cli test fixture has a `package.json` so tsx resolves its relative import. Test only, with no change to the shipped CLI.
- 8a1a4a9: Test-only change that covers npm's `ci/<vendor>` user-agent token in the shared `isCI()` case table.
- 38ce80c: `npm run dev` listens on `127.0.0.1` instead of every interface, and the local realtime WebSocket rejects a client-sent `publish` and checks `Origin`. For a container or remote devbox, set `BLOCKS_DEV_HOST=0.0.0.0`, and publish from the server with `Realtime.publish()`.
- 2da2fd4: A RawRoute whose handler throws an uncaught exception returns a generic `500` with `"Internal error"` instead of the error's raw name and message. A Building Block error or `ApiError` keeps its name and message, and the full error is still logged server-side.
- 32a4b73: `AuthOIDC` is reported as the parent block of its session store, and `core` adds the `computeScopeFullId` and `buildingBlockParent` exports. In local and other non-Lambda runs the session cookie name changes, for example to `oidc_my-app-auth`, so existing sessions there are signed out once.
- e3e5e22: RPC dispatch in the Lambda handler and the local dev server reaches only API surfaces. An exported Building Block instance, a `_`-private export, and members inherited from `Object.prototype` such as `toString` can no longer be called over RPC.
- f1eb149: `--telemetry-file` keeps every event of a run instead of only the first, appended to the same JSON array. Update anything that asserts the file holds exactly one event.
- 7c19c4f: Adds an opt-in `--wait-live` flag to `npm run deploy`. With it, the deploy prints `BLOCKS_DEPLOYED` only once the new build is served, and exits non-zero if that is not confirmed within `--wait-live-timeout=<seconds>`, default 180.

## 0.6.0

### Minor Changes

- 5501cb6: **Breaking: the `monitoring.snsTopicArn` prop and the `hosting.monitoringTopic` attribute are removed.**

  To upgrade:

  1. Replace `monitoring: { snsTopicArn }` with `monitoring: { subscriptions: [new subs.EmailSubscription('oncall@example.com')] }` or a `UrlSubscription`.
  2. Read `hosting.monitoring`, which is `{ alarms, alarmTopics }`, instead of `hosting.monitoringTopic`.
  3. To route alarms to an existing SNS topic, call `hosting.monitoring.alarms.forEach(a => a.addAlarmAction(new cw_actions.SnsAction(myTopic)))`.

  Off-region deployments place the CloudFront 5xx alarm in a synthesized `<stackName>-CfMonitoring-<addr>` us-east-1 stack. See #481.

- 39628cb: Each `CORS_ALLOWED_ORIGINS` entry matches the whole origin, so `^https://app\.example\.com` no longer matches `https://app.example.com:8443`. If you relied on prefix matching, append `(:\d+)?` or `.*` to the entry, and set `CORS_HOSTING_ORIGINS` to a raw, unescaped origin.
- a649895: A successful `npm run deploy` or `npm run sandbox` prints one stable last line, `BLOCKS_DEPLOYED url=<frontend> api=<backend>`, that a script can grep. For a backend-only app and for `npm run sandbox`, the line omits `url=`.
- 5515483: **Breaking: a config that sets `cdn.ssrDefaultTtl > 0` fails synth with `SsrCacheKeyCredentialsRequiredError` until the SSR cache key includes a credential.** Add `cacheKeyCookies: ['<your session cookie>']` or `cacheKeyHeaders: ['authorization']`, or remove `ssrDefaultTtl` and make personalized routes emit `Cache-Control: private`.
- 757d4a9: `@aws-blocks/core` forwards the `x-blocks-user-agent` header that native clients send into the AWS SDK user agent, and exports the `installClientUserAgent` SDK middleware. Kotlin callers are attributed first, and Swift and Dart follow.
- a23b8d8: **Breaking: a plain `Error` thrown from an API method reaches the client as a generic `500` with `"Internal error"` instead of its raw message.** To send a specific status, name, and message to the client, throw an `ApiError`, for example `new ApiError("Todo not found", 404, { name: "TodoNotFoundException" })`. Building Block errors keep their name and message on the wire.

### Patch Changes

- b58f248: The Lambda and dev server CORS preflights both allow `Content-Type, Authorization` and `x-blocks-user-agent`. A browser call that sets the user-agent header or a bearer token is no longer blocked, in local dev too.
- d4b32f2: `@aws-blocks/create-block` ships `README.md` and `DESIGN.md` in the published package.
- 27646ac: Tighten dev server singleton and retry handling for port contention follow-ups.
- 9e02b82: Spec extraction attributes a factory-returned `ApiNamespace` to its namespace when it is bound through an array or tuple pattern, such as `const [a, b] = factory()`, or through nested destructuring.
- 465a002: Telemetry uses ci-info for CI detection, so Taskcluster, Netlify, Vercel, and 40+ other CI providers are identified. It honors `CI=false`.

## 0.5.0

### Minor Changes

- d7312f9: **Breaking: logging, tracing, and the dashboard are driven by each compute, and `Logger` drops its `retention` option and the `LOG_LEVEL` environment variable.**

  To upgrade:

  1. Replace the `retention` option of `LoggingOptions` with the `logRetention` prop on `LambdaCompute`, which falls back to `defaults.logRetention`.
  2. Set the log level with the `level` option of each `Logger`, which defaults to `'info'`, instead of the `LOG_LEVEL` environment variable.
  3. Remove uses of the `LoggerBBRef` and `TracerBBRef` dashboard types.

  Creating any `Tracer` in the app enables X-Ray on every compute, and `DashboardOptions` gains the `logs` and `traces` display toggles.

- 6496713: Replaces `registerVpcEndpoint` with `registerVpcGatewayEndpoint` and `registerVpcInterfaceEndpoint`, and reduces `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`.

### Patch Changes

- 2806ae2: Ensure the hosting route cutover waits for the resolved client configuration deployment.
- f552ebe: `blocks-generate-spec` keeps the parameter and result schemas of an `ApiNamespace` that is built in a factory, destructured, and then exported, such as `const { api } = new Factory().build()`.
- 9aa0814: `blocks-generate-spec` keeps the schemas of two `ApiNamespace`s apart when they share a method name, such as `widgets.create` and `subscriptions.create`. Before, one overwrote the other in the generated OpenRPC document.
- 012cd89: Document the JSON-RPC error code mapping used by the ApiNamespace wire protocol.
- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.
- 21443ba: Optimistic-concurrency and conditional-write conflicts reach clients as JSON-RPC error code 409 instead of 500. Code that matches conflicts by name with `isBlocksError` is unaffected, but code that branched on `error.status === 500` now sees `409`.
- acd1628: A RawRoute registered through one copy of `@aws-blocks/core` is dispatched by a duplicate copy instead of silently returning 404. Unmatched routes log a diagnostic, and a duplicate core copy warns once.
- 6496713: `Database` in a bring-your-own VPC places its Aurora cluster in the isolated subnets when the VPC has them, and in `PRIVATE_WITH_EGRESS` subnets otherwise. Synth no longer fails with "no isolated subnet groups in this VPC".
- 6496713: A Building Block passes its VPC requirements to the `BuildingBlockScope` constructor, and Blocks creates one shared VPC when a block declares `requiresVpc: true` and you bring none. `Database` accepts an optional `subnets` placement for its Aurora cluster.
- 6496713: Interface endpoints accept 443 only from the Blocks Lambda SG instead of the whole VPC CIDR. Replaces `VpcRequirements.subnetRole` with `requiresEgress`, and synth fails with a clear error when the runtime's placement has no egress or the VPC lacks a requested subnet tier.
- 6496713: Replaces `VpcRequirements.runtimeSubnet` with `requiresEgress?: boolean`. The SSM interface endpoint is provisioned only when a Building Block needs it, and the S3 gateway endpoint is always provisioned.
- 302090a: The local dev server no longer crashes when a WebSocket client resets its connection during the upgrade.

## 0.4.0

### Minor Changes

- df667c5: Adds `backendModulePath` to `BlocksStack` and `BlocksBackend`, so a Building Block that bundles the app backend at synth time can find it. The shared execution role, `BlocksRole`, is created with a `CompositePrincipal`, so a Building Block can add its own trust principal.
- df667c5: Adds `getConfigLocation(scope)`, which returns the `{ bucketName, key }` of the shared config bucket. A Building Block whose compute runs outside the Lambda handler can use it to load the same app config.

- c45eb92: **Breaking: `BlocksDefaults` gains three required fields, `logRetention`, `throttling`, and `accessLogging`, and the presets now throttle the API stages and replace the shared handler Lambda log group.**

  To upgrade:

  1. Add the three fields to any hand-written literal `BlocksDefaults` object, which is not needed when you spread a `BlocksPresets` preset.
  2. If your app serves above 1000 rps / 2000 burst in production, raise the limit with `defaults: { ...BlocksPresets.production, throttling: { rateLimit, burstLimit } }`.
  3. Delete the old `/aws/lambda/<fn>` log group manually if you want its history gone.

  Sandbox is capped at 200 rps / 400 burst, and Blocks-managed log groups keep events for `ONE_WEEK` in sandbox and `ONE_YEAR` in production.

- 4a830a6: AsyncJob, CronJob, and Realtime attach their resources to a compute resolved at synth, and fail synth with an `UnsupportedCompute` error on anything but a Lambda compute. `@aws-blocks/core` exports `blocksError(name, message)` and `sanitizeConfigKey(id)`.
- f2f186c: The `DeleteOldBuilds` lifecycle rule expires only superseded builds after `buildRetentionDays`, never the build that is currently served. `buildRetentionDays` is now configurable from `@aws-blocks/core`.

### Patch Changes

- 64ddd74: An internal refactor makes `finalizeConfigRegistry` grant `s3:GetObject` on the config object to the shared execution role and set `BLOCKS_CONFIG_BUCKET` and `BLOCKS_CONFIG_KEY` on every compute.
- df667c5: `createLambdaHandler` retries a failed initialization on the next request instead of caching the failure for the container's lifetime. A broken deploy re-runs initialization on every invocation, so revisit any alarms that assumed a fast, sticky init failure.
- 646614b: `ApiNamespace` records its name on its resolved compute during CDK synth, an internal change.
- 46b7c89: Adds a `blocks-generate-client` bin to `@aws-blocks/blocks` that generates the local `aws-blocks` package's client entry point. The templates run it as `"prebuild": "blocks-generate-client"`, so a fresh checkout resolves the package and `cdk synth` no longer fails.
- 1da58fd: `destroySandbox`, used by `npm run destroy`, empties versioned S3 buckets before it retries `cdk destroy`. A versioned bucket no longer blocks the delete.

## 0.3.0

### Minor Changes

- f00adb0: **Breaking: the Lambda function and API Gateway move under the default compute, so a redeploy replaces them and the API URL changes.**

  To upgrade:

  1. Before you upgrade, confirm that anything wired to the current API Gateway URL, such as an Amplify Gen2 frontend, can absorb a URL change.
  2. If you call `BlocksStack.create()` or `BlocksBackend.create()` from `@aws-blocks/core` directly, import `BlocksStack` from `@aws-blocks/blocks/cdk` instead, or pass a `defaultComputeFactory` on the props.

  Apps built on `@aws-blocks/blocks` need no code change, and the new `Scope.compute` getter resolves the compute a block runs on.

- f00adb0: **Breaking: `BlocksDefaults` has a new required field, `allowedOrigins`, the CORS origin patterns the compute's API accepts.** Add it to any hand-written `BlocksDefaults` literal. The `sandbox` preset allows localhost and `production` allows none, so an object built from `BlocksPresets.sandbox` or `BlocksPresets.production` needs no change.
- 08ab129: Adds `pointInTimeRecovery: boolean | { retentionDays: number }` to `BlocksDefaults` and `BlocksPresets`. The preset value is `true` in `production` and `false` in `sandbox`.
- 9d4ccea: Adds `secret('KEY')` and `config('KEY')` to hosting and pipeline, which keep values in AWS Secrets Manager and SSM Parameter Store for `getSecret('KEY')` and `getConfig('KEY')` to read at runtime. Set values with `npm run secret` and `npm run config`, and run `npm run typegen` for typed keys.

### Patch Changes

- 5798492: `AsyncJob` batches SQS messages with a default `batchSize: 10`, up from `batchSize: 1`, and a new `maxBatchingWindowSeconds` option with a default of 5. Set `batchSize: 1` and `maxBatchingWindowSeconds: 0` to opt out.
- 5bfae0a: `parseRpcRequest` caps a JSON-RPC request body at 10 MiB and returns a `413` error named `PayloadTooLarge`. The local dev server rejects the same oversized body that API Gateway rejects in production.
- 0ac3879: `sandbox` and `deploy` check AWS credentials before the synth and exit with guidance when they are missing, expired, or invalid. A network or service error only warns, and the check is skipped with a warning when no region is set in `AWS_REGION` or `AWS_DEFAULT_REGION`.
- e4dac4a: `npm run sandbox` runs `cdk deploy --method direct --express`, which returns before resources finish stabilizing and has no automatic rollback. It requires an `aws-cdk` CLI that has `--express`, and the dev-dependency floor is `^2.1138.0`.

## 0.2.0

### Minor Changes

- 7b4c62d: **Breaking: `BlocksStack.create` and `BlocksBackend.create` require a `defaults` field.** Pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`, which replaces the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin. A per-block option still wins over `defaults`. The experimental `hardening` prop is removed with its `resolve*` helpers.

### Patch Changes

- 5262062: Adds the internal abstract `Compute` base behind `@aws-blocks/core/cdk/internal`. It is not part of the public API, and customers cannot instantiate a compute yet.
- 3614a09: The handler bundling shims `import.meta.url`, `import.meta.dirname`, and `import.meta.filename`, so `fileURLToPath(import.meta.url)` no longer crashes the deployed Lambda at load. Inside the bundle these resolve to the bundled output location, not your source tree.
- 5262062: `LambdaCompute` moves into a new package, `@aws-blocks/bb-lambda-compute`. The package is CDK-only and its sole export is internal, so customers cannot instantiate a compute yet.
- 5071079: `SandboxDisableDeletionProtection` disables DynamoDB deletion protection, so `sandbox:destroy` no longer fails on protected tables.
- 8966cfb: Telemetry reports runs on Render and Taskcluster as `ci:true`, detected from `RENDER` and `TASKCLUSTER_ROOT_URL`.
- b11a75b: Reject primitive and null JSON-RPC params with the standard Invalid Params error.

## 0.1.18

### Patch Changes

- cb779c8: Adds a shared execution role for the handler and a `Scope.executionRole` getter. On an existing deployed stack, the upgrade replaces the Lambda execution role with the new `BlocksRole`, which gets the same grants and needs no action.

## 0.1.17

### Patch Changes

- b48aaec: The 504 timeout response gives a disallowed origin no CORS grant instead of reflecting the request `Origin`. `Access-Control-Max-Age` drops from `86400` to `7200`, and every CORS response carries `Vary: Origin`.
- ac0966a: The docs show the correct default local dev port, `:3000/aws-blocks/api`.
- 9de27dd: `npm run deploy` streams CloudFormation progress to stdout, and a single SIGTERM or any SIGHUP no longer ends a deploy in progress. The `Deployment failed.` banner moved from stderr to stdout, so anything that greps stderr for it no longer matches.
- 8e96d87: The dev server returns a JSON usage hint, `{ error, expected: { method: 'POST', path: '/aws-blocks/api' } }`, instead of a 404 with no body when a request doesn't match `POST /aws-blocks/api`.
- 58f77dd: The docs cover runtime config resolution, `RawRoute`, server-initiated OIDC sign-in, and error and RPC semantics.
- 2d3dfdc: `npm run sandbox` no longer passes the redundant `--hotswap` flag to `cdk watch`, which emitted a duplicate-option warning on some `aws-cdk` CLI versions.

## 0.1.16

### Patch Changes

- b09e568: Adds a SvelteKit framework adapter. SvelteKit apps are detected through `@sveltejs/kit` and deployed with `@sveltejs/adapter-node` on Lambda, fronted by CloudFront and S3, with no manual setup.

## 0.1.15

### Patch Changes

- 1f1287e: The build-time placeholder `config.json` is uploaded as a no-cache path and the config deployment invalidates `/builds/<buildId>/.blocks-sandbox/*`, so CloudFront no longer serves a stale placeholder after a deploy. A cached placeholder made `getApiUrl()` throw and every client API call fail.

## 0.1.14

### Patch Changes

- fc33428: Telemetry is now enabled in CI for `create-blocks-app`, the same as all other CLI commands. With `NODE_DEBUG=blocks-telemetry`, the telemetry worker inherits the parent's stderr, and `console` treats a missing browser opener as success instead of failing.

## 0.1.13

### Patch Changes

- a7427d4: Prevent verbose local RPC logging from turning successful void handlers into error responses.

## 0.1.12

### Patch Changes

- 71eb746: Hosting fixes eleven issues, among them Astro SSR `/_image` content types, the image optimizer on Next 15.x, wildcard redirects, and Nuxt IPX remote images. A missing static asset returns `404 NoSuchKey`, and the new `quotas.maxRouteChunks` hosting prop raises the 64-chunk route cap.

## 0.1.11

### Patch Changes

- 76e1e50: The local dev server frees a stale `:3000` or `:3100` listener at startup, and a second `npm run dev` exits with a clear message instead of competing for the ports. A `:3000` bind failure prints a console error, retries, and exits non-zero if it cannot recover.

## 0.1.10

### Patch Changes

- e839301: The external database connection string moves to a stack-scoped SSM parameter, `/<stackName>-db-url`, so two apps in one account, region, and stage no longer overwrite each other. The previous `/blocks/{stage}/db-connection-string` parameter is orphaned and self-heals on the next deploy.

## 0.1.9

### Patch Changes

- 9075b81: Adds `basePath` and `quotas` options to `Hosting`, and the Nitro adapter detects Nuxt's `app.baseURL`. SSR header rules no longer take CloudFront behavior slots, and pages over the behavior budget are demoted to SSR or grouped instead of failing the build.

## 0.1.8

### Patch Changes

- e9dc073: Telemetry events are sent from a detached background subprocess, so they are delivered even when the CLI process exits early on a failure path.

## 0.1.7

### Patch Changes

- 6eb731a: The dev server stops the whole frontend process group on restart and shutdown, and it respawns the frontend after an unexpected exit. A `tsx watch` restart no longer leaves `/` serving `502 Frontend server unavailable`.
- a40e840: The dev server binds to all interfaces, `0.0.0.0`, for WSL2 compatibility.

## 0.1.6

### Patch Changes

- f42c604: Stack names are derived from a `stackId` in `.blocks/config.json`, generated at scaffold time, as `<stackId>-prod` for production and `<stackId>-<username(8)>-<random(6)>` for a sandbox. Templates import `getStackId()` and `getSandboxId()` from `@aws-blocks/blocks/scripts`.
- 1da34f1: `AuthState` carries an optional `errorName` that `setAuthState()` fills from the thrown `ApiError.name`. Adds the `hasAuthError(state, name)` type guard in `@aws-blocks/core` to branch on the returned state.

## 0.1.5

### Patch Changes

- 162c47d: The image-optimization Lambda no longer reserves concurrency by default. The hardcoded `reservedConcurrency: 10` made `cdk deploy` fail on fresh AWS accounts, and you can set `compute.imageOptimization.reservedConcurrency` to cap it.

## 0.1.4

### Patch Changes

- a306ff1: The dev server serves `/.blocks-sandbox/config.json` itself instead of proxying it to the framework dev server. In local `dev`, the browser auth client no longer fails with "Blocks API URL not configured".

## 0.1.3

### Patch Changes

- e98bab4: Moves the `Pipeline` construct into the `@aws-blocks/pipeline` package and adds `partialBuildSpec` for CodeBuild runtime control. The CDK entrypoint of `@aws-blocks/core` re-exports `Pipeline`, `DeployStage`, and the pipeline configuration types.

## 0.1.2

### Patch Changes

- 18880ff: `deploy`, `sandbox`, and `destroy` no longer fail on Windows.

## 0.1.1

### Patch Changes

- 270c049: Ports documentation from the internal staging repo.
- c0558f3: Minor improvements

## 0.1.0

Initial version
