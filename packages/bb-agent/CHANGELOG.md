# @aws-blocks/bb-agent

## 0.6.0

### Minor Changes

- da6d4c7: Scope shared Blocks synth state to the owning backend root (`BlocksStack`/`BlocksBackend`) instead of the enclosing `cdk.Stack`, so two `BlocksBackend`s in one stack — and multiple stacks in one synth — stay independent.
  
  - **Registries** (config, compute, dashboard, tracer, VPC requirements) now key on the backend root, resolved by walking the construct tree (`getBlocksRoot`), not on `cdk.Stack.of(scope)`.
  - **Shared-infra Building Blocks** now provision and dedup their per-backend resources under the backend root: the realtime WebSocket API, the cron scheduler role, and the agent AgentCore runtime grants. Previously a second backend in the same stack could attach to the first's shared infra — most seriously, the agent's Bedrock grants could land on the wrong backend's execution role.
  - **RawRoute** registrations are tagged with their owning backend root; `Hosting` now adds CloudFront behaviors only for routes owned by the backend its distribution fronts, instead of every route in the process-global registry. The per-owner tag also scopes duplicate-route detection, so two backends may register the same method+path.
  - **`Hosting` now registers its origin config against the backend it fronts.** `BLOCKS_PUBLIC_ORIGIN` and `CORS_HOSTING_ORIGINS` are written to the backend named by `props.api`, matching the route-behavior owner — not to `this`, which (when two backends share a stack) resolved via the ambient pointer to the last-created backend and left the fronted backend without its origin config.
  - The config bucket is parented under the resolved backend root rather than read from an ambient process-global, removing a construction-order hazard.
  - **Stack-scoped exceptions — these deliberately keep a stable logical ID.** The app-setting secret bulk-init (`BlocksSecretsBulk`) and the distributed-table GSI manager provider (`BlocksGsiProvider`) stay direct stack children. Both are referenced by existing resources through immutable fields (a SecureString's physical name; a custom resource's `ServiceToken`), so a logical-ID change would force a replacement that CloudFormation either rejects (`ServiceToken` is immutable → failed upgrade) or that silently deletes the SecureString. Keeping them stack-scoped preserves the logical ID; their deploy-time IAM is still scoped (lazily) to only the parameters/tables that register. (Joins the API Gateway account resource as a documented stack-scoped exception.)
  
  **Compatibility.** Single-`BlocksStack` apps (the common case) are byte-identical — no resource replacement. Apps that embed a `BlocksBackend` inside a customer `cdk.Stack` and use **realtime** or **cron** will see those resources re-parent from the stack to the backend construct, which CloudFormation treats as a replacement on upgrade; neither carries persistent data. For realtime specifically, the WebSocket API URL changes and its stack output key changes from `RealtimeWsUrl` to `BlocksRealtimeWsUrl<hash>` — scripts that read that output by name must update. Secret AppSettings and GSI-backed tables are **not** affected (their shared resources stay stack-scoped).

### Patch Changes

- Updated dependencies [e682ba7]
- Updated dependencies [e7e96e6]
- Updated dependencies [6d764f7]
- Updated dependencies [cb0ec01]
- Updated dependencies [2da2fd4]
- Updated dependencies [da6d4c7]
- Updated dependencies [e3e5e22]
- Updated dependencies [f1eb149]
  - @aws-blocks/core@0.7.0
  - @aws-blocks/bb-realtime@0.4.0
  - @aws-blocks/bb-distributed-table@0.2.2
  - @aws-blocks/bb-file-bucket@0.3.1
  - @aws-blocks/bb-logger@0.2.2

## 0.5.0

### Minor Changes

- 8da1d1f: feat(bb-agent): compute-agnostic client streaming API — `createChat` + `realtimeTransport`
  
  Adds a redesigned client streaming surface that hides the runtime behind a single
  transport seam, so the same frontend code works across runtimes:
  
  - `createChat({ transport, api })` — the client API. The common case is one call
    (`chat.sendMessage('Hello')`); subscribe and run are fused so the
    subscribe-before-send race can't surface. The flexible primitives `run()`
    (produce) and `subscribe()` (consume) are exposed for fan-out, observer-only
    attach, and decoupled produce/consume.
  - `realtimeTransport(...)` — the Lambda + Realtime implementation of the
    `ChatTransport` seam. Configure it once; call sites never name the runtime. A
    future runtime supplies a different transport; nothing else on the client changes.
  
  Additive and non-breaking. The `stream()` / `getChannel()` / `resume()` server
  methods are unchanged (the new transport is built on them). Only the `useChat`
  client hook is now marked `@deprecated`, superseded by `createChat`.
