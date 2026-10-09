# @aws-blocks/bb-kv-store

## 0.3.1

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

## 0.3.0

### Minor Changes

- 20be3f0: fix(bb-kv-store): wire point-in-time recovery from the stack preset and add customer-managed encryption
  
  `KVStore` now honors `defaults.pointInTimeRecovery` (PITR on under `production`, off under `sandbox`) and accepts per-block `pointInTimeRecovery` and `encryption` options — mirroring `DistributedTable`. `encryption: 'customer-managed'` provisions a dedicated CMK, and `KVStore.fromKmsKey(arn)` reuses an existing key across stores. Previously `KVStore` ignored the preset, so production-preset consumers believed PITR was enabled when it was not.
  
  The default encryption now emits the AWS-managed `aws/dynamodb` KMS key (`SSESpecification: { SSEEnabled: true }`), where before no `SSESpecification` was emitted at all (the AWS-owned key). On an already-deployed table this is an in-place SSE change applied on upgrade, and the `aws/dynamodb` key bills per-request KMS charges that the AWS-owned key does not.
  
  **Behavior change on next production deploy of an existing app:** an existing `production`-preset `KVStore` table gains Point-in-Time Recovery in place on the next deploy (an in-place update, no table replacement); continuous backups are billed per GB-month of table size. Separately, passing `removalPolicy`, `deletionProtection`, or `ttl` alongside `fromExisting()` now warns at synth (previously only `pointInTimeRecovery` and `encryption` did), so a pipeline running `cdk synth --strict` will fail until those options are removed from the wrapped-table call.

### Patch Changes

- 5454763: fix(bb-kv-store): align `delete()` conditional detection with the mock and `put()`
  
  The AWS `delete()` path detected the value-equality condition with
  `'ifValueEquals' in conditions` (key presence), while the mock and AWS `put()`
  use `!== undefined`. Two consequences, both mock↔AWS parity breaks:
  
  - `delete(key, { ifValueEquals: undefined })` was a silent no-op on the mock but,
    on AWS, emitted `#value = :expected` with `:expected = JSON.stringify(undefined)`
    (`undefined`) — a DynamoDB DocumentClient marshalling error instead of an
    unconditional delete.
  - The `if/else if` applied only `attribute_exists(#pk)` when both `ifExists` and
    `ifValueEquals` were set, silently dropping the value check — so on AWS the
    item was deleted regardless of its value, while the mock (correctly) required
    both.
  
  `delete()` conditions are now composed conjunctively (`attribute_exists(#pk) AND
  #value = :expected`) with `!== undefined` detection, matching the mock branch-for-
  branch. Added `parity.test.ts` cases asserting the `DeleteCommand` shape for each
  combination (value-only, exists-only, both, none, explicit `undefined` no-op, and
  `null` as a real condition).
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

## 0.2.0

### Minor Changes

- 81609a8: `KVStore.put`: allow `ifNotExists` and `ifValueEquals` to compose.
  
  Previously the two conditional-write options were mutually exclusive — the AWS runtime silently ignored `ifValueEquals` when `ifNotExists` was also set, and the mock rejected the write outright, so passing both was unusable (and the two layers diverged). They now compose with **OR**: the write succeeds when the key is absent **or** its current value matches, and fails only when the key exists **and** the value differs. This is the optimistic "create it, or update it only if unchanged" pattern (`attribute_not_exists(pk) OR value = :expected`). Each option used alone is unchanged.
- 21443ba: fix(data): map optimistic-concurrency conflicts to JSON-RPC 409 (Conflict) instead of 500
  
  Optimistic-concurrency / conditional-write conflicts now surface to clients as
  JSON-RPC error **code 409 (Conflict)** instead of a generic **500**. Previously
  these conflicts were thrown as plain named `Error`s (or re-thrown raw driver
  errors), and the JSON-RPC serializer maps any non-`ApiError` to 500 — so a
  routine, expected conflict was indistinguishable from an internal server error.
  
  Each affected conflict is now an `ApiError` with `status: 409`, so on the client
  `error.status === 409`. The structured `error.name` is preserved end-to-end, so
  `isBlocksError(e, ...)` keeps matching by name on both server and client, and the
  existing typed error constants are unchanged:
  
  - `@aws-blocks/bb-kv-store` — a failed `ifNotExists` / `ifExists` /
    `ifValueEquals` write or delete (`KVStoreErrors.ConditionalCheckFailed`). The
    AWS runtime now also normalizes DynamoDB's raw `ConditionalCheckFailedException`
    on both `put` and `delete`, matching the mock.
  - `@aws-blocks/bb-distributed-table` — a failed `ifNotExists` / `ifExists` /
    `ifFieldEquals` condition (`DistributedTableErrors.ConditionalCheckFailed`),
    in both mock and AWS `put`/`delete`.
  - `@aws-blocks/bb-distributed-data` — a DSQL serialization failure / OCC
    conflict, SQLSTATE `40001` (`DistributedDatabaseErrors.SerializationFailure`),
    in both the mock and real engines.
  - `@aws-blocks/bb-data` — a serializable-isolation conflict, SQLSTATE `40001`
    (`DatabaseErrors.SerializationFailure`), across the PGlite, pg-client, and
    Data API engines.
  
  The `retriable` flag is scoped to genuine optimistic-lock conflicts: it is
  `true` for value/field-equals conflicts (`ifValueEquals` / `ifFieldEquals`) and
  the 40001 serialization failures, and omitted/`false` for existence/uniqueness
  assertions (`ifNotExists`, `ifExists`), where a blind identical retry would fail
  identically. Status (409) and `error.name` are unchanged in every case.
  
  This is a `minor` bump. Every package here is pre-1.0, where `minor` is this
  repo's signal for a change that can alter existing behavior: callers that
  branched on `error.status === 500` for these conflicts (or on the JSON-RPC error
  code) will now see `409`. Code that matches conflicts by name via
  `isBlocksError` — the documented pattern — is unaffected.
  
  `@aws-blocks/core` and `@aws-blocks/blocks` get a `patch` bump for a docs-only
  change: a clarifying sentence was added to the `ApiError.retriable` JSDoc
  (no behavior or API change).

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

