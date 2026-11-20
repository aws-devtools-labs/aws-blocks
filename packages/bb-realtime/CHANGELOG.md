# @aws-cdk-blocks/bb-realtime

## 1.0.0

The first stable release. The changes since 1.0.0-rc.2 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/bb-realtime` 0.x

- The package is now `@aws-cdk-blocks/bb-realtime`. Install it in place of `@aws-blocks/bb-realtime`, and change the import specifiers.
- 42b84b2: Add `getChannel(namespace, channel, { scope: 'exact' })` and validate channel names.
- eb60b04: Bind channel handles to the signed-in user, re-check subscriptions on ping, and add `revokeAccess()`.
- d354055: The connection token key now follows `defaults.secretsStore`.

### Since 1.0.0-rc.2

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The README separates the AWS behavior from the local WebSocket server and lists `revokeAccess` among the runtime-only methods.

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

- 42b84b2: Adds `getChannel(namespace, channel, { scope: 'exact' })`, whose token authorizes the channel only and none of its sub-channels. `publish()`, `subscribe()`, and `getChannel()` throw `RealtimeErrors.ValidationFailed` for a channel name that is empty or has an empty, `.`, or `..` segment.

- eb60b04: **Breaking: Realtime tokens now carry `iat` and `jti`, and handles issued before the upgrade stop working.**

  To upgrade:

  1. Pass the session's user id, `user.userSub`, as `principal` in `getChannel(namespace, channel, { principal })` for every channel that belongs to a user.
  2. To revoke a user's access, call the new `rt.revokeAccess(principal)`, and make your app's `refresh` endpoint refuse that user too.

  Clients that pass `refresh` recover on their next reconnect, and other clients must call your API method again. Subscriptions are re-checked on every keep-alive ping and at fan-out.

- d354055: **Breaking: with `BlocksPresets.production`, the connection token key moves to a new Secrets Manager secret with a new value, and the deploy deletes the old SSM parameter.** To keep the existing key, set `secretsStore: 'ssm'` in `defaults` before you deploy this version. Otherwise, on their next reconnect, clients that do not pass `refresh` to `subscribe()` receive `onDisconnect('error')` and must call `getChannel()` again. Sandbox stacks do not change.

### Patch Changes

- d01c34c: Adds exports for the types `AgentBase`, `ConversationManagerConfig`, `MessageMetadata`, `GuardrailsConfig`, and `InferenceConfig` in `@aws-cdk-blocks/bb-agent`, `InferMessage` in `@aws-cdk-blocks/bb-realtime`, and `ApiNamespaceConstructor` and `AsyncAPI` in `@aws-cdk-blocks/core`.
- b2eb306: A specific IPv6 `BLOCKS_DEV_HOST` (for example `fd00::1`) now admits the local realtime WebSocket from its bracketed origin (`http://[fd00::1]:3000`).
- bfaddeb: In local dev, a second subscriber to a channel that is already subscribed on the same connection gets its `established` promise resolved. Before, `await sub.established` on any later subscriber never settled.

- 703238f: **Breaking: the scaffolded backend folder is `cdk-blocks/`, not `aws-blocks/`.**

  To upgrade:

  1. Rename the `aws-blocks/` directory to `cdk-blocks/`.
  2. Change the `"workspaces"` entry that names it.
  3. Change the `"name"` in its `cdk-blocks/package.json` to `cdk-blocks`.
  4. Change every `from 'aws-blocks'` import to import `cdk-blocks`.
  5. Rename an `aws-blocks/migrations` directory or set an explicit migrations path, because `DEFAULT_MIGRATIONS_ROOT` is now `./cdk-blocks/migrations`.

  The reserved URL namespace, such as `/aws-blocks/api` and `/aws-blocks/auth/*`, keeps its path, so deployed routes and OAuth callback URLs keep working.

- 0ff1e1f: The Realtime docs state the channel-name limits directly. Channel names have no segment-count or per-segment length limit, and the byte limits are the only size limits.
- e8673cd: The docs and `UnsupportedCompute` errors state that `AsyncJob` and `CronJob` support Lambda and container delivery, while `Realtime` requires default Lambda compute. Omitting container concurrency allows five in-flight deliveries per job per instance, not one per vCPU, and the docs now say so.
- 6d3077e: `Agent`, `AsyncJob`, and `Realtime` compose `KVStore` instead of `DistributedTable`, and a deployed stack updates in place. Every read hides expired job-status records and connection records.
- 10eb382: A server-side subscriber runs its handler once per published message on AWS, as it already did locally. The handler used to run twice when the publish came from the subscriber's own process.
- 6bac1c9: The WebSocket handler rejects a `subscribe` whose channel is not a path that `getChannel()` returns with `{ type: 'error', message: 'Invalid channel' }`. A subscribe without a channel token gets `{ type: 'error', channel, message: 'Unauthorized: missing token' }` from the deployed handler too.

## 0.5.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.

### Patch Changes

