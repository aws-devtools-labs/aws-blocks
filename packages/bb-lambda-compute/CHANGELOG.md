# @aws-cdk-blocks/bb-lambda-compute

## 1.0.0

The first stable release. The changes since 1.0.0-rc.1 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0 and 1.0.0-rc.1.

### Changes since `@aws-blocks/bb-lambda-compute` 0.x

- The package is now `@aws-cdk-blocks/bb-lambda-compute`. Install it in place of `@aws-blocks/bb-lambda-compute`, and change the import specifiers.

### Since 1.0.0-rc.1

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.1

### Patch Changes

- 0b422ee: The options, defaults, and scaling rules are documented in the `bb-compute` README.

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

### Patch Changes

- 1de6ea4: **Breaking: the framework's reserved URL prefix is now `/cdk-blocks/`, and the old `/aws-blocks/` prefix stays served as an alias.**

  To upgrade:

  1. If an external identity provider only allows the `/aws-blocks/auth/callback` redirect URI, register `/cdk-blocks/auth/callback` or set `redirects.callbackPath: '/aws-blocks/auth/callback'`.
  2. If a custom front door or an explicit `apiPaths` routes `/aws-blocks/*` by hand, also route `/cdk-blocks/*` or use `cf.apiBehaviors(origins.api)`.
  3. If the app is at the CloudFront cache-behavior quota, 25 by default, free a behavior or raise the quota, because the built-in front door adds one for `/aws-blocks/*`.

  A sandbox `stubIdp()` issuer moves to `/cdk-blocks/auth/idp/<id>`, so its users get a new `userId`.

- afad513: Plain origins in `defaults.allowedOrigins`, such as `https://app.example.com`, match exactly, and regex entries must escape `.`. Glob-style entries such as `https://*.example.com` are rejected and fail `cdk synth`, so use `https://[a-z0-9-]+\\.example\\.com` for subdomains.
- d8a86ee: The `LambdaCompute` README and design doc describe how the compute reaches an app, its options, and its VPC, CORS, tracing, and dashboard behavior.

## 0.7.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.
- ce5dfa9: Adds the `Compute` Building Block, `new Compute(scope, id, { type, ...options })`, where the type is `serverless` or `container`. `AsyncJob({ compute })` runs a job on a container on AWS Fargate, and Blocks provisions one shared VPC per backend for containers.

### Patch Changes

- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- db15b5e: The API Gateway integration timeout is written to the template as an explicit `TimeoutInMillis: 29000`, with no runtime change. Hosting monitoring warns at synth when an alarm topic has no subscriber.
- 63b154f: The `@aws-blocks/core` README has a new "Shared API gateway" section, and the `bb-lambda-compute` design notes describe the multi-compute routing.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.6.0

### Minor Changes

- e9241b5: `BlocksStack` and `BlocksBackend` build one shared REST API for the stack, and `gateway` and `apiUrl` are available only once `create()` resolves. `LambdaCompute` no longer exposes `apiGateway` or `apiUrl`, so read the stack's `gateway` and `apiUrl` instead.

### Patch Changes

- e682ba7: `LambdaCompute` reports `bbName`/`bbVersion` to `Scope`, so the default compute appears in telemetry like every other Building Block.

- 66f4be2: **Breaking: `BlocksStack.handler`, `BlocksBackend.handler`, and `Scope.handler` are removed.**

  To upgrade:

  1. Replace `blocksStack.handler.addEnvironment('KEY', value)` with `registerConfig(blocksStack, 'KEY', value)`.
  2. Replace `resource.grantRead(blocksStack.handler)` with `resource.grantRead(blocksStack.executionRole)`.
  3. Replace `blocksStack.handler.addToRolePolicy(statement)` with `blocksStack.executionRole.addToPrincipalPolicy(statement)`.
  4. In a custom Building Block, replace `this.handler` with `this.executionRole` or `registerConfig(this, …)`.
  5. Replace `handler.addEnvironment('CORS_ALLOWED_ORIGINS', …)` with `defaults: { ...BlocksPresets.production, allowedOrigins: [...] }`.

  A real environment variable of the same name wins over a `registerConfig` entry, where the last `addEnvironment` call won before.

