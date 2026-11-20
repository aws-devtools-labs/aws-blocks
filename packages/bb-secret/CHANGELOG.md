# @aws-cdk-blocks/bb-secret

## 1.0.0

The first stable release. The changes since 1.0.0-rc.2 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/bb-secret` 0.x

- The package is now `@aws-cdk-blocks/bb-secret`. Install it in place of `@aws-blocks/bb-secret`, and change the import specifiers.
- d354055: Adds an internal `@aws-cdk-blocks/bb-secret/internal` entry point for the generated keys of other blocks.

### Since 1.0.0-rc.2

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The docs state that a deployed `Secret` with no registered secret ARN also throws `SecretErrors.NotSupported`. `put()` clears the cache of the calling instance only, and other instances see the new value when their cache entry expires.

## 1.0.0-rc.1

### Patch Changes

- e529b00: The README error examples import the error constants and `isBlocksError` from `aws-cdk-blocks`, which works in backend and client code.
- fbe48c5: Local data moved from `.bb-data/{fullId}/` to `.cdk-blocks/local/data/{fullId}/`, and existing data is copied over on first use. The `@aws-cdk-blocks/core` changelog has the upgrade steps.

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

- d354055: Adds an internal `@aws-cdk-blocks/bb-secret/internal` entry point that AWS Blocks' own Building Blocks use to create their generated keys. Synth warns with `@aws-cdk-blocks/bb-secret:SsmSecretsStoreOutsideSandbox` when `'ssm'` is used on a stack that looks like production.

### Patch Changes

- 5f55dac: `Auth` takes a block-level `store` and one `providers` map, keyed by provider id and tagged with its `type`. The default `store: 'cognito'` keeps users in a Cognito user pool, and `store: 'builtin'` has no user pool, so your backend verifies each provider itself.
- 5f55dac: A provider's `clientSecret` and Sign in with Apple's `privateKey` accept a string-valued `Secret` as well as an `AppSetting` created with `secret: true`. Create the `Secret` with `generate: true`, then after the first deploy set the real value with `npm run secret` and deploy again.

- 1de6ea4: **Breaking: the framework's reserved URL prefix is now `/cdk-blocks/`, and the old `/aws-blocks/` prefix stays served as an alias.**

  To upgrade:

  1. If an external identity provider only allows the `/aws-blocks/auth/callback` redirect URI, register `/cdk-blocks/auth/callback` or set `redirects.callbackPath: '/aws-blocks/auth/callback'`.
  2. If a custom front door or an explicit `apiPaths` routes `/aws-blocks/*` by hand, also route `/cdk-blocks/*` or use `cf.apiBehaviors(origins.api)`.
  3. If the app is at the CloudFront cache-behavior quota, 25 by default, free a behavior or raise the quota, because the built-in front door adds one for `/aws-blocks/*`.

  A sandbox `stubIdp()` issuer moves to `/cdk-blocks/auth/idp/<id>`, so its users get a new `userId`.

- 0ff1e1f: The AppSetting and Secret docs describe the installed version. The Secret docs no longer promise managed rotation, which `Secret` does not expose.
- 6d3077e: Docstrings, READMEs, and design notes that pointed at `DistributedTable` describe `KVStore` with a `schema` and a `key`.
- da7eb93: After `put()` resolves, the next `get()` on that `Secret` instance returns the new value on AWS. Before, a `get()` in flight during the `put()` could cache the old value until the cache entry expired.
- 3259d83: The `Secret` README has a complete example of a key the app generates and rotates itself, with a `CronJob` that rotates it through `put()`. The Local development section explains that the mock re-reads `.bb-data/settings.json` on every `get()`.
- 70ea280: `Secret` schema-validation errors no longer include the secret value. `get()` and `put()` throw `SecretErrors.ValidationFailed` with a fixed message, and the original issues stay on the error's non-enumerable `cause` for server-side logging.

## 0.3.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.
- 3d83cb6: **Breaking: a `Secret` is read-only at runtime by default, so it has no `put()` method and the execution role is not granted `PutSecretValue`.** Pass `allowRuntimeWrite: true` to each secret that your app writes at runtime.

### Patch Changes

- 943d405: The `cdk` entry of `@aws-blocks/bb-secret` exports `WritableSecret` and `SecretConstructor`, so backend code that imports them type-checks.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 27c35e5: The docs state that `Secret` reads pick up rotated values after `cacheTtlSeconds`, not only on cold start, and that `EmailClient` validates recipient and size limits on AWS too. Other fixes cover the `useChat` anchor, `Pipeline` connection ARN examples, and the `KnowledgeBase` mock's chunking.
- ea57feb: Corrects three JSDoc comments. The `EmailErrors` example passes `send()` a single message object, `Secret` examples that call `put()` pass `allowRuntimeWrite: true`, and an omitted `FileBucket` `removalPolicy` inherits the stack's `BlocksDefaults.removalPolicy`.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.2.0

### Minor Changes

- ec7eebe: Adds the `Secret` Building Block, `@aws-blocks/bb-secret`, which stores one application secret in AWS Secrets Manager with `get()`, `put()`, `listVersions()`, and `Secret.fromExisting(arn)`. A new secret is empty, so `get()` returns `null` until a value is set, unless you pass `generate: true`.