## 0.1.8

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

## 0.1.7

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

## 0.1.6

### Patch Changes

- 7b4c62d: Add infrastructure `defaults` chosen once at the app entry point, replacing the per-block `sandboxMode` logic and the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin dance for removal-policy and deletion-protection.
  
  `@aws-blocks/core/cdk` now exports `BlocksDefaults` and the `BlocksPresets.sandbox` / `BlocksPresets.production` starting points. `BlocksStack.create` / `BlocksBackend.create` take a required `defaults` prop; start from a preset and override individual fields with a spread. `defaults` is anchored on the owning `BlocksStack`/`BlocksBackend` (resolved by walking up the construct tree, like `handler`/`executionRole`), so multiple backends in one stack each keep their own posture. Building Blocks read the resolved values via `scope.defaults`, and a per-block option always wins (`option ?? scope.defaults.field`).
  
  Adopted across the stateful Building Blocks: `bb-kv-store`, `bb-data`, `bb-distributed-data`, `bb-distributed-table`, and `bb-knowledge-base` now take their removal policy and deletion protection from `defaults` instead of reading the `sandboxMode` context themselves. (`bb-distributed-table` reads `defaults` directly for now; a richer per-block `protection` override lands with #282.)
  
  The `create-blocks-app` scaffolding templates are updated to pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production` (replacing the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin), so newly-generated apps satisfy the required prop.
  
  **Breaking:** `BlocksStack.create` / `BlocksBackend.create` now require a `defaults` field — pass `BlocksPresets.sandbox` or `BlocksPresets.production` (typically `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`). The previously-shipped experimental `hardening` prop and its `resolve*` helpers are removed; log-retention, API throttling, access-logging and point-in-time-recovery move into `defaults` in follow-up, per-feature changes.
- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-logger@0.1.4

## 0.1.5

### Patch Changes

- b83aaba: Add opt-in TTL support to `KVStore` and use it to expire `AuthCognito` session records.

  `KVStore` gains a `ttl` construct option that enables DynamoDB Time-to-Live on the table, plus per-write expiry via `put(key, value, { ttlSeconds })` or `{ expiresAt }`. Both default to off, so existing tables and every existing `put()` call are unaffected. Because DynamoDB deletes expired items asynchronously, `get` and `scan` also filter expired items on read in every runtime, and the local mock emulates the same expiry semantics. Maintenance sweeps that need to act on rows the reaper has not collected yet can opt out with `scan({ includeExpired: true })`.

  `AuthCognito` now enables TTL on its sessions table and stamps each session write with `now + sessionTtlSeconds`. Session records store live Cognito refresh tokens, so without an expiry the table grew without bound and retained those credentials at rest indefinitely; abandoned sessions are now reaped automatically. Authorization is unchanged — validity is still decided by token revalidation on every request.

  Two things to know before upgrading:

  - **Your next `cdk deploy` enables TTL on the existing sessions table.** Even though this is a patch, `AuthCognito` now passes `{ ttl: true }`, so the deploy issues a one-time `UpdateTimeToLive` against the live table. That is an online, non-disruptive DynamoDB operation — no downtime, no data loss — but it is a mutation of a live resource, so it shouldn't surprise anyone diffing a patch upgrade.
  - **Only sessions written after the upgrade expire.** A missing `ttl` attribute means "never expires" (matching DynamoDB), and existing rows are not backfilled, so sessions created before the upgrade keep their refresh tokens at rest indefinitely. Backfilling would need a one-time migration writing `ttl` onto every existing row. To close the retention gap immediately, revoke the pre-existing sessions instead — the revoke sweep deletes rows regardless of expiry state.

- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [2d3dfdc]
- Updated dependencies [3c56267]
  - @aws-blocks/core@0.1.17
  - @aws-blocks/bb-logger@0.1.3

## 0.1.4

### Patch Changes

- 683bf49: fix(bb-kv-store): discover tests via a glob so the user-agent suite runs

  The `test` script enumerated compiled test files by hand and had drifted from
  the real sources: it ran a non-existent `dist/logger-injection.test.js` (a stale
  leftover) and omitted `dist/user-agent.test.js`, so the user-agent integration
  suite silently never ran in CI — a false green.

  The script now globs `dist/*.test.js` (matching the `bb-email-client` /
  `bb-tracer` idiom and keeping `--test-concurrency=1`), so every compiled test
  file is auto-discovered and the enumerate-and-omit drift is structurally
  impossible. Enabling the user-agent suite surfaced a stale, never-run test that
  expected a custom (non-official) ancestor BB to appear in the user-agent chain;
  per `@aws-blocks/core`'s design only official BB names are emitted, so that test
  was corrected and a case asserting custom names are excluded was added. No
  runtime change to `@aws-blocks/core`.

- Updated dependencies [f42c604]
- Updated dependencies [1da34f1]
  - @aws-blocks/core@0.1.6

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

- 270c049: docs: scrub and port documentation from internal staging repo
- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
