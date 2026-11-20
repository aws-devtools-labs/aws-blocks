# @aws-cdk-blocks/hosting

## 1.0.0

The first stable release. The changes since 1.0.0-rc.1 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0 and 1.0.0-rc.1.

### Changes since `@aws-blocks/hosting` 0.x

- The package is now `@aws-cdk-blocks/hosting`. Install it in place of `@aws-blocks/hosting`, and change the import specifiers.
- c42ba42: The hidden `.blocks/` folder is now `.cdk-blocks/`, and local data moves from `.bb-data/` to `.cdk-blocks/local/data/`.
- 703238f: The scaffolded backend folder is `cdk-blocks/` instead of `aws-blocks/`.
- 45a05d1: The per-deploy state directory is now `.cdk-blocks-sandbox/`.
- 1de6ea4: The reserved URL prefix is now `/cdk-blocks/` (`/cdk-blocks/api`, `/cdk-blocks/auth/*` and others). `/aws-blocks/` still works as an alias.
- 4665f81: `defaults.appIdentity` gives each app an identity, so many apps can share one AWS account.
- 93d533a: Add `allowPlainHttp`, an explicit opt-out for builders who need a plain-HTTP front door in production.
- adb6077: A production synth fails for a front door that would carry sign-in, session cookies or the origin-verify secret over plain HTTP. To keep such a door, set `allowPlainHttp`.
- fb29c06: Lock the CloudFront door's server origin with a random secret, a regional web ACL and opt-in access logs.
- 40d25ec: Keep credentialed and cookie-setting SSR responses out of the shared edge cache.
- c1fabce: `secret` and `config` CLIs print help for `--help` and `-h`.

### Since 1.0.0-rc.1

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.1

### Minor Changes

- c42ba42: **Breaking: the hidden `.blocks/` folder is now `.cdk-blocks/`, and local data moves from `.bb-data/` to `.cdk-blocks/local/data/`.**

  To upgrade:

  1. Run `mkdir -p .cdk-blocks && git mv .blocks/config.json .cdk-blocks/config.json`, then delete the empty `.blocks/` folder.
  2. In your tsconfig `include`, change `.blocks/**/*.d.ts` to `.cdk-blocks/**/*.d.ts`.
  3. Run `npm run typegen` and commit `.cdk-blocks/hosting-values.d.ts`.

  Local data is copied to the new location the first time each block opens its store. Pull request #1607 has the full notes.

### Patch Changes

- 8fbbeca: The hosting docs cover front-door compatibility, hosting options, and synth errors, and the package ships the custom front-door guide. The pipeline quick start uses `Pipeline.create()` and documents the pipeline options and their defaults.
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

- 4665f81: Adds `defaults.appIdentity: { id, reportOnly? }`, which tags every resource and IAM role AWS Blocks creates `app=<id>` and checks that derived names start with `<id>-`. It is opt-in, and the core README section "Running many apps in one AWS account" has the full notes.
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

- c1fabce: `hosting-secret`, `hosting-config`, `runSecretCli`, and `runConfigCli` print usage and exit 0 for `--help` or `-h`, so `remove KEY --help` no longer deletes the value. `runValueCli` takes the new options `interactive: false` and `yes: true`, and a usage problem throws the new `ValueCliUsageError`.

### Patch Changes