- 7c24547: fix(bb-agent): `/client` now exports the discriminated-union `ChatMessage` (BREAKING shape change — flagged for maintainer review)
  
  `@aws-blocks/bb-agent/client` previously shipped its own **flat** `ChatMessage`
  (`metadata?: Record<string, any>`), which shadowed the discriminated union
  `createChat` uses. `/client` now re-exports that union (and `ApprovalMetadata`)
  from the canonical definition, so the two surfaces agree and the behaviour the
  README documents is real at the `/client` entry point.
  
  **Breaking (type-level) for `/client` consumers of `ChatMessage`:**
  
  - `metadata` is no longer `Record<string, any>`. On a `user`/`assistant`
    message it is `Record<string, JSONValue> | undefined`; on an `approval`
    message, narrowing on `role === 'approval'` types it as `ApprovalMetadata`.
  - Code that only reads `id` / `role` / `content` is unaffected. Code that read
    an arbitrary `metadata.<key>` as `any` on an approval message must now narrow
    by `role` first (`if (m.role === 'approval') m.metadata?.approved`). This is
    the no-cast DX the union was introduced for.
  
  **Runtime behaviour change on the deprecated `useChat` hook:**
  
  - `useChat.loadConversation` now projects history through the same metadata
    narrow `createChat.loadConversation` uses: non-object metadata (null, a
    string, an array) on a `user`/`assistant` row now projects to `undefined`
    rather than passing straight through, and an `approval` row's metadata is
    projected into the typed `ApprovalMetadata`. A consumer that relied on a
    non-object `metadata` value surviving on a user/assistant message should read
    the new behaviour here.
  
  Also tightens `UseChatOptions.api.getConversation`'s return `metadata` to
  `unknown` (from `Record<string, any>`), aligning the deprecated hook's adapter
  shape with `createChat`'s `ChatConversationApi`. This widens what an adapter may
  return, so it is not breaking for existing adapters.
- de3c17c: useChat now forwards an optional consumer-supplied `refresh` callback to the Realtime subscription so reconnects mint fresh tokens and survive past the channel/connect token TTLs on long turns. The callback is channel-aware — `refresh?: (channelId: string) => Promise<ChatChannelDescriptor>` — so it re-mints for the channel actually in use rather than one captured at construction.
  
  useChat only holds the channelId plus the consumer's `subscribe` adapter; the channel descriptor is minted inside that adapter, which useChat cannot reach — so it cannot self-mint. `UseChatOptions` accepts the optional `refresh` that useChat binds to the current channelId and forwards to the subscription (as `refresh` on the `ChatSubscribeOptions` object). The transport calls it before each reconnect (never on the initial subscribe) to obtain a freshly-minted connect + channel token, so a subscription can outlive the channel (~1h) and connect (~2h) token TTLs.
  
  The same callback is available on the compute-agnostic surfaces: `CreateChatOptions.refresh` lets `createChat` bind the resolved channelId at the subscribe call site and forward it through the transport to the Realtime channel. `realtimeTransport` exposes it as `ChatTransport.subscribe`'s `opts.refresh`, a pure pass-through that the transport forwards into the Realtime channel's subscribe options while holding no refresh state.
  
  `refresh` must resolve to the RAW channel descriptor (the wire object with `__blocks`/token fields), not a hydrated channel client. Fully backward compatible: when omitted, a reconnect replays the original tokens exactly as before.
- 9608dce: `createChat`/`realtimeTransport` (and `useChat`) now survive a mid-turn Realtime WebSocket disconnect/reconnect and send-path failures.
  
  Long-running agent turns (up to 8h on AgentCore) can outlive API Gateway's WebSocket limits (2h max connection, 10-min idle). Previously the client subscribed once and assumed the socket stayed healthy for the whole turn, so a reconnect gap could swallow the `done` chunk and leave `loading` stuck true, and a rejected/timed-out send (e.g. a 504 cold dispatch) left the spinner hanging with an orphaned empty assistant bubble. `createChat` is the preferred client API; `realtimeTransport` forwards the reconnect callbacks to the channel automatically, so the standard wiring is reconnect-safe with no extra app code. `useChat` (deprecated) retains the same behavior.
  
  - On reconnect, the client re-syncs authoritative state from the database (`getConversation` to recover the final assistant text if the turn completed during the gap; `getPendingInterrupts` to recover a missed interrupt). If the turn is still running, loading is preserved and streaming resumes on the resubscribed channel.
  - `sendMessage` / `respondToInterrupt` (and the `run`/`resume` send path) now reset `loading` and surface `onError` when the underlying RPC rejects, dropping any empty placeholder.
  - A bounded failsafe clears `loading` if no terminal chunk arrives within a window after a reconnect, so the spinner can never hang indefinitely.
  - The `subscribe` seam accepts an options object (`{ onMessage, onDisconnect?, onReconnect? }`) in addition to a bare handler — backward compatible.

