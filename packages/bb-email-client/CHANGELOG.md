# @aws-blocks/bb-email-client

## 0.1.9

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
  - @aws-blocks/bb-logger@0.2.2

## 0.1.8

### Patch Changes

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
- Updated dependencies [5515483]
- Updated dependencies [757d4a9]
- Updated dependencies [a23b8d8]
- Updated dependencies [9e02b82]
- Updated dependencies [465a002]
  - @aws-blocks/core@0.6.0
  - @aws-blocks/bb-logger@0.2.1

## 0.1.7

### Patch Changes

- 5eee114: Add npm keywords for discoverability via `npm search keywords:aws-blocks`
  
  Every published package now carries an npm `keywords` array: the shared `aws-blocks`
  discovery tag plus 2–5 functional keywords describing the package's domain and the
  AWS services it uses (e.g. `realtime`, `websocket`, `pubsub` for `bb-realtime`;
  `ci-cd`, `pipelines`, `deployment` for `pipeline`). Metadata only — no runtime,
  API, or behavior change.
- 6496713: Simplify VPC implementation: replace `registerVpcEndpoint` (instanceof-based) with two explicit methods (`registerVpcGatewayEndpoint` / `registerVpcInterfaceEndpoint`), simplify `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`, and strip persistent test VPC to bare minimum.
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
  - @aws-blocks/bb-logger@0.2.0

## 0.1.6

### Patch Changes

- Updated dependencies [df667c5]
- Updated dependencies [df667c5]
- Updated dependencies [64ddd74]
- Updated dependencies [df667c5]
- Updated dependencies [646614b]
- Updated dependencies [c45eb92]
- Updated dependencies [4a830a6]
- Updated dependencies [f2f186c]
- Updated dependencies [46b7c89]
- Updated dependencies [1da58fd]
  - @aws-blocks/core@0.4.0
  - @aws-blocks/bb-logger@0.1.6

## 0.1.5

### Patch Changes

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
- Updated dependencies [f00adb0]
- Updated dependencies [f00adb0]
- Updated dependencies [08ab129]
- Updated dependencies [9d4ccea]
- Updated dependencies [5bfae0a]
- Updated dependencies [0ac3879]
- Updated dependencies [e4dac4a]
  - @aws-blocks/core@0.3.0
  - @aws-blocks/bb-logger@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-logger@0.1.4

## 0.1.3

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
  - @aws-blocks/bb-logger@0.1.2

## 0.1.2

### Patch Changes

- 18880ff: Minor test improvements
- Updated dependencies [18880ff]
  - @aws-blocks/core@0.1.2

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