- d01c34c: Adds API Extractor reports, `API.md`, for `@aws-cdk-blocks/hosting`, `@aws-cdk-blocks/pipeline`, and `@aws-cdk-blocks/bb-compute`. The block docs folder of `aws-cdk-blocks` ships them next to each package's README.
- 5f55dac: With the new `ApiNamespace` option `httpErrorStatus: true`, a call that throws an `ApiError` with a 4xx status is answered with that HTTP status instead of 200. `Hosting` then fails synth with `HttpErrorStatusErrorPagesError` if its distribution maps 403 or 404 to a page, so remove those pages.
- 0ff1e1f: The Hosting README describes the installed version. It also states that `version`, `partitioning`, and `format` are set through `frontDoor.features.logging` on both `HostingConstruct` and core's `Hosting`.
- f7e28b4: The Astro, Nitro, and SvelteKit adapters and `Hosting`'s `buildCommand` run the app's build without the `cdk` export condition, however it is written, such as `--conditions cdk` or `-C cdk`. A build or `prebuild` script that loads `@aws-cdk-blocks/*` no longer fails during a deploy or destroy.
- 668227b: The CloudFront door serves a server built as a buffered Lambda handler instead of answering 502 on every path. A Nuxt app that leaves `awsLambda.streaming` off works, and Lambda limits a buffered response to 6 MB.
- 1f565bd: The README and the `getSecret()` JSDoc state that local values for `getSecret()` and `getConfig()` go in `.env.local`. The Blocks dev server and sandbox do not load `.env`.
- 52dd5e6: A Next.js image request for a source image that isn't in the assets bucket returns `404 Not Found` instead of `500 Internal server error`. A real server error from the Next.js image optimizer is sent with `Cache-Control: no-store`, so CloudFront no longer caches it for 60 seconds.
- 5f55dac: The Nitro adapter trims trailing slashes from `runtimeConfig.ipx.baseURL` in linear time when it builds the image optimization route.
- c6a59f4: The Next.js adapter accepts `@opennextjs/aws` 4.1.x without the out-of-range warning. An app that doesn't declare `@opennextjs/aws` builds with 4.1.14 instead of 4.0.3, and the build warns for `next` versions below `>=15.5.28 <16 || >=16.4.1`.
- 1e4d08d: The Hosting README states that behind a standalone ALB door with no certificate, `Auth` omits `Secure` from its same-origin session cookie, so the cookie travels in clear text. It recommends a certificate for anything beyond testing.
- 5f55dac: The `PlainHttpFrontDoor` synth warning for a plain-HTTP ALB door refers to `Auth` instead of the removed `AuthBasic`, `AuthCognito`, and `AuthOIDC` blocks.
- e6c989d: `frontDoor: 'none'` always warns at synth with `@aws-cdk-blocks/hosting:PlainHttpFrontDoor`, including for a static site with no backend API. If `'none'` is intended, call `Annotations.of(stack).acknowledgeWarning('@aws-cdk-blocks/hosting:PlainHttpFrontDoor')`.
- b2eb306: An empty `secret list` suggests `set <KEY>` (prompted, or piped with `--value-stdin`), instead of `set <KEY> <value>`, which the secret CLI refuses.
- b2eb306: `secret set` of a key that `secret remove` scheduled for deletion restores the secret and sets the new value instead of failing. For a key that does not exist, `secret remove KEY --force --yes` reports that it was not set.
- 60360c1: `npm run destroy` and `npm run sandbox:destroy` reuse the frontend build output on disk instead of rebuilding. Set `BLOCKS_SKIP_FRONTEND_BUILD=1` to make a deploy reuse it too.
- e3b5949: Ship `dist/constructs/THIRD-PARTY-LICENSES.txt`, which lists the third-party npm packages included in the bundled Lambda handlers, with their license texts.
- 184df0b: `npm run typegen` and the dev server infer schema-typed `config()` and `secret()` types with the tsconfig that compiles each file, starting from `strict: true`. `z.number().nullable()` is inferred as `number | null` when the root `tsconfig.json` only lists project references.
- b2eb306: The hidden value prompt of `hosting-secret set KEY` and `runValueCli` rejects with the new `ValueCliInterruptedError` on Ctrl-C or Ctrl-D instead of never settling. It is written to stderr, so stdout carries only the result.
- b2eb306: The secret and config CLI refuses an unknown option, or an extra argument to `list` or `remove`, with a usage error instead of storing or ignoring it. After `--`, every argument is a positional, so a config value can start with `-`, as in `config set KEY -- -1`.
- b2eb306: The secret and config CLI reports an invalid key, an empty value, and a missing subcommand as `ValueCliUsageError`s, so callers map them to their usage exit code. A missing subcommand says `<label> needs a subcommand: set, list or remove.` instead of `Unknown subcommand undefined`.
- 8ece10a: Synth also checks that a KMS key policy `Allow` statement for an AWS service principal carries `aws:SourceAccount` or `aws:SourceArn`. A key your app creates gets a warning, which you can acknowledge with the id `@aws-cdk-blocks/core:kmsKeyPolicyWithoutSourceCondition`.