## 0.5.1

Dependency updates only.

## 0.5.0

### Minor Changes

- d7312f9: **Breaking: logging, tracing, and the dashboard are driven by each compute, and `Logger` drops its `retention` option and the `LOG_LEVEL` environment variable.**

  To upgrade:

  1. Replace the `retention` option of `LoggingOptions` with the `logRetention` prop on `LambdaCompute`, which falls back to `defaults.logRetention`.
  2. Set the log level with the `level` option of each `Logger`, which defaults to `'info'`, instead of the `LOG_LEVEL` environment variable.
  3. Remove uses of the `LoggerBBRef` and `TracerBBRef` dashboard types.

  Creating any `Tracer` in the app enables X-Ray on every compute, and `DashboardOptions` gains the `logs` and `traces` display toggles.

### Patch Changes

- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.
- 6496713: Replaces `VpcRequirements.runtimeSubnet` with `requiresEgress?: boolean`. The SSM interface endpoint is provisioned only when a Building Block needs it, and the S3 gateway endpoint is always provisioned.

## 0.4.0

### Minor Changes

- 4a830a6: AsyncJob, CronJob, and Realtime attach their resources to a compute resolved at synth, and fail synth with an `UnsupportedCompute` error on anything but a Lambda compute. `@aws-blocks/core` exports `blocksError(name, message)` and `sanitizeConfigKey(id)`.

### Patch Changes

- c45eb92: **Breaking: `BlocksDefaults` gains three required fields, `logRetention`, `throttling`, and `accessLogging`, and the presets now throttle the API stages and replace the shared handler Lambda log group.**

  To upgrade:

  1. Add the three fields to any hand-written literal `BlocksDefaults` object, which is not needed when you spread a `BlocksPresets` preset.
  2. If your app serves above 1000 rps / 2000 burst in production, raise the limit with `defaults: { ...BlocksPresets.production, throttling: { rateLimit, burstLimit } }`.
  3. Delete the old `/aws/lambda/<fn>` log group manually if you want its history gone.

  Sandbox is capped at 200 rps / 400 burst, and Blocks-managed log groups keep events for `ONE_WEEK` in sandbox and `ONE_YEAR` in production.

## 0.3.0

### Minor Changes

- f00adb0: `LambdaCompute` defaults the function to `arm64` instead of `x86_64`, so the next deploy updates the handler function's architecture in place. There is no per-app override yet, so check any x86-only native dependency that your backend bundles.

### Patch Changes

- f00adb0: **Breaking: the Lambda function and API Gateway move under the default compute, so a redeploy replaces them and the API URL changes.**

  To upgrade:

  1. Before you upgrade, confirm that anything wired to the current API Gateway URL, such as an Amplify Gen2 frontend, can absorb a URL change.
  2. If you call `BlocksStack.create()` or `BlocksBackend.create()` from `@aws-blocks/core` directly, import `BlocksStack` from `@aws-blocks/blocks/cdk` instead, or pass a `defaultComputeFactory` on the props.

  Apps built on `@aws-blocks/blocks` need no code change, and the new `Scope.compute` getter resolves the compute a block runs on.

- f00adb0: **Breaking: `BlocksDefaults` has a new required field, `allowedOrigins`, the CORS origin patterns the compute's API accepts.** Add it to any hand-written `BlocksDefaults` literal. The `sandbox` preset allows localhost and `production` allows none, so an object built from `BlocksPresets.sandbox` or `BlocksPresets.production` needs no change.

## 0.2.1

### Patch Changes

- 448a47c: `@aws-blocks/bb-lambda-compute` gains package metadata and a `prebuild` version script, and depends on `@aws-blocks/core` `^0.2.0` instead of `*`. `@aws-blocks/blocks` depends on `@aws-blocks/bb-lambda-compute` `^0.2.0` instead of `*`.

## 0.2.0

### Minor Changes

- 5262062: `LambdaCompute` moves into a new package, `@aws-blocks/bb-lambda-compute`. The package is CDK-only and its sole export is internal, so customers cannot instantiate a compute yet.
