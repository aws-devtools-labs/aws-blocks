# @aws-cdk-blocks/bb-agent

## 1.0.0

The first stable release. The changes since 1.0.0-rc.2 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/bb-agent` 0.x

- The package is now `@aws-cdk-blocks/bb-agent`. Install it in place of `@aws-blocks/bb-agent`, and change the import specifiers.
- be8864c: Check conversation ownership in `stream()`, `resume()`, `getConversation()` and `getPendingInterrupts()`, and scope `getChannel()` to the caller.
- c4e4e67: Scope `inferenceOnly` sessions to the user by default.

### Since 1.0.0-rc.2

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.2

### Patch Changes

- cad7bb8: The Agent on AgentCore Runtime no longer fails every turn with `BLOCKS_RT_CALLBACK_URL not set` after a first deploy. A turn that arrives before the app config file is readable is rejected, so `stream()` throws.

## 1.0.0-rc.1

### Patch Changes

- d380931: `createChat` and `useChat` no longer show the previous turn's answer as the new one when the chat reconnects before a turn has streamed any text. The client keeps waiting for the turn's own chunks.
- e529b00: The README error examples import the error constants and `isBlocksError` from `aws-cdk-blocks`, which works in backend and client code.
- 6b1086b: The `Agent` and `KnowledgeBase` READMEs are corrected and reorganized. Model presets and Bedrock access for `Agent` moved to `MODELS.md`, which ships in the package.

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

### Patch Changes

- 3d7479a: On reconnect, `createChat` and `useChat` end a turn that failed while the chat was disconnected and pass the recorded error to `onError`. They no longer keep loading for about 11 minutes and then report a timeout.
- 36f3720: The stream no longer sends a `tool-call` chunk, or the `tool-result` chunk that follows, for a tool call that the user denied or that `maxToolIterations` stopped. Conversation history is unchanged.
- 3994884: The docs explain why `needsApproval` defaults to `false` and when a tool should set it to `true`.
- d51b8ee: An error thrown by an `untrustedOutput` tool reaches the model inside the same `<untrusted-data>` block as a successful result. Delimiter-shaped text is detected on an NFKC-normalized copy stripped of invisible characters, so lookalike delimiters can't close the block early.
- d01c34c: Adds exports for the types `AgentBase`, `ConversationManagerConfig`, `MessageMetadata`, `GuardrailsConfig`, and `InferenceConfig` in `@aws-cdk-blocks/bb-agent`, `InferMessage` in `@aws-cdk-blocks/bb-realtime`, and `ApiNamespaceConstructor` and `AsyncAPI` in `@aws-cdk-blocks/core`.
- 5f55dac: The user-agent tests name their parent auth block `Auth` instead of `AuthBasic`. No runtime change.
- 6eaa40c: Bedrock's Anthropic use case details refusal is reported as `AgentErrors.ModelUnavailable` when it arrives as `ResourceNotFoundException`, as it does from `ConverseStream` on a new account. It reached clients as `StreamFailed` before.

- 703238f: **Breaking: the scaffolded backend folder is `cdk-blocks/`, not `aws-blocks/`.**

  To upgrade:

  1. Rename the `aws-blocks/` directory to `cdk-blocks/`.
  2. Change the `"workspaces"` entry that names it.
  3. Change the `"name"` in its `cdk-blocks/package.json` to `cdk-blocks`.
  4. Change every `from 'aws-blocks'` import to import `cdk-blocks`.
  5. Rename an `aws-blocks/migrations` directory or set an explicit migrations path, because `DEFAULT_MIGRATIONS_ROOT` is now `./cdk-blocks/migrations`.

  The reserved URL namespace, such as `/aws-blocks/api` and `/aws-blocks/auth/*`, keeps its path, so deployed routes and OAuth callback URLs keep working.

- 9d69412: The docs state that session cookies default to `SameSite=Lax`, that an `inferenceOnly` agent still creates its S3 session bucket, and that `objectLock` can be added to a deployed `FileBucket` as an in-place update.
- 0ff1e1f: The Agent docs describe the installed version. The `useChat` deprecation is stated in the present tense.
- 6d3077e: `Agent`, `AsyncJob`, and `Realtime` compose `KVStore` instead of `DistributedTable`, and a deployed stack updates in place. Every read hides expired job-status records and connection records.
- 42b84b2: Adds `getChannel(namespace, channel, { scope: 'exact' })`, whose token authorizes the channel only and none of its sub-channels. `publish()`, `subscribe()`, and `getChannel()` throw `RealtimeErrors.ValidationFailed` for a channel name that is empty or has an empty, `.`, or `..` segment.
- 8e96367: `bb-agent` reports an unexpected error to the client as `Internal error` instead of the raw backend text, and `bb-email-client` `send()` errors have stable messages per `EmailErrors` code. The message of an `ApiError` or a branded Building Block error still reaches the client unchanged.
- 58817b0: The IAM roles AWS Blocks creates scope every service-principal trust to the stack's account with `aws:SourceAccount` and `aws:SourceArn`. Synth warns about a role your app creates without them, and "Service-principal trust" in the `@aws-cdk-blocks/core` README shows how to resolve it.

## 0.7.0

### Minor Changes

- d1d129f: Adds `untrustedOutput: true` for a tool, so the model treats the result as data, and a `guardrail` option on a Bedrock `ModelConfig` that attaches an Amazon Bedrock guardrail. `ModelConfig.guardrails` is deprecated because no provider ever applied it, and the agent logs a warning when it is set.
- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.
- 1d58d60: Bedrock model-access refusals are reported as `AgentErrors.ModelUnavailable` with a message that explains what to do. `complete()` rejects with `ModelUnavailableException` instead of `StreamFailedException` for these failures and for health-check failures.
- 23fc09f: Add optional inline or live JSON-file canned response dictionaries, with literal phrase matching and verbatim response text while preserving default responses and tool precedence.

### Patch Changes

- 5dc1d98: An `openai-api` model whose `endpoint` is a Bedrock Mantle URL and has no `apiKey` authenticates with the AWS credentials the agent runs with. `OPENAI_API_KEY` is not used for Mantle endpoints.
- 48c35f6: `Agent` reads and writes its session state under the session bucket's real name, which `FileBucket` shortens when the `fullId` is over 63 characters.
- dbe7df6: `realtimeTransport` calls the subscription's `unsubscribe` method on the subscription object. A `subscribe` adapter that returns a class instance no longer throws on cancel.
- 943d405: The `cdk` entry of `@aws-blocks/bb-agent` exports the types that were missing from it, such as `AgentConfig`, `Message`, and `Conversation`, so backend code that imports them type-checks.
- a3969b5: A Building Block runtime method called at the top level of a backend module throws `<Class>.<method>() cannot be called during CDK synth` instead of `TypeError: x is not a function`.
- 48c35f6: The `cdk` and `browser` entry points export the names they were missing, so importing them during `cdk synth` or in a browser bundle no longer fails. The `browser` entries add the error constants `AgentErrors`, `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, and `LoggingErrors`.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 27c35e5: The docs state that `Secret` reads pick up rotated values after `cacheTtlSeconds`, not only on cold start, and that `EmailClient` validates recipient and size limits on AWS too. Other fixes cover the `useChat` anchor, `Pipeline` connection ARN examples, and the `KnowledgeBase` mock's chunking.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.6.0

### Minor Changes

- da6d4c7: **Breaking: shared Blocks resources are scoped to the `BlocksStack` or `BlocksBackend` instead of the enclosing `cdk.Stack`.** An app that embeds a `BlocksBackend` inside a customer `cdk.Stack` and uses realtime or cron sees those resources replaced on upgrade. For realtime, the WebSocket API URL changes and the stack output key changes from `RealtimeWsUrl` to `BlocksRealtimeWsUrl<hash>`, so update scripts that read that output by name. Single-`BlocksStack` apps see no resource replacement.

### Patch Changes

- f8fbc6e: When a deployed `Agent`'s session snapshot cannot be read for a reason other than a missing object, `runAgent` logs the cause's `name`, `httpStatusCode`, and `requestId` at `error` level. The read still fails instead of starting a fresh conversation.
- c20cbfd: The README documents the `Conversation` shape that `listConversations()` returns, and says that `createConversationId()` sets `name` to the conversation's UUID. For bb-auth-basic, the docs say that an app served through the Hosting block is same-origin, so `crossDomain` stays `false`.
- 8f9510a: The README documents the order `getConversation()` returns, the persisted `Message.metadata` shape, the row sequence of a tool-approval turn, and Bedrock model access.
- fbef372: The `Converse`/`ConverseStream` inference requests of the Agent carry the Blocks user-agent chain in `x-amz-user-agent`. Strands joins the chain into one section, so each `aws-blocks/<version>` and `bb/<Name>-<version>` token appears as a substring.
- 3a7eb9e: The `cdk` entry points export the runtime values they were missing, such as `InterruptError` in `@aws-blocks/bb-agent` and `BatchSubmitFailedError` in `@aws-blocks/bb-async-job`. Importing them in a backend file no longer crashes `cdk synth`.
- 023f02c: An internal refactor routes the remaining per-package errors through core's `blocksError`. Two realtime timeout rejections that were unbranded are now wire-safe.

## 0.5.0

### Minor Changes

- 8da1d1f: Adds `createChat({ transport, api })` and `realtimeTransport(...)`, a client streaming API that keeps the same frontend code across runtimes. The `useChat` client hook is marked `@deprecated`, superseded by `createChat`.
- 7c24547: **Breaking: `ChatMessage` from `@aws-blocks/bb-agent/client` is the discriminated union that `createChat` uses, and its `metadata` is no longer `Record<string, any>`.** Narrow by `role` before you read approval metadata, as in `if (m.role === 'approval') m.metadata?.approved`. `useChat.loadConversation` returns `undefined` for non-object metadata on a `user` or `assistant` message.
- de3c17c: Adds an optional `refresh` callback to `UseChatOptions` and `CreateChatOptions`, which the transport calls before each reconnect to get fresh tokens, so a subscription can outlive the token TTLs. `refresh` must resolve to the raw channel descriptor, not a hydrated channel client.
- 9608dce: `createChat`, `realtimeTransport`, and `useChat` survive a mid-turn Realtime WebSocket disconnect and reconnect. `sendMessage` and `respondToInterrupt` reset `loading` and call `onError` when the underlying RPC rejects.

### Patch Changes

- 3fac52c: The Agent's Bedrock SDK clients, `BedrockAgentCoreClient` and `BedrockClient`, send the Blocks user-agent chain like the other Building Blocks.
- 757d4a9: `@aws-blocks/core` forwards the `x-blocks-user-agent` header that native clients send into the AWS SDK user agent, and exports the `installClientUserAgent` SDK middleware. Kotlin callers are attributed first, and Swift and Dart follow.
- a23b8d8: **Breaking: a plain `Error` thrown from an API method reaches the client as a generic `500` with `"Internal error"` instead of its raw message.** To send a specific status, name, and message to the client, throw an `ApiError`, for example `new ApiError("Todo not found", 404, { name: "TodoNotFoundException" })`. Building Block errors keep their name and message on the wire.

## 0.4.1

### Patch Changes

- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.
- 6496713: Replaces `registerVpcEndpoint` with `registerVpcGatewayEndpoint` and `registerVpcInterfaceEndpoint`, and reduces `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`.
- 0385f7e: `UseChatOptions.api.sendMessage` and `resume` are typed to return `Promise<unknown>` instead of `Promise<void>`, so you can pass a backend method that returns an object without a wrapper.
- daf523a: The `useChat` docs have a React example that holds the instance in a `useRef` and cleans up with `chat.destroy()` on unmount.
- 6496713: A Building Block passes its VPC requirements to the `BuildingBlockScope` constructor, and Blocks creates one shared VPC when a block declares `requiresVpc: true` and you bring none. `Database` accepts an optional `subnets` placement for its Aurora cluster.

## 0.4.0

### Minor Changes

- 9111c0c: Adds `maxLlmCalls` and `maxToolIterations` to `AgentConfig`, which cap model and tool calls per turn and both default to `20`. A turn over a cap is cancelled with an `error` chunk, so raise the cap or set it to `false` for agents that need more.
- fe0f04a: The Agent's streaming loop runs on a Bedrock AgentCore Runtime instead of an AsyncJob-triggered Lambda, which lifts the 15-minute per-turn ceiling with no client-facing API change. Deploying adds an AgentCore Runtime and removes the agent's SQS queue.
- 2cb9d74: **Breaking: `structuredOutput` is removed from `AgentConfig`.** The field never did anything, so delete it from your configuration.

### Patch Changes

- d8a3901: Adds two optional tool hints for the local-dev `canned` provider, `cannedExamples` and `cannedTriggers`, and generated placeholder input respects schema `default` values. The canned text responses match on word boundaries, so `"reorder"` no longer returns the order response.
- 4a830a6: AsyncJob, CronJob, and Realtime attach their resources to a compute resolved at synth, and fail synth with an `UnsupportedCompute` error on anything but a Lambda compute. `@aws-blocks/core` exports `blocksError(name, message)` and `sanitizeConfigKey(id)`.

## 0.3.5

### Patch Changes

- 5798492: `AsyncJob` batches SQS messages with a default `batchSize: 10`, up from `batchSize: 1`, and a new `maxBatchingWindowSeconds` option with a default of 5. Set `batchSize: 1` and `maxBatchingWindowSeconds: 0` to opt out.
- 309a236: Data and auth blocks grant permissions to the shared Blocks execution role instead of the handler function. The effective runtime permissions are identical.

## 0.3.4

Dependency updates only.

## 0.3.3

### Patch Changes

- feb5be4: Regenerates the `API.md` report to match the current `BedrockModels` source, with no source or runtime change.

## 0.3.2

### Patch Changes

- c4313cd: A fresh `create-blocks-app` scaffold no longer fails with `ERR_MODULE_NOT_FOUND`. `kysely` is a dependency of `@aws-blocks/data-common`, and `@opentelemetry/api` is a dependency of `@aws-blocks/bb-agent`.
- 997c736: Importing `@aws-blocks/blocks` no longer loads `@strands-agents/sdk`, so an app that doesn't use an agent runs without it installed. Apps that use an Agent block still need `@modelcontextprotocol/sdk` and `@opentelemetry/api` installed.

## 0.3.1

### Patch Changes

- cfe6cb0: The deployed Agent reads and writes snapshots in the function's region. Before, any deployment outside `us-east-1` failed with a cross-region 301 `PermanentRedirect`.

## 0.3.0

### Minor Changes

- 179817f: The `model` field in AgentConfig is optional. When omitted, the agent uses `BedrockModels.BALANCED` for deployment and the canned provider for local development.

## 0.2.1

### Patch Changes

- c6ba244: `AgentStreamResult` serializes to `{ channelId, channel: null }` when returned from API methods. Previously `channel` serialized to an empty object `{}`.

## 0.2.0

### Minor Changes

- ce61bb7: Adds the model presets `BALANCED`, `SMART`, and `FAST`, and deprecates `DEFAULT`, `BUDGET`, and `MICRO`. `DEFAULT` resolves to `BALANCED`, moving from Opus to Sonnet, and `BUDGET` and `MICRO` resolve to `FAST`, moving from Amazon Nova to Claude Haiku, so use the new names.

### Patch Changes

- f946736: `stream()` treats an empty `channelId` as unset and falls back to `conversationId` or a random UUID, so streams no longer share one channel.

## 0.1.3

### Patch Changes

- ba3bf7b: Adds a `DESIGN.md` to each building-block package that describes its architecture, API surface, mock implementation, and key design decisions. It ships on npm alongside `README.md`.

## 0.1.2

### Patch Changes

- 835c425: Documents the `AgentStreamChunk` types and `Message` roles.
- dd07335: The Bedrock health check works with any model ID format, cross-region, global, or foundation model. It tries `GetInferenceProfile` and `GetFoundationModel` in sequence.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements

## 0.1.0

Initial version