- e1e4844: **Breaking: the `cdk-blocks` executable is removed, and AWS Blocks tasks run through your app's package manager.**

  To upgrade:

  1. Upgrade `aws-cdk-blocks`.
  2. From the app directory, run `node --input-type=module -e "import 'aws-cdk-blocks/run'" -- migrate --dry-run` and review the plan.
  3. Run the same command without `--dry-run` from a clean Git working tree.
  4. Change by hand the custom wrappers that the migration reports.

  Structured tasks such as `npm run docs KVStore`, `npm run docs:api KVStore`, and `npm run docs:search "partition key"` print text in a terminal and JSON on a pipe or redirect.

- 58817b0: The IAM roles AWS Blocks creates scope every service-principal trust to the stack's account with `aws:SourceAccount` and `aws:SourceArn`. Synth warns about a role your app creates without them, and "Service-principal trust" in the `@aws-cdk-blocks/core` README shows how to resolve it.

## 0.5.0

### Minor Changes

- dde6340: Adds the `frontDoor` prop to `Hosting`, which picks CloudFront, an Application Load Balancer, Amazon API Gateway, a stacked door, no door, or your own door built with `defineFrontDoor`. The top-level settings props are deprecated but still supported, so move each to `frontDoor.features.<x>`.
- 7477b6e: Adds `compute.type: 'web-function'`, which runs the SSR server on AWS Lambda Web Functions behind CloudFront with no API Gateway and no Lambda Web Adapter. Tune it with the `maxConcurrencyPerEnvironment`, `maxEnvironments`, and `rateLimit` fields of `compute.webFunction`.
- d79a0bd: Preview deploys are faster. `HostingConstruct` takes `inPlaceBuild`, a preview re-deploy passes `--method direct` next to `--hotswap-fallback`, and a Next.js build with `imageOptimization: false` no longer installs `sharp`.
- d79a0bd: Adds `HostingPresets` and four `Hosting` props, `imageOptimization`, `incrementalRegeneration`, `edgeRoutes`, and `buildId`. `HostingPresets.preview` sets all four plus `frontDoor: { kind: 'apiGateway' }`, and a setting the chosen door can't serve fails synth with `UnsupportedHostingSettingError`.
- 6a53068: The API and auth CloudFront behaviors attach a response headers policy, so their responses carry headers such as HSTS and X-Frame-Options from the next synth. `CdnConstruct` and `HostingConstruct` expose the policy as a public `securityHeadersPolicy` field.
- 3b5a419: Adds opt-in CloudFront standard logging v2 for hosting access logs, set with `logging.version: 'v2'`. The default remains `'v1'`, and synth throws `LoggingV2RegionError` in any Region other than us-east-1.
- 48c35f6: **Breaking: `hosting-secret remove --force` and `blocks secret remove --force` need `--yes` or `-y` to confirm, in every stage.** Add `--yes` to scripts that run `remove --force`.

### Patch Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 2c73654: The adapter loads `astro.config` under Astro 7, so `redirects`, `trailingSlash`, and image settings are no longer ignored.
- 515089c: A multi-page static site with no 404 page of its own and no `errorPages.notFound` gets the default 404 page, at HTTP 404, behind every front door, not only CloudFront. A bring-your-own door receives it as `DoorInput.app.errorPages.notFound`.
- a02549a: `HostingError` keeps `cause` as a non-enumerable property, so `JSON.stringify` and object spread no longer include the wrapped error. `error.cause` still returns the original error.
- f8bfab1: With an ISR or SWR route rule that names a folder in `public/`, pages under that folder that render on demand go to the server instead of returning 404. `RouteBehavior` has a new optional `exact` field that keeps a route in its own row of the front door's route table.
- 3ae22e6: The Next.js adapter builds with `@opennextjs/aws@4.0.3` when the app does not declare `@opennextjs/aws`, and warns when the app's `next` version is outside OpenNext's peer range. Run `npm install --save-dev @opennextjs/aws@~4.0.3` to declare it.
- c8c26f7: A Next.js deploy no longer fails when its Next.js major passes OpenNext's support window. The Next.js adapter passes `--dangerously-use-unsupported-next-version` to the OpenNext build, so OpenNext prints a warning and continues.
- 3803f19: The image-optimization bundles for Next.js, Astro, and Nuxt install `sharp@^0.35.5` instead of sharp 0.34.x, so redeploy to pick it up. On Astro 4 and 5, a slightly corrupt source image that `/_image` used to render now fails to optimize.
- db15b5e: The API Gateway integration timeout is written to the template as an explicit `TimeoutInMillis: 29000`, with no runtime change. Hosting monitoring warns at synth when an alarm topic has no subscriber.
- c0f6a83: Include the Apache-2.0 `LICENSE` file in the published package.