- 8cff0bb: The published package now includes `USE-CASES.md`, so the link to it from the README resolves.
- 943d405: Frontend code can import Building Block error constants, such as `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, `LoggingErrors`, and `RealtimeErrors`, to match errors with `isBlocksError`. `CronJobErrors.ScheduleNotSupported` is no longer `undefined` in the browser.
- 943d405: The `cdk` entry of `@aws-blocks/bb-realtime` exports `RealtimeChannelDescriptor`, `SubscribeOptions`, and `DisconnectReason`, so backend code that imports them type-checks.
- 48c35f6: Two Building Blocks that would handle the same Lambda event, or that register the same config key with different values, fail `cdk synth`. Ids such as `orders-a` and `orders_a` collide on the config key, so rename one of the blocks.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 92c4b20: The README "Runtime only" note states that a data method called during CDK synth throws `<Class>.<method>() cannot be called during CDK synth`.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.4.0

### Minor Changes

- da6d4c7: **Breaking: shared Blocks resources are scoped to the `BlocksStack` or `BlocksBackend` instead of the enclosing `cdk.Stack`.** An app that embeds a `BlocksBackend` inside a customer `cdk.Stack` and uses realtime or cron sees those resources replaced on upgrade. For realtime, the WebSocket API URL changes and the stack output key changes from `RealtimeWsUrl` to `BlocksRealtimeWsUrl<hash>`, so update scripts that read that output by name. Single-`BlocksStack` apps see no resource replacement.

### Patch Changes

- 023f02c: An internal refactor routes the remaining per-package errors through core's `blocksError`. Two realtime timeout rejections that were unbranded are now wire-safe.
- 38ce80c: `npm run dev` listens on `127.0.0.1` instead of every interface, and the local realtime WebSocket rejects a client-sent `publish` and checks `Origin`. For a container or remote devbox, set `BLOCKS_DEV_HOST=0.0.0.0`, and publish from the server with `Realtime.publish()`.

## 0.3.0

### Minor Changes

- f1d2cd5: The production Realtime middleware reconnects with exponential backoff and resubscribes every active channel after an unexpected WebSocket drop. Adds an optional `onReconnect` callback to `SubscribeOptions`, fired once the server confirms a channel's resubscribe after a reconnect.
- de3c17c: Adds an optional `refresh` callback to `SubscribeOptions`. When you provide it, a reconnect calls it first and uses the fresh connect and channel tokens, so a subscription can outlive the token TTLs.

### Patch Changes

- 757d4a9: `@aws-blocks/core` forwards the `x-blocks-user-agent` header that native clients send into the AWS SDK user agent, and exports the `installClientUserAgent` SDK middleware. Kotlin callers are attributed first, and Swift and Dart follow.
- cbedb3c: `publish` accepts messages up to 131,072 bytes, the 128 KiB message quota of API Gateway. Before, it rejected payloads above 32 KiB.
- a23b8d8: **Breaking: a plain `Error` thrown from an API method reaches the client as a generic `500` with `"Internal error"` instead of its raw message.** To send a specific status, name, and message to the client, throw an `ApiError`, for example `new ApiError("Todo not found", 404, { name: "TodoNotFoundException" })`. Building Block errors keep their name and message on the wire.

## 0.2.1

### Patch Changes

- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.
- 6496713: Replaces `registerVpcEndpoint` with `registerVpcGatewayEndpoint` and `registerVpcInterfaceEndpoint`, and reduces `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`.
- 6496713: A Building Block passes its VPC requirements to the `BuildingBlockScope` constructor, and Blocks creates one shared VPC when a block declares `requiresVpc: true` and you bring none. `Database` accepts an optional `subnets` placement for its Aurora cluster.
- 302090a: The local dev server no longer crashes when a WebSocket client resets its connection during the upgrade.

## 0.2.0

### Minor Changes

- 4a830a6: AsyncJob, CronJob, and Realtime attach their resources to a compute resolved at synth, and fail synth with an `UnsupportedCompute` error on anything but a Lambda compute. `@aws-blocks/core` exports `blocksError(name, message)` and `sanitizeConfigKey(id)`.

### Patch Changes

- c45eb92: **Breaking: `BlocksDefaults` gains three required fields, `logRetention`, `throttling`, and `accessLogging`, and the presets now throttle the API stages and replace the shared handler Lambda log group.**

  To upgrade:

  1. Add the three fields to any hand-written literal `BlocksDefaults` object, which is not needed when you spread a `BlocksPresets` preset.
  2. If your app serves above 1000 rps / 2000 burst in production, raise the limit with `defaults: { ...BlocksPresets.production, throttling: { rateLimit, burstLimit } }`.
  3. Delete the old `/aws/lambda/<fn>` log group manually if you want its history gone.

  Sandbox is capped at 200 rps / 400 burst, and Blocks-managed log groups keep events for `ONE_WEEK` in sandbox and `ONE_YEAR` in production.

## 0.1.5

Dependency updates only.

## 0.1.4

### Patch Changes

- 406ba89: Align local Realtime WebSocket message envelopes with the AWS runtime by using `data` for published messages.

## 0.1.3

### Patch Changes

- 5491cae: Connect tokens use a `$connect` suffix, so they cannot be reused as channel subscription tokens. Channel tokens remain valid as connect tokens.

## 0.1.2

### Patch Changes

- ba3bf7b: Adds a `DESIGN.md` to each building-block package that describes its architecture, API surface, mock implementation, and key design decisions. It ships on npm alongside `README.md`.

## 0.1.1

### Patch Changes

- 270c049: Ports documentation from the internal staging repo.
- c0558f3: Minor improvements

## 0.1.0

Initial version