### Patch Changes

- 3fac52c: Tag the Agent's Bedrock SDK clients (`BedrockAgentCoreClient` for AgentCore Runtime invocation and `BedrockClient` for the model health check) with the Blocks user-agent chain, matching the other Building Blocks.
- 757d4a9: feat(core): forward the native client user-agent into the AWS SDK user agent
  
  Native runtimes send `x-blocks-user-agent: aws-blocks-<lang>/<version>` on the RPC
  request. `@aws-blocks/core` validates it against a strict grammar (length-capped,
  dropped silently when malformed), carries it per request in an `AsyncLocalStorage`,
  and exports `installClientUserAgent`, an SDK middleware that appends the validated
  token to the outgoing user agent. The 12 participating Building Blocks install it,
  so native attribution rides the SDK user-agent chain AWS service telemetry already
  counts. The Kotlin runtime already sends the header, so Kotlin
  callers are attributed as soon as this ships; Swift and Dart follow.
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
  throw new Error('Todo not found');
  
  // after — status, message, and name all reach the client
  throw new ApiError('Todo not found', 404, { name: 'TodoNotFoundException' });
  ```
  
  Building Block errors (`isBlocksError` / `blocksError`) are unaffected — their name and message continue to cross the wire.
- Updated dependencies [5501cb6]
- Updated dependencies [b58f248]
- Updated dependencies [39628cb]
- Updated dependencies [d4b32f2]
- Updated dependencies [a649895]
- Updated dependencies [27646ac]
- Updated dependencies [1f8a412]
- Updated dependencies [fa0406b]
- Updated dependencies [251aed2]
- Updated dependencies [5515483]
- Updated dependencies [757d4a9]
- Updated dependencies [cbedb3c]
- Updated dependencies [f1d2cd5]
- Updated dependencies [de3c17c]
- Updated dependencies [a23b8d8]
- Updated dependencies [9e02b82]
- Updated dependencies [465a002]
  - @aws-blocks/core@0.6.0
  - @aws-blocks/bb-file-bucket@0.3.0
  - @aws-blocks/bb-distributed-table@0.2.1
  - @aws-blocks/bb-realtime@0.3.0
  - @aws-blocks/bb-logger@0.2.1

## 0.4.1

### Patch Changes

- 5eee114: Add npm keywords for discoverability via `npm search keywords:aws-blocks`
  
  Every published package now carries an npm `keywords` array: the shared `aws-blocks`
  discovery tag plus 2–5 functional keywords describing the package's domain and the
  AWS services it uses (e.g. `realtime`, `websocket`, `pubsub` for `bb-realtime`;
  `ci-cd`, `pipelines`, `deployment` for `pipeline`). Metadata only — no runtime,
  API, or behavior change.
- 6496713: Simplify VPC implementation: replace `registerVpcEndpoint` (instanceof-based) with two explicit methods (`registerVpcGatewayEndpoint` / `registerVpcInterfaceEndpoint`), simplify `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`, and strip persistent test VPC to bare minimum.
- 0385f7e: `useChat`: widen `UseChatOptions.api.sendMessage` and `resume` return types from `Promise<void>` to `Promise<unknown>`.
  
  The natural backend methods return objects (`agent.stream()` → `{ channelId }`, `resume` wrappers → `{ ok: true }`), but `Promise<{ channelId }>` is not assignable to `Promise<void>` (TS2322), which forced customers into an await-and-discard wrapper. `useChat` awaits both calls only for completion and discards the resolved value, so `Promise<unknown>` — assignable-from both object results and `void` — lets natural-shape backends wire up directly while existing `void`-returning backends keep compiling. Type-only change; no runtime behavior change.
- daf523a: docs(bb-agent): add a concrete React `useChat` example
  
  The `useChat` docs only showed the framework-agnostic callback form and warned
  that it is "a factory function, not a React hook — call it once, not on every
  render," without demonstrating the fix. Added a primary React example that holds
  the instance in a `useRef` (created lazily so it survives re-renders), bridges
  `onMessagesChange` / `onLoadingChange` into `useState`, cleans up with
  `chat.destroy()` on unmount, and renders messages plus a send handler — directly
  resolving the "call once" footgun. Included a one-line Next.js note (same
  component, keep the `'use client'` directive) and kept the existing
  framework-agnostic example as the baseline.
- 6496713: feat(core): constructor-forced VPC requirements, lazy VPC, and Database subnet control
  
  Continues the VPC review follow-ups (net-new, unreleased VPC feature).
  
  **Building Blocks declare VPC requirements via the constructor, not a method.**
  `BuildingBlockScope` is no longer abstract: its constructor takes the block's VPC
  requirements (a value, or a callback for values that depend on `fullId`) and
  registers them in a central per-stack registry. This keeps the compile-time
  forcing the previous `abstract getVpcRequirements()` provided — a block can't
  silently omit its requirements — without a standing method on every subclass, and
  gives the framework one place to read, deduplicate, and answer "does anything here
  need a VPC?". All Building Blocks were migrated to pass requirements to `super()`.
  
  **VPC is now a derived resource, not a hard prerequisite.** A block that cannot
  function without a VPC declares `requiresVpc: true`; when one is needed and the
  customer didn't bring their own, Blocks lazily creates a single shared VPC
  (generalizing the create-if-absent behavior `bb-data` already used for Aurora) and
  emits a notice about the NAT cost. Setting `defaults.vpc = { network }` remains the
  bring-your-own override.
  
  **`Database` accepts an optional `subnets` placement.** A CDK-free mirror of
  `ec2.SubnetSelection` (tier as a string, subnets by id) lets you steer where the
  Aurora cluster lands — for a bring-your-own VPC that lacks an isolated tier, or a
  compliance requirement to use specific subnets. Omit it to keep the default
  (prefer isolated, fall back to `private-with-egress`).
- Updated dependencies [2806ae2]
- Updated dependencies [f552ebe]
- Updated dependencies [9aa0814]
- Updated dependencies [012cd89]
- Updated dependencies [5eee114]
- Updated dependencies [d7312f9]
- Updated dependencies [21443ba]
- Updated dependencies [acd1628]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [302090a]
  - @aws-blocks/core@0.5.0
  - @aws-blocks/bb-distributed-table@0.2.0
  - @aws-blocks/bb-file-bucket@0.2.1
  - @aws-blocks/bb-logger@0.2.0
  - @aws-blocks/bb-realtime@0.2.1

## 0.4.0

### Minor Changes

- 9111c0c: feat(bb-agent): cap model and tool calls per turn to bound runaway cost
  
  Adds two per-turn safety caps to `AgentConfig`, both defaulting to `20`:
  
  - `maxLlmCalls` — the maximum number of model (Bedrock) invocations in a single
    turn. Model calls are the unit Bedrock bills for, so this is the most direct
    guard against an agent that loops its reason→act cycle indefinitely; because
    every tool round needs a model call, it transitively bounds tool loops too.
  - `maxToolIterations` — the maximum number of tool calls in a single turn
    (parallel tool batches count each call).
  
  When either cap is exceeded the turn is cancelled and the client receives an
  `error` chunk (so `complete()` rejects) instead of `done`. Both caps are
  enforced with in-loop Strands hooks, so they work identically on every compute
  target with no cross-process signaling.
  
  Behavior change: turns are now capped at 20 model calls and 20 tool calls by
  default. This is generous for a single turn, but agents that legitimately reason
  over many steps or chain many tools must raise `maxLlmCalls` /
  `maxToolIterations`, or set a cap to `false` to disable it. The caps bound call
  *count*, not tokens or wall-clock — pair them with a billing or CloudWatch alarm
  on Bedrock spend for real cost protection.
  
  This is a `minor` bump. Every package here is pre-1.0, where `minor` is this
  repo's signal for a change that can alter existing behavior. The two options are
  new and optional and there's an opt-out (raise the cap, or set it to `false`),
  but the new default changes the runtime behavior of every existing agent — a
  turn that legitimately exceeds 20 model or tool calls is now cut off unless the
  customer opts out — so it ships as `minor` rather than `patch` to surface that
  clearly. The counts cover a whole logical turn: they live in the agent's
  persisted session state, and the per-turn reset is keyed on a turn id applied
  lazily (the session snapshot is restored inside `stream()`, so an up-front reset
  would be overwritten and the budget would leak into the next turn), so a turn
  paused on a human-in-the-loop interrupt keeps its budget across `resume()` while
  a new message always starts a fresh one. A cap value must be a positive integer
  or `false`; anything else throws `InvalidModelConfigException`. The umbrella
  `@aws-blocks/blocks` gets the same bump because it re-exports `AgentConfig`.
- fe0f04a: feat(bb-agent): run the streaming loop on AgentCore Runtime (keeping Realtime)
  
  The Strands agent loop now runs on a **Bedrock AgentCore Runtime** (sessions up to 8h, warm,
  managed) instead of an AsyncJob-triggered Lambda — lifting the 15-minute per-turn ceiling — while
  **keeping the Realtime BB** as the streaming transport, so chunks reach the browser exactly as
  before. `stream()`/`resume()` call `InvokeAgentRuntime`, which starts the turn as a background
  async task and returns immediately (the microVM stays alive via `HealthyBusy` while the loop runs
  and publishes chunks to Realtime as the shared Blocks execution role). Locally the loop still runs
  in-process against the mock Realtime.
  
  - **No client-facing API change:** `stream()`/`resume()`/`getChannel()`, the `chunks` Realtime
    channel, and the `useChat` subscribe contract are unchanged.
  - AgentCore provisioning is self-contained in `AgentCoreRuntime` (co-bundle + `Runtime` via
    `fromCodeAsset`, plus the handler's `InvokeAgentRuntime` permission) so it can later fold into a
    per-BB compute abstraction. The loop runs **as the shared Blocks execution role** (the same role
    the Lambda handler runs as), so it inherits every Building Block's grants (including Realtime
    publish and other BBs an agent's tools touch). `AgentCoreRuntime` adds to that shared role only
    what's AgentCore-specific: the `bedrock-agentcore` assume-role trust (scoped by
    `aws:SourceAccount`/`aws:SourceArn`), Bedrock model access, and the handler's `InvokeAgentRuntime`
    permission — so core stays BB-agnostic and a Realtime-only app never trusts AgentCore.
  - **Removed** the internal AsyncJob (and the `@aws-blocks/bb-async-job` dependency); bumped
    `@strands-agents/sdk` to `^1.7.0` and added `bedrock-agentcore` + `@aws-sdk/client-bedrock-agentcore`.
  
  Deployment note: this changes the deployed infra shape (adds an AgentCore Runtime, removes the
  agent's SQS queue). The runtime is injected the config location (`BLOCKS_CONFIG_BUCKET`/
  `BLOCKS_CONFIG_KEY`, via core's `getConfigLocation()`) so its `loadConfigToProcessEnv()` loads the same
  full app config as the handler — this delivers the Realtime callback URL and any other config-backed BB
  value a tool touches.
- 2cb9d74: refactor(bb-agent): remove inert `structuredOutput` field from `AgentConfig`
  
  `AgentConfig` declared `structuredOutput?: z.ZodType`, but the field was never
  implemented, read, or consumed anywhere — no JSDoc, no consumer, no docs, no
  tests. It advertised a capability that does not exist, so setting it was a silent
  no-op. The declaration is removed (along with its line in the generated
  `API.md` report); no runtime behavior changes, because nothing ever read it.
  
  Structured output remains a planned future LLM-BB feature, tracked separately.
  This change only deletes the dead placeholder surface — it does not add or design
  any real structured-output support.
  
  This is a `minor` bump. Removing a property from an exported interface is a
  breaking change to the public type surface, but every package here is pre-1.0,
  where this repo's convention is that `minor` — not `major` — is the signal for a
  breaking or behavior-altering change (see the `maxLlmCalls`/`maxToolIterations`
  caps, which shipped as `minor` for exactly that reason). Practically the blast
  radius is a compile error only: code that set `structuredOutput` was already
  getting no-op behavior, so the error points at configuration that never did
  anything and the fix is to delete it. The umbrella `@aws-blocks/blocks` gets the
  same bump because it re-exports `AgentConfig`.

### Patch Changes

- d8a3901: Improve the local-dev `canned` provider's tool support with two optional tool hints (ignored by real providers) and schema-default awareness:
  
  - `cannedExamples` — realistic tool input, shallow-merged over generated placeholders instead of the generic `sample` values.
  - `cannedTriggers` — extra keyword phrases that trigger a tool beyond its name (single- and multi-word phrases match on word boundaries, so `'log in'` won't fire on `"backlog in"`; internal whitespace is flexible).
  - Generated placeholder input now respects schema `default` values (from Zod `.default()`).
  
  Also fixes three pre-existing rough edges in the same provider:
  
  - Generated input now resolves `const`, `enum`, and `anyOf`/`oneOf` (Zod union) properties. Previously a property that was a union, a const, or untyped and carried no `default` matched no branch and was dropped — and a *required* field of that shape made the emitted call fail schema validation before the tool ran. A required field of an otherwise unrecognized shape now falls back to a string; optional ones stay omitted, since absence is valid there.
  - The canned *text* responses (`weather`/`order`/`help`) now match on word boundaries like tool matching does, so `"reorder"` no longer returns the order response and `"helper"` no longer returns the help response.
  - A `cannedExamples` key that isn't a field of the tool's schema now logs a one-time warning naming the tool and field, since it is almost always a typo. It never throws and the value is still sent — a bad hint must not break local dev.
  
  Patch (not minor) per the pre-1.0 caret convention — the change is additive and backward-compatible.
- 4a830a6: feat: route event-block resources to their resolved compute
  
  AsyncJob, CronJob, and Realtime now attach their compute-bound resources to a
  compute resolved at synth rather than the stack's shared handler:
  
  - AsyncJob attaches its SQS event source to the resolved compute's function;
  - CronJob points its EventBridge Scheduler target at the resolved compute's function;
  - Realtime binds its shared WebSocket API integrations to the stack's **default**
    compute (its routes are a stack-level singleton) and grants `postToConnection`
    to the shared execution role, so `publish()` works from any compute.
  
  Each block requires a Lambda compute today and fails at synth with a typed
  `UnsupportedCompute` error (assertable via `isBlocksError`) on any other type.
  The check uses a duplicate-copy-safe brand (`LambdaCompute.isLambdaCompute`,
  backed by a `Symbol.for` marker) instead of `instanceof`, so it does not misfire
  when two copies of `bb-lambda-compute` resolve in one dependency tree.
  
  On the default single-Lambda setup the resolved/default compute is the stack's
  default, whose function is the shared handler — so this is non-breaking with no
  change to synthesized infrastructure. AsyncJob also grants SQS send to the shared
  execution role rather than the handler directly.
  
  New public surface (hence `minor`):
  
  - `@aws-blocks/core` exports `blocksError(name, message)` (the producer half of
    the `isBlocksError` contract) and `sanitizeConfigKey(id)` from `./bb-utils`
    (the single env-var-key sanitizer both config writers and runtime readers use).
  - `@aws-blocks/bb-lambda-compute` adds a `./cdk` subpath exposing the CDK-typed
    `LambdaCompute` and its `LambdaCompute.isLambdaCompute` guard.
  - `bb-async-job` / `bb-cron-job` / `bb-realtime` add an `UnsupportedCompute`
    error member.
  
  `@aws-blocks/bb-agent` builds AsyncJob and Realtime internally, so its CDK test
  moves onto the `BlocksStack.create` harness instead of a handler-only stub.
  Test-only change — no runtime behavior change to the Agent.
- Updated dependencies [1b66571]
- Updated dependencies [df667c5]
- Updated dependencies [df667c5]
- Updated dependencies [64ddd74]
- Updated dependencies [df667c5]
- Updated dependencies [646614b]
- Updated dependencies [c45eb92]
- Updated dependencies [8de4a56]
- Updated dependencies [4a830a6]
- Updated dependencies [f2f186c]
- Updated dependencies [46b7c89]
- Updated dependencies [1da58fd]
  - @aws-blocks/bb-file-bucket@0.2.0
  - @aws-blocks/core@0.4.0
  - @aws-blocks/bb-logger@0.1.6
  - @aws-blocks/bb-realtime@0.2.0
  - @aws-blocks/bb-distributed-table@0.1.7

## 0.3.5

### Patch Changes

- 5798492: feat(bb-async-job): batch SQS messages by default, with a configurable batching window
  
  `AsyncJob` triggered its Lambda with `batchSize: 1`, so every queued job cost a
  full invocation. The default is now `batchSize: 10` with a new
  `maxBatchingWindowSeconds` option (0–300, default 5) that trades latency for
  fuller batches. SQS partial batch failure reporting is always enabled, so only
  the failed records of a batch are redelivered.
  
  Both options are now range-checked in the `AsyncJob` constructor, so an
  out-of-range value fails fast at synth time with `InvalidOptionException` naming
  the option instead of surfacing as an opaque CloudFormation error mid-deploy:
  `batchSize` must be 1–10 without a batching window (1–10000 with one), and
  `maxBatchingWindowSeconds` must be 0–300.
  
  Retry semantics are unchanged. SQS tracks `ApproximateReceiveCount` per message
  and partial batch responses redeliver only failed records, so `maxRetries` still
  means "attempts for this message" and the DLQ `maxReceiveCount` keeps its
  meaning at any batch size.
  
  This is a `patch` bump. Every package here is pre-1.0, where a `minor` bump is
  this repo's signal for a breaking change; this change is not breaking — the new
  default is a behavior change with an opt-out (`batchSize: 1` /
  `maxBatchingWindowSeconds: 0`), and both options are new and optional. The
  umbrella `@aws-blocks/blocks` gets the same bump because it re-exports
  `AsyncJob` and `AsyncJobOptions`.
  
  `@aws-blocks/core/cdk` now exports `SHARED_HANDLER_TIMEOUT_SECONDS`, the shared
  handler Lambda's timeout, so resources that must size their own timeouts against
  it stop re-hardcoding `900`.
  
  The main queue's visibility timeout is now `SHARED_HANDLER_TIMEOUT_SECONDS + maxBatchingWindowSeconds`
  seconds instead of a flat `900`. A message becomes invisible when the poller
  receives it, before the batching window elapses and before the handler runs, so
  a flat 900s let SQS redeliver a message whose invocation was still running.
  
  `bb-agent` opts out of the new defaults with `batchSize: 1` and
  `maxBatchingWindowSeconds: 0`. It submits an internal job per interactive agent
  turn (plus a second on HITL resume) and the caller is blocked on that job
  starting, so a batching window would add up to 5s of latency to a human-facing
  path; `batchSize: 1` also keeps one failing turn from sharing a batch with
  others, which matters because the handler is not idempotent. Both the runtime
  and CDK construction sites set the same options so they synthesize an identical
  event source mapping.
- 309a236: refactor(bb): attach IAM grants to the shared execution role
  
  Data and auth blocks now grant permissions to the shared Blocks execution role
  (`this.executionRole`) instead of the handler function directly. Grants land on
  the same role the handler assumes, so the effective runtime permissions are
  identical — this decouples IAM wiring from the concrete Lambda function ahead of
  the multi-compute model.
  
  For `bb-distributed-data`, the DSQL endpoint and region now flow through the
  config registry (loaded into `process.env` at cold start, like every other
  block) rather than being set as direct handler environment variables, and the
  migration Lambda maps the shared execution role's ARN.
- Updated dependencies [5798492]
- Updated dependencies [ca8cfb6]
- Updated dependencies [08ab129]
- Updated dependencies [f00adb0]
- Updated dependencies [f00adb0]
- Updated dependencies [309a236]
- Updated dependencies [08ab129]
- Updated dependencies [9d4ccea]
- Updated dependencies [5bfae0a]
- Updated dependencies [0ac3879]
- Updated dependencies [e4dac4a]
  - @aws-blocks/core@0.3.0
  - @aws-blocks/bb-async-job@0.1.5
  - @aws-blocks/bb-distributed-table@0.1.6
  - @aws-blocks/bb-file-bucket@0.1.5
  - @aws-blocks/bb-realtime@0.1.5
  - @aws-blocks/bb-logger@0.1.5

## 0.3.4

### Patch Changes

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [406ba89]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-distributed-table@0.1.5
  - @aws-blocks/bb-realtime@0.1.4
  - @aws-blocks/bb-async-job@0.1.4
  - @aws-blocks/bb-file-bucket@0.1.4
  - @aws-blocks/bb-logger@0.1.4

## 0.3.3

### Patch Changes

- feb5be4: Regenerate the API report to match the current `BedrockModels` source (the committed `API.md` had drifted from the model-id constants). No source or runtime change.
- Updated dependencies [5b2aede]
- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [bd59e60]
- Updated dependencies [f583c75]
- Updated dependencies [2d3dfdc]
- Updated dependencies [3c56267]
  - @aws-blocks/bb-distributed-table@0.1.4
  - @aws-blocks/core@0.1.17
  - @aws-blocks/bb-file-bucket@0.1.3
  - @aws-blocks/bb-async-job@0.1.3
  - @aws-blocks/bb-logger@0.1.3

## 0.3.2

### Patch Changes

- c4313cd: Fix `ERR_MODULE_NOT_FOUND` on a fresh `create-blocks-app` scaffold by making required runtime packages real dependencies of the block that actually loads them. npm does not install peer dependencies of transitive dependencies, so these never landed in `node_modules`.

  - `kysely` → dependency of `@aws-blocks/data-common`. `data-common` is the only package that imports and instantiates `kysely` (in its Kysely adapter); `bb-data` and `bb-distributed-data` merely re-export `createKyselyAdapter` and keep `kysely` as a peer, which is now satisfied transitively via `data-common`. Promoting it on `data-common` alone guarantees a single hoisted instance and installs it for any app that pulls a data block.
  - `@opentelemetry/api` → dependency of `@aws-blocks/bb-agent`. It is a non-optional peer of `@strands-agents/sdk`, which the Agent block loads at runtime, so it must be installed whenever `bb-agent` is present.

  Both packages have zero runtime dependencies and no install scripts, so this adds no transitive tree.

- 997c736: Lazy-load the Strands SDK in the Agent block so that importing `@aws-blocks/blocks` no longer eagerly loads `@strands-agents/sdk` and its non-optional `@modelcontextprotocol/sdk` / `@opentelemetry/api` peers.

  The `@aws-blocks/blocks` umbrella re-exports `Agent` statically, so a fresh scaffold that never instantiates an agent previously failed on the first `npm run dev` with `ERR_MODULE_NOT_FOUND` for those packages. The Strands runtime is now imported on first agent execution (via a cached dynamic `import()`), so it stays off the module **load path** of apps that don't use an agent — those apps run without the packages installed.

  Scope / follow-up: this removes the packages from the _load path_, not from the _install set_. Apps that actually use an Agent block still need `@strands-agents/sdk`'s non-optional peers (`@modelcontextprotocol/sdk`, `@opentelemetry/api`) installed, because Strands imports them when it loads on first agent execution and npm does not auto-install peers of transitive dependencies. Those are supplied to agent-using apps by the Agent scaffold template (and documented for manual installs) rather than promoted to `dependencies` here, which would pull Strands' ~10 MB transitive tree into every app. No public API change.

## 0.3.1

### Patch Changes

- cfe6cb0: fix(bb-agent): use the Lambda execution region for S3Storage (#120)

  The deployed Agent constructed Strands' `S3Storage` without a `region`, so it defaulted to `us-east-1` and hard-pinned the snapshot S3 client there. Because the session bucket is created in the deploy region, any deployment outside `us-east-1` failed snapshot reads/writes with a cross-region 301 `PermanentRedirect`. `S3Storage` is now constructed with `region: process.env.AWS_REGION` — which the Lambda runtime always sets to the function's region — so snapshots resolve against the correct regional endpoint. `region` and `s3Client` are mutually exclusive in `S3StorageConfig`, so only `region` is passed.

## 0.3.0

### Minor Changes

- 179817f: feat(bb-agent): make model config optional, default to BedrockModels.BALANCED

  The `model` field in AgentConfig is now optional. When omitted, the agent
  defaults to `BedrockModels.BALANCED` for deployment and the canned provider
  for local development.

### Patch Changes

- Updated dependencies [e839301]
  - @aws-blocks/core@0.1.10

## 0.2.1

### Patch Changes

- c6ba244: fix(bb-agent): add toJSON() to AgentStreamResult

  `AgentStreamResult` now serializes to `{ channelId, channel: null }` when returned from API methods. Previously `channel` serialized to an empty object `{}`; it is now explicitly `null` to signal it is server-side only.

## 0.2.0

### Minor Changes

- ce61bb7: refactor(bb-agent): capability-based model presets with global inference profiles

  New presets:

  - `BALANCED` (Claude Sonnet 4.6): recommended default for most workloads
  - `SMART` (Claude Opus 4.8): highest capability for hardest tasks
  - `FAST` (Claude Haiku 4.5): lowest latency

  All presets use `global.` inference profiles for region-agnostic deployment.

  Deprecated (non-removing): `DEFAULT` resolves to `BALANCED`, `BUDGET` and `MICRO` resolve to `FAST`. Note this changes the underlying model for existing callers — `DEFAULT` moves from Opus to Sonnet, and `BUDGET`/`MICRO` move from Amazon Nova Pro/Lite to Claude Haiku, so cost and latency profiles differ. The symbols still resolve (no type break), but migrate to `BALANCED`/`FAST` (or a region-scoped profile) explicitly to pin the model you want.

### Patch Changes

- f946736: fix(bb-agent): treat empty channelId as unset in stream()

  An empty `channelId` now falls back to `conversationId` or a random UUID, preventing all streams from sharing the same channel. Empty strings are treated as unset rather than used literally.

## 0.1.3

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
  - @aws-blocks/bb-async-job@0.1.2
  - @aws-blocks/bb-distributed-table@0.1.3
  - @aws-blocks/bb-file-bucket@0.1.2
  - @aws-blocks/bb-logger@0.1.2
  - @aws-blocks/bb-realtime@0.1.2

## 0.1.2

### Patch Changes

- 835c425: docs(bb-agent): document AgentStreamChunk types and Message roles
- dd07335: fix(bb-agent): simplify Bedrock health check to support all inference profile formats

  Removed the prefix regex that determined whether to call `GetInferenceProfile`
  or `GetFoundationModel`. The health check now tries both APIs sequentially —
  any model ID format (cross-region, global, or foundation model) works without
  maintaining a prefix allowlist.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-distributed-table@0.1.1
  - @aws-blocks/bb-file-bucket@0.1.1
  - @aws-blocks/bb-realtime@0.1.1
  - @aws-blocks/bb-async-job@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