## 0.4.1

### Patch Changes

- 8b5ef4a: The hosting SSR `RestApi` sets `cloudWatchRole: false`, so `cdk destroy` no longer leaves an unused IAM role behind. Before you delete a previously retained role by hand, run `aws apigateway get-account` and check that `cloudwatchRoleArn` does not point at it.
- 382dac6: The image-optimization Lambda no longer follows redirects on remote image fetches, so a 3xx fails the image request. If an allowlisted image host serves its images through a redirect, allowlist the final location instead.
- c6d9e49: With `dangerouslyAllowSVG` / `IMAGE_ALLOW_SVG` off, the image-optimization Lambda rejects SVG content with a `415` by checking the image bytes, not the file extension. An SVG served from `/logo` or `/logo.png` no longer passes the gate.
- 7c19c4f: Adds an opt-in `--wait-live` flag to `npm run deploy`. With it, the deploy prints `BLOCKS_DEPLOYED` only once the new build is served, and exits non-zero if that is not confirmed within `--wait-live-timeout=<seconds>`, default 180.

## 0.4.0

### Minor Changes

- 5501cb6: **Breaking: the `monitoring.snsTopicArn` prop and the `hosting.monitoringTopic` attribute are removed.**

  To upgrade:

  1. Replace `monitoring: { snsTopicArn }` with `monitoring: { subscriptions: [new subs.EmailSubscription('oncall@example.com')] }` or a `UrlSubscription`.
  2. Read `hosting.monitoring`, which is `{ alarms, alarmTopics }`, instead of `hosting.monitoringTopic`.
  3. To route alarms to an existing SNS topic, call `hosting.monitoring.alarms.forEach(a => a.addAlarmAction(new cw_actions.SnsAction(myTopic)))`.

  Off-region deployments place the CloudFront 5xx alarm in a synthesized `<stackName>-CfMonitoring-<addr>` us-east-1 stack. See #481.

- 5515483: **Breaking: a config that sets `cdn.ssrDefaultTtl > 0` fails synth with `SsrCacheKeyCredentialsRequiredError` until the SSR cache key includes a credential.** Add `cacheKeyCookies: ['<your session cookie>']` or `cacheKeyHeaders: ['authorization']`, or remove `ssrDefaultTtl` and make personalized routes emit `Cache-Control: private`.

### Patch Changes

- 773cef2: The Astro adapter accepts an empty or absent `dist/client` for a pure-SSR build instead of throwing `AstroBuildOutputMissingError`. It requires only `dist/server/entry.mjs`.
- 6b7fe4c: A stack delete completes instead of hanging on the `IsrTagTableSeed` custom resource and failing with `DELETE_FAILED`.
- dae7a86: Synth emits a deprecation warning when a compute resource pins `nodejs18.x` or `nodejs20.x`. Use `nodejs22.x` or `nodejs24.x`, or omit the runtime to use the default.
- 7b7a59f: The EventBridge Scheduler role's trust policy is limited to schedules in the stack's account and region. Hosting removes a redundant CloudFront `kms:Decrypt` statement from the SSE-KMS key policy.

## 0.3.1

### Patch Changes

- 2806ae2: Ensure the hosting route cutover waits for the resolved client configuration deployment.
- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.

## 0.3.0

### Minor Changes

- f2f186c: The `DeleteOldBuilds` lifecycle rule expires only superseded builds after `buildRetentionDays`, never the build that is currently served. `buildRetentionDays` is now configurable from `@aws-blocks/core`.

### Patch Changes

- 1da58fd: `HostingConstruct` retains the CDKBucketDeployment custom resources, so a failed delete-time handler no longer leaves the stack in `DELETE_FAILED` on teardown.
- 4b74c7f: Adds `encodeManagedValue`, `decodeManagedValue`, `managedValueReplacer`, and `managedValueReviver` to `@aws-blocks/hosting`, so `secret()` and `config()` markers survive a JSON round-trip. `PipelineProps` takes an optional `postStage` hook that returns each stage's post-deploy steps.

## 0.2.0

### Minor Changes

- 9d4ccea: Adds `secret('KEY')` and `config('KEY')` to hosting and pipeline, which keep values in AWS Secrets Manager and SSM Parameter Store for `getSecret('KEY')` and `getConfig('KEY')` to read at runtime. Set values with `npm run secret` and `npm run config`, and run `npm run typegen` for typed keys.

## 0.1.10

### Patch Changes

- dd2350b: The `KvKeys` custom resource IAM policy grants only `cloudfront-keyvaluestore:DescribeKeyValueStore` and `UpdateKeys`. With this policy, the hosting stack deploys under Service Control Policies or permission boundaries that deny `cloudfront-keyvaluestore:ListKeys`.

## 0.1.9

### Patch Changes

- 940956e: The monitoring construct's alarm SNS topic is encrypted with a dedicated KMS key, `MonitoringAlarmTopicKey`, available as `encryptionKey` on `MonitoringConstruct`. The key adds roughly $1/month per stack, and `monitoring: { enabled: false }` or your own `snsTopic` avoids it.
- 4981137: The CDN invalidation custom resource sets `installLatestAwsSdk: false`, which removes roughly 15-30s of cold start from every hosting deploy. The only template change is the `InstallLatestAwsSdk: false` property on the `Custom::AWS` resource.
- 5c58c53: SSR framework Lambdas and Lambda@Edge compute run on `nodejs24.x`. `resolveRuntime()` defaults to `nodejs24.x` and throws `UnsupportedRuntimeError` for an unrecognized runtime instead of falling back to Node 20.

## 0.1.8

### Patch Changes

- 0284e5b: After a deploy, HTML is served from the current build, so a returning visitor with a `__dpl` cookie from a previous build no longer gets a blank page. Assets keep honoring the cookie.

## 0.1.7

### Patch Changes

- b09e568: Adds a SvelteKit framework adapter. SvelteKit apps are detected through `@sveltejs/kit` and deployed with `@sveltejs/adapter-node` on Lambda, fronted by CloudFront and S3, with no manual setup.

## 0.1.6

### Patch Changes

- 9586841: The docs cover custom domain configuration with Route 53 and bring-your-own DNS.

## 0.1.5

### Patch Changes

- 71eb746: Hosting fixes eleven issues, among them Astro SSR `/_image` content types, the image optimizer on Next 15.x, wildcard redirects, and Nuxt IPX remote images. A missing static asset returns `404 NoSuchKey`, and the new `quotas.maxRouteChunks` hosting prop raises the 64-chunk route cap.
- 71eb746: `VERIFIED_OPENNEXT_RANGE` covers `>=3.10.0 <3.11.0 || >=4.0.0 <4.1.0`, so apps on OpenNext 4.0.x no longer trip the out-of-range warning.

## 0.1.4

### Patch Changes

- 9075b81: Adds `basePath` and `quotas` options to `Hosting`, and the Nitro adapter detects Nuxt's `app.baseURL`. SSR header rules no longer take CloudFront behavior slots, and pages over the behavior budget are demoted to SSR or grouped instead of failing the build.

## 0.1.3

### Patch Changes

- 162c47d: The image-optimization Lambda no longer reserves concurrency by default. The hardcoded `reservedConcurrency: 10` made `cdk deploy` fail on fresh AWS accounts, and you can set `compute.imageOptimization.reservedConcurrency` to cap it.

## 0.1.2

### Patch Changes

- 42adb51: `framework: 'static'` always produces multi-page routing, and a multi-page site without its own `404.html` gets a built-in default 404 page. If you relied on SPA-fallback routing with `framework: 'static'`, switch to `framework: 'spa'`.
- 061a0b2: A redeploy uploads assets before the CloudFront build-id cutover, so new visitors no longer get a 403 during a deployment.

## 0.1.1

### Patch Changes

- 270c049: Ports documentation from the internal staging repo.
- c0558f3: Minor improvements

## 0.1.0

Initial version
