# @aws-blocks/blocks

## 0.9.0

### Minor Changes

- 0765f84: feat(core): run an API namespace on its own compute

  `ApiNamespace` takes an optional fourth argument, `{ compute }`, that runs the
  namespace's methods on a `Compute` instead of the app's default compute — for
  example to give one namespace more memory (and CPU) or its own scaling:

  ```ts
  import { ApiNamespace, Compute } from "@aws-blocks/blocks";

  const reportsCompute = new Compute(scope, "reports", {
    type: "serverless",
    memory: 4096,
  });

  export const reports = new ApiNamespace(
    scope,
    "reports",
    (context) => ({
      async build(month: string) {
        // …
      },
    }),
    { compute: reportsCompute },
  );
  ```

  - Clients are unchanged: the TypeScript client, and the Swift, Kotlin and Dart
    clients from `aws-blocks-swift` 0.2.0, `aws-blocks-kotlin` 0.3.0 and the matching
    Dart `blocks_runtime`, call `POST /aws-blocks/api/reports`, and the stack's
    shared API gateway routes that path to the namespace's compute — on every
    `apiFrontDoor` tier and behind `Hosting`, so the API keeps one domain. Calls to
    the bare `/aws-blocks/api` endpoint — raw HTTP calls and older native clients —
    still run on the default compute.
  - API calls stay capped at ~29 seconds by the gateway whatever the compute's
    `maxTimeoutSeconds`; run longer work in an `AsyncJob`.
  - Routing follows the export name (what the frontend imports), not the second
    `ApiNamespace` argument.
  - One `Compute` can host several namespaces and `AsyncJob`s; they then run in
    the same function.
  - Only `serverless` computes can serve API namespaces for now; a `container`
    compute is a type error.
  - Namespaces without a `compute`, `RawRoute`s and auth routes stay on the
    default compute. In local dev every namespace still runs in the dev server.
  - A `compute` created in a different `BlocksBackend` can't serve this backend's
    API: synth warns, and the namespace runs on this backend's default compute.

- 5572341: feat(core): `apiWaf` puts AWS WAF in front of the backend API

  `BlocksStack` and `BlocksBackend` take an `apiWaf` prop. It is off by default.

  - **`{ enabled: true, rateLimit? }`** creates a web ACL with the AWS managed Common rule set and Known Bad Inputs rule set, plus a per-IP rate limit (default 1000 requests per 5 minutes). The Common rule set's body rules (8 KB size, cross-site scripting, local and remote file inclusion) are set to count, so ordinary RPC payloads, including user-written HTML or Markdown, aren't blocked.
  - **`{ webAclArn }`** attaches a web ACL you already have instead. Synth checks that its scope and region match where it attaches.

  The web ACL attaches to whichever front door clients use. Under `apiFrontDoor: 'apigateway'` it is a REGIONAL web ACL on the API Gateway stage, in any region, even when `Hosting` fronts the API. If a CloudFront `Hosting` claims the API, its requests carry a marker header that the rate rule exempts, so browser users behind one CloudFront edge aren't counted as one client. Behind any other `Hosting` door the rate rule is left off and synth warns. Under `apiFrontDoor: 'cloudfront'` it is a CLOUDFRONT web ACL on the managed distribution. AWS only creates those in us-east-1, so in any other region pass `webAclArn` of a web ACL created there. Under `'cloudfront'`, when a CloudFront-backed `Hosting` fronts the API, `apiWaf` creates nothing and synth warns you to set the WAF on Hosting. `bb-realtime`'s WebSocket API isn't covered: AWS WAF can't attach to API Gateway WebSocket APIs.

- 88747f5: feat: Building Block mock entries fail closed in a deployed environment

  - **Runtime guard.** `@aws-blocks/core/bb-utils` exports `assertNotMockInDeployedEnv(bbName)`, the runtime counterpart of the `--conditions=cdk` synth check. It throws when a Building Block's mock (`default` export) entry is loaded in a deployed environment, which happens when the backend was bundled without the `aws-runtime` export condition. A deployed environment is detected from `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY`, which Blocks sets on every compute it provisions (Lambda, container, AgentCore). On compute Blocks doesn't configure, the check is inert and the `aws-runtime` bundler condition is the only protection. It is a no-op in local dev and tests.
  - **Wired into every BB mock entry.** Each Building Block's mock entry calls the guard at module load, so a mis-bundled artifact throws instead of running in-memory stubs: at process start on container and AgentCore computes, and on the first invocation on Lambda (where the backend is imported lazily, so the deploy succeeds and requests then return an error).
  - **AuthOIDC mock cookie secret.** The mock runtime's cookie-signing secret is now random per project instead of a fixed string, persisted (mode 0600) under the instance's `.bb-data/` mock data dir so local sessions survive backend reloads and dev-server restarts. Local sign-in is unchanged.
  - **Bundler conditions.** The `@aws-blocks/hosting` handler bundle and the AuthOIDC IdP-registration and DistributedTable GSI-manager Lambda bundles now pin the `aws-runtime` condition. The hosting bundle uses `['aws-runtime', 'module']` so esbuild keeps preferring packages' ESM builds.
  - **Scaffold template.** `@aws-blocks/create-block`'s primitive template calls the guard in its mock entry and depends on an `@aws-blocks/core` range that exports it.
  - **Docs.** `docs/guides/extending-with-existing-aws-resources.md` documents configuring your own bundler (esbuild, webpack) or unbundled Node (`--conditions=aws-runtime`) with the `aws-runtime` condition when deploying to a compute target Blocks doesn't own, and adds the guard call to the BB-author checklist.

  Maintainer note: these are `minor` bumps because AWS Blocks is pre-1.0, where `minor` is the channel for behavior changes — mock entries that previously ran in a deployed environment now throw.

- 1076ccc: fix(core): warn at synth when a durable stack disables API Gateway access logging

  A synth-time warning now fires on every durable (non-`DESTROY` removal policy)
  stack that has API Gateway access logging disabled — this includes the default
  `BlocksPresets.production` posture, where `accessLogging` is off by default. The
  warning id is `blocks:apigateway:access-logging-disabled`.

  Because it is a warning, ordinary `cdk synth`/`deploy` still succeed, but
  `cdk synth`/`deploy --strict` treat warnings as errors and fail until you either
  opt in or acknowledge it.

  Opt in by setting `accessLogging: true` in the backend's `defaults` (this also
  turns on S3 server access logging for any FileBucket, each getting its own log
  bucket). To keep it off deliberately, acknowledge the warning on the stack or
  backend returned by `create()`, after it resolves:

  ```ts
  const backend = await BlocksBackend.create(stack, "Blocks", {/* … */});
  Annotations.of(backend).acknowledgeWarning(
    "blocks:apigateway:access-logging-disabled",
  );
  ```

  Acknowledging on the `App` before `create()` does not suppress it.

- 928c48a: fix(bb-auth-oidc): `cognitoFederated()` registers the deployed app's callback and sign-out URLs on the Cognito app client

  The Cognito app client used to register only an `https://localhost` placeholder, so Cognito's `/oauth2/authorize` answered `redirect_mismatch` for a deployed app before any identity provider was contacted. The app client now registers, resolved at synth:

  - the app's public origin (`BLOCKS_PUBLIC_ORIGIN` — the CloudFront distribution, primary custom domain, HTTPS ALB or stacked door, or the managed `apiFrontDoor: 'cloudfront'` distribution) plus the callback path;
  - the shared API Gateway URL (stage included) plus the callback path, used when no front door publishes a public origin;
  - `http://localhost:3000` plus the callback path, in sandbox mode only.

  Sign-out URLs list the same origins. Only an `https://` public origin is registered, since Cognito accepts `http://` only for `localhost`; a plain-`http://` one (an ALB door without a certificate) is left out and synth emits an `@aws-blocks/bb-auth-oidc:PlainHttpPublicOrigin` warning, because federated sign-in through that door needs HTTPS.

  New `cognitoFederated()` options `additionalCallbackUrls` and `additionalLogoutUrls` register URLs that can't be derived at synth — browser PKCE SPA redirect pages, native-app custom schemes used as a direct sign-in redirect, custom-domain names other than the primary one, or a sandbox dev server on another port. Entries from every `cognitoFederated()` provider are merged and de-duplicated. Each entry is validated at synth, which fails with a descriptive error naming the URL and the option for an entry that isn't a well-formed redirect URL: surrounding whitespace or control characters, a backslash, userinfo (`@`) in the host, a missing, wildcard or non-ASCII host, a plain-`http://` URL whose host isn't `localhost`, a `javascript:`, `data:`, `file:`, `vbscript:`, `blob:` or `about:` scheme, a `#` fragment, or a `code` / `state` query parameter. Native custom schemes such as `myapp://auth/callback` are accepted; the relay flow does not need one registered, since its `redirect_uri` is the backend's HTTPS callback.

  `@aws-blocks/core/cdk` exports two read-only helpers for first-party Building Blocks (marked `@internal`, not a stability-guaranteed API): `getRegisteredConfigValue(scope, key)` reads a value registered with `registerConfig`, and `getSharedGatewayUrl(scope)` returns the shared REST API's base URL. Both read at call time, so call them from a `cdk.Lazy` producer when the value is registered or built after the Building Block is constructed.

  **Upgrading:** the app client's callback and sign-out URLs are now managed by the Building Block. If you added URLs to the Cognito app client outside of CDK (for example, in the console as a workaround for #1001), those manual entries are replaced on the next deploy. Add any URLs you still need through `additionalCallbackUrls` / `additionalLogoutUrls` so they are kept.

- 4d5ea86: feat(auth-oidc): limit `stubIdp()` providers to local development and sandbox deployments

  Behavior change (0.x minor = breaking channel): stacks that configure `stubIdp()` outside a sandbox now fail at synth, and deployed compute serves the stub IdP routes only in a sandbox.

  - **AuthOIDC.** `stubIdp()` providers are now limited to local development and sandbox deployments. Synth fails when a non-sandbox stack configures a `stubIdp` provider, and deployed compute mounts the stub IdP routes only when the deployment is a sandbox. Stub authorization codes are now signed with a key derived from each instance's cookie-signing secret.
  - **Core.** Adds `getDeploymentType()` (`'local' | 'sandbox' | 'production'`) and the `DeploymentType` type, and propagates the deployment type to runtime as `BLOCKS_DEPLOYMENT_TYPE` so an app can select providers consistently at synth and runtime. Also exports `getCachedConfigValue(key)`, which reads the loaded deployed config without the `process.env` override that `getConfigSync()` applies. `@aws-blocks/core/cdk` also exports `isSandboxContext(scope)`, which reads the `sandboxMode` CDK context.
  - **DistributedTable.** Sandbox detection now uses `isSandboxContext()`, so a boolean `sandboxMode: true` CDK context (for example from `cdk.json` or `setContext`) is treated as a sandbox, in addition to the string `'true'`. This applies to the sandbox-only GSI management permissions and the GSI manager's sandbox mode.

  To keep a stub provider for local and sandbox while using a real provider elsewhere, select providers by deployment type:

  ```ts
  import {
    AuthOIDC,
    google,
    stubIdp,
    getDeploymentType,
  } from "@aws-blocks/blocks";

  const providers =
    getDeploymentType() === "production"
      ? [google({ clientId, clientSecret })]
      : [stubIdp({ name: "google" })];

  new AuthOIDC(app, "auth", { providers });
  ```

  Migration: restart `npm run sandbox` once after upgrading. Its initial full deploy writes `BLOCKS_DEPLOYMENT_TYPE` into the deployed config; a `cdk watch` hotswap alone does not, and the stub IdP routes return 404 until that full deploy runs.

- 1d58d60: Report Bedrock invoke-time model-access refusals as `AgentErrors.ModelUnavailable` with an actionable message. When Bedrock refuses a model because the account has not submitted Anthropic's one-time use case details, has not activated the model's one-time AWS Marketplace subscription, or is not entitled to the model, the `error` chunk now carries a message explaining what to do plus an optional `errorName` field, and the `onError` callbacks of `createChat` and `useChat` receive the branded error as an optional `cause` argument. Error chunks without `errorName` behave as before. `complete()` now rejects with `ModelUnavailableException` (instead of `StreamFailedException`) for these failures and for health-check failures, and the persisted error row's `metadata` records the same `errorName`. The README now explains that the Bedrock presets are Anthropic models that need the one-time use case details form and AWS Marketplace subscription, replacing the outdated "enable model access" guidance.
- 7114399: **Breaking (behavior):** `Database` now reports request errors as named 4xx errors instead of a generic 500 `QueryFailed`, on the local (PGlite), `pg` and Data API engines:

  | Postgres error                                         | SQLSTATE | Error                                | HTTP status |
  | ------------------------------------------------------ | -------- | ------------------------------------ | ----------- |
  | Row-level-security rejection, or no grant for the role | `42501`  | `DatabaseErrors.PermissionDenied`    | 403         |
  | Check constraint                                       | `23514`  | `DatabaseErrors.CheckViolation`      | 400         |
  | Not-null constraint                                    | `23502`  | `DatabaseErrors.NotNullViolation`    | 400         |
  | Foreign key                                            | `23503`  | `DatabaseErrors.ForeignKeyViolation` | 409         |

  Match them with `isBlocksError(e, DatabaseErrors.PermissionDenied)` and so on, on the server or the client. Each carries a fixed message; the driver text stays on the server as `cause`. None is retriable.

  If your code matched these failures with `isBlocksError(e, DatabaseErrors.QueryFailed)`, or treated them as server errors because their status was 500, match the new names instead.

  `withRLS()` on PostgreSQL 16 and later (including Aurora) also needs the database user to be a member of the RLS roles: add `GRANT authenticated TO CURRENT_USER;` (and the same for `anon`) to your migrations. If the role switch is refused, `withRLS()` fails with a 500 `QueryFailed` and the server log names the missing grant.

- 92909f8: **Breaking (behavior):** `withRLS({ userId, role, claims })` no longer lets `claims` override `sub` or `role` in `request.jwt.claims`. `sub` always comes from `userId` and `role` from `role`, so an RLS policy that reads either claim sees the server-derived value. Any other claims still pass through.

  If you relied on `claims.sub` or `claims.role` to change those values, pass the intended value as `userId` or `role`, or put it under a different claim name.

- 33edca2: Re-export `submitAuthAction` from the umbrella `@aws-blocks/blocks/ui` entry point, alongside the existing `Authenticator`, `AuthenticatedContent`, `AccountMenuBar`, `onAuthChange`, and `broadcastAuthChange` exports. Consumers building a custom auth UI on `@aws-blocks/blocks` can now import the helper that pairs `setAuthState` with the local auth notification — so `onAuthChange` subscribers and `AuthenticatedContent` re-render on a real signed-in/signed-out transition — without reaching into `@aws-blocks/auth-common` directly. Relates to #185; addresses #208 review feedback.
- 48c35f6: feat(core): Node clients resend a call once when the connection closes before the response headers arrive (at-least-once delivery); `retryStaleConnection: false` opts out

  In Node (CLIs, SSR servers, scripts), an API call made after a few idle seconds could fail with `TypeError: fetch failed` (cause `other side closed`, `ECONNRESET` or `EPIPE`) when the deployed API had closed the pooled keep-alive connection just as the call was sent. The typed client now resends such a call once on a new connection, but only when `fetch` failed before the response headers arrived, with `TypeError: fetch failed` whose cause is an undici socket error (`UND_ERR_SOCKET`, for example `other side closed`), `ECONNRESET` or `EPIPE`.

  **This makes delivery at-least-once.** In the idle-close race the first copy never reached your method. But Node's `fetch` doesn't say whether the connection was a reused one, so the same failure on a fresh connection is resent too, including a server that read the request and crashed before answering: in that rare case a method runs twice. Behind API Gateway or CloudFront a crashed backend answers with a 5xx, which is never retried. Keep state-changing methods idempotent where a duplicate would matter, or pass `retryStaleConnection: false` to `ApiNamespaceClient` (or to the generated `generateClient`) for at-most-once delivery. Timeouts, aborts, failures after the response headers arrived (while reading the body), and HTTP or JSON-RPC errors are still never retried. Browser behaviour is unchanged (browsers already resend in this case).

- 9a32674: fix(core): enforce TLS, enable versioning, and add access logging on the config bucket

  The shared config bucket (`BlocksConfigBucket`, holding `blocks-config.json`) now sets `enforceSSL: true` (a bucket policy denying non-TLS access), `versioned: true` (making the pre-existing noncurrent-version expiration rule effective, so an overwritten config stays recoverable for ~24h before the 1-day noncurrent expiry removes it), and delivers S3 server access logs to a new dedicated, locked-down log bucket. Because `blocks-config.json` is derived from the CDK app, the durable way to restore a prior config is to redeploy; the ~24h window is only a short in-transit safety net. The log bucket resolves its removal policy and log-retention from the stack `defaults` (production ⇒ RETAIN + 365-day expiry, sandbox ⇒ DESTROY + 7-day expiry), so production access logs are not torn down with the stack. Every stack now synthesizes an additional log bucket + bucket policy + versioning config.

  Note: enabling bucket versioning is one-way — S3 can only move a versioned bucket to Suspended, never back to unversioned — so reverting this change leaves the config bucket in the Suspended state rather than unversioned.

- 4553866: feat(core): opt-in permissions boundary on every role AWS Blocks creates, plus a synth-time IAM report

  - **`defaults.permissionsBoundary`** (new, optional) attaches an IAM permissions
    boundary to every IAM role AWS Blocks creates: the shared execution role,
    block-owned helper roles, the CDK custom-resource roles blocks cause, and
    `Hosting`'s roles. That includes the Lambda@Edge and CloudFront-monitoring
    roles in the separate `us-east-1` stacks and the cross-region-reference
    provider roles, which CDK's own `@aws-cdk/core:permissionsBoundary` context
    doesn't reach. Pass a policy name, a full policy ARN, or an `iam.IManagedPolicy`:

    ```ts
    defaults: { ...BlocksPresets.production, permissionsBoundary: 'my-app-boundary' }
    ```

    A boundary is a ceiling; it never grants. It's unset in both presets, and
    leaving it unset keeps synthesized templates unchanged. When both this option
    and the CDK context are set, this option wins for Blocks-created roles and
    synth warns.

  - **IAM report:** every synth now writes `cdk.out/<stack>.blocks-iam.json`
    (`<stack>.<backendId>.blocks-iam.json` for an embedded `BlocksBackend`). It
    lists every statement on the shared execution role, the managed policies, the
    boundary, and the Building Blocks each statement's resources belong to, plus
    an inventory of every IAM role AWS Blocks created with its boundary and tags as
    the template carries them. The file is sorted and deterministic, so CI
    (continuous integration) can diff it between builds or check every role's
    boundary and tags. It doesn't change the CloudFormation template. The file is
    written on every synth, whether or not a permissions boundary is set.
  - **Shared multi-app accounts:** the core README has a new section on running
    many apps in one AWS account: an example boundary policy that uses
    attribute-based access control (`${aws:PrincipalTag/app}`) so one policy
    serves every app, the deploy-role conditions that make the boundary
    mandatory, and the limits of the approach.

- 48c35f6: feat(core): refuse to synth when a renamed or removed Building Block would take a stateful resource with it

  Some Building Blocks commit a baseline file per instance under
  `aws-blocks/baselines/<stack>/` to refuse destructive changes at synth. When
  such a block was renamed or removed, nothing read its baseline any more, so
  CloudFormation could delete the resource it guarded with no warning.

  Every `BlocksStack` and `BlocksBackend` now checks its own baseline directory
  at synth, even when no instance of the block is left: a baseline that records a
  stateful resource and that no block in the stack claims fails synth, naming the
  block and what CloudFormation would delete. Restore the block's old id, or
  re-baseline deliberately with the block's re-baseline variable set to that
  block's id (which deletes the stale file). Apps without baseline files are
  unaffected.

  This is a minor release because it defines a new file format that apps commit to
  their repositories. Each baseline file carries a top-level `version` (currently
  `1`; a file without one is read as `1`), and every later release keeps reading
  every earlier version. A baseline with a higher version than this release knows
  fails synth with a message to upgrade `@aws-blocks/core`; one whose `version` is
  not a whole number from 1 fails synth as invalid. Neither is ever rewritten or
  deleted. Commit these files with your
  app; they are written and updated by the Building Block that owns them.

- e68e653: fix(bb-distributed-table): keep a retained table's indexes when the table leaves the stack

  Deleting a stack, or removing a DistributedTable from the app, used to drop every global secondary index from the table before CloudFormation reached the table itself. With the production default (`RemovalPolicy.RETAIN`, `protection: 'locked'`/`'retained'`) the table survived without any of its indexes, and the delete waited for every index drop. The GSI manager now reads its own stack's status and current template on Delete, and leaves the indexes in place when the table is leaving the stack. Removing indexes from the config and redeploying still drops them. If the stack cannot be read, the indexes are kept. If only the template cannot be read during the cleanup phase of an update (or of a rolled-back update), the indexes are kept and the deploy shows a `DELETE_FAILED` event naming the table and its indexes, so any that are no longer configured can be removed by hand; the deploy itself still succeeds.

  A Delete whose table no longer exists (for example, deleted outside CloudFormation) now succeeds instead of leaving the stack in `DELETE_FAILED`.

  The package now depends on `@aws-sdk/client-cloudformation` at runtime (already a runtime dependency of `@aws-blocks/core`, so it is normally installed already). On upgrade, every stack with a table that defines `indexes` gets a new code bundle for both GSI manager Lambdas and one read-only IAM statement on the GSI manager's role: `cloudformation:DescribeStacks` and `cloudformation:GetTemplate` on the stack itself. Tables, indexes and the GSI custom resource are not changed or re-run. The new behaviour applies once this version is deployed, so upgrade a stack first, then delete it or remove a table or its `indexes` in a later deploy.

- 3142985: **Breaking (behavior):** two changes reach apps that are already deployed:

  - The deployed `EmailClient` now validates addresses before calling SES, so `send()` throws `InvalidInputException` (and `sendBatch()` marks the message `failed`) for addresses the validator rejects but SES accepted, for example quoted local parts (`"john.doe"@example.com`) or non-ASCII domains.
  - The shared execution role is granted only `ses:SendEmail` and `ses:SendBulkEmail`. An app that calls the SES SDK directly (for example `SendRawEmail` for attachments) and relied on this block's grant of `ses:SendRawEmail`, `ses:SendTemplatedEmail` or `ses:SendBulkTemplatedEmail` must grant those actions itself.

  `EmailClient` changes:

  - `sendBatch()` sends a message without `html` as plain text only, as `send()` already does. It previously reused the plain-text `body` as the HTML part, where a mail client would render any markup in it. Messages with `html` are sent in separate calls, before the text-only ones; `results` stays in input order.
  - The deployed client validates every message the same way the local one does, before calling SES: every address (To, CC, BCC, `fromAddress` and `replyTo`), at most 50 recipients, and at most 40 MB. Invalid input throws `InvalidInputException` (or `EmailSendFailedException` for size) from `send()`, and is marked `failed` in `sendBatch()` results. Addresses may carry a display name made of plain words or one quoted string (`Jane Doe <jane@example.com>`, `"Doe, Jane" <jane@example.com>`), which SES accepts. Surrounding whitespace and control characters are rejected.

- 9c96135: feat(bb-file-bucket): customer-managed KMS encryption, Object Lock, and a stack-wide default for S3 access logging

  - **`encryption`** on `FileBucket` takes the same values as `KVStore` and `DistributedTable`. `'aws-managed'` (the default) keeps SSE-S3. `'customer-managed'` creates a dedicated KMS key for the bucket, with rotation on, and removes it along with the bucket. `FileBucket.fromKmsKey(arn)` uses a key you already own. Both KMS options use S3 Bucket Keys. The runtime role is granted the key permissions, so `put`/`get` and presigned URLs keep working.
  - **`objectLock: { mode: 'governance' | 'compliance', retentionDays }`** turns on S3 Object Lock with a default retention for every new object version. It needs versioning (on by default) and a retained bucket, and both are checked at synth: `versioned: false` and a `'destroy'` removal policy, which is the sandbox default, both fail synth. Pass `removalPolicy: 'retain'` to use Object Lock in a sandbox. Object Lock can only be turned on when the bucket is first created. S3 requires a signed checksum on every upload to such a bucket, which a presigned URL can't carry, so `putUrl()` and `createUploadHandle()` throw the new `FileBucketErrors.PresignedUploadUnsupported` there; upload with `put()`.
  - **`BlocksDefaults.storageAccessLogging`** (optional) turns S3 server access logging on or off for every `FileBucket` without changing API Gateway access logging. It is unset in both presets, so `FileBucket` still falls back to `accessLogging` and existing stacks deploy unchanged.

  `encryption` and `objectLock` are ignored on a bucket wrapped with `FileBucket.fromExisting`, and synth warns when either is set there. `@aws-blocks/blocks` re-exports `ObjectLockOptions` and the FileBucket key reference type, as `FBExternalKmsKeyRef`.

  `@aws-blocks/core` now parses the `encryption` option in one place for all three storage blocks. An unrecognized value still warns and falls back to the AWS-managed default.

- ce5dfa9: feat(compute): the `Compute` block and container-backed AsyncJobs

  Adds a single `Compute` Building Block for choosing where a workload runs, and
  lets an `AsyncJob` run on a container (AWS Fargate) instead of the default
  serverless compute — for long-running or high-memory work. All net-new,
  unreleased surface.

  **`Compute`.** `new Compute(scope, id, { type, ...options })` states the compute
  type explicitly (`serverless` | `container`); Blocks maps the type to the AWS
  service. Options are per-type (a discriminated union), so an attribute that
  doesn't apply to the chosen type is a compile error, and the service name never
  appears in the API. The concrete backing computes stay internal and extend
  `Scope` like every other block.

  - `serverless`: `memory`, `maxTimeoutSeconds` (the function's runtime ceiling).
  - `container`: `size` (a valid `{ vcpu, memory }` combination — invalid pairs are
    unrepresentable), `scaling` (real Application Auto Scaling —
    `min/maxInstances` + `cpu`/`memory` target-tracking and `queue-depth`
    step-scaling policies;
    queue-depth sums the messages across the queues the compute drains), and a
    custom `image`.

  **`AsyncJob({ compute })`.** A job runs on the app default (serverless) unless
  given a `Compute`. On a container, delivery is an owner-matched SQS poller the
  container self-starts, and each delivery runs in its own worker thread so the
  job's `timeoutSeconds` is hard-enforced (the worker is terminated at the
  deadline). `maxConcurrencyPerCPU` sets in-flight deliveries per vCPU — the
  per-instance count is `max(1, ceil(maxConcurrencyPerCPU × vcpu))`, and it is a
  compile error (and a synth-time error) on a serverless job. Both are properties
  of the work and live on the job; `size`/`scaling` live on the compute. In local
  dev, compute assignment is transparent. `AsyncJobOptions` has no compute-kind
  type parameter — the kind is inferred from the `compute` argument — so
  `new AsyncJob<Payload>(…)` with a container compute compiles without spelling a
  second generic.

  **One shared VPC per backend, and stateful blocks stay put.** A container needs
  a VPC, so Blocks provisions **one** shared VPC (and one ECS cluster) per backend
  root at a fixed id — N container configs do **not** create N VPCs, and placement
  is independent of declaration order. The shared VPC is tagged by origin:
  `provided` (customer passed `defaults.vpc.network`) or `derived` (Blocks created
  it). Stateless compute (Lambda, the container) uses whichever exists. A
  **stateful** block — today `Database` — joins only a customer-`provided` VPC; it
  never auto-joins a Blocks-`derived` one. This is a safety guarantee: without it,
  adding a container (or upgrading to a version that derives a VPC) could move an
  existing Aurora cluster into the new VPC, which CloudFormation applies as a
  _replacement_ — destroying the database. A Database with no customer VPC keeps
  building its own, exactly as before. (Moving a Database into a shared VPC remains
  a deliberate, out-of-band migration.)

- 7477b6e: Add `compute.type: 'web-function'` to run the SSR server on AWS Lambda Web Functions. The framework's own Node.js server runs directly on Lambda behind CloudFront origin access control, with no API Gateway and no Lambda Web Adapter. Each execution environment serves many concurrent requests and is billed for active CPU. It works with Astro, SvelteKit, Nuxt/Nitro and Next.js in the Regions where Web Functions are available. When this compute is selected, Nitro builds with the `node-server` preset and Next.js builds with OpenNext's `node` wrapper automatically. Tune it with `compute.webFunction` (`maxConcurrencyPerEnvironment`, `maxEnvironments`, `rateLimit`). The default (`'lambda'`) is unchanged.

  Sandbox deploys (`npm run sandbox`) of a Web Function app skip CloudFormation Express Mode after the first deploy. Express Mode can't update a Web Function endpoint, so the deploy uses a full deploy with rollback instead.

- dd5e807: feat(core): emit an OIDC client's inferred provider names

  `blocks-generate-spec` now writes `x-blocks-type-args` for an `oidc/client` result
  from the provider names the type checker infers, including for a namespace built
  in another module. `AuthOIDC.createApi()`'s `getClient()`, typed
  `OIDCClient<ProviderName<P>>`, now carries the configured provider names as a
  string enum, for example `[{ "type": "string", "enum": ["google", "github"] }]`,
  so native clients can generate a provider type. Provider names that resolve to
  plain `string` or `any` emit no type args. Other transferables are unchanged.

  `@aws-blocks/blocks` gets the same bump because it re-exports `@aws-blocks/core/scripts`.

- 8565ef7: feat: place a whole scope, or a CronJob, on its own compute

  A `Scope` takes `compute`, which places everything created under it, including in
  its child scopes, on one `Compute`:

  ```ts
  const reportsCompute = new Compute(scope, "reports-compute", {
    type: "serverless",
    memory: 4096,
  });
  const reports = new Scope("reports", {
    parent: scope,
    compute: reportsCompute,
  });

  export const reportsApi = new ApiNamespace(reports, "reports", (context) => ({
    /* methods */
  }));
  new CronJob(reports, "nightly", {
    schedule: "cron(0 2 * * ? *)",
    handler: async () => {},
  });
  ```

  - The nearest setting wins: a block's own `compute`, then the nearest scope's,
    then the app's default compute.
  - `AsyncJob` follows a serverless or container scope. `ApiNamespace` and
    `CronJob` run only on a serverless compute for now; under a container scope
    they fail synth with an error that names the compute.
  - `Realtime` and `RawRoute` always run on the default compute, inside such a
    scope too. `Realtime.publish()` works from any compute.

  `CronJob` also takes its own `compute` (serverless only; a container compute is a
  type error). Each job's schedule now gets permission to invoke the function it
  targets: before, the shared scheduler role could only invoke the first job's
  function, so a job on a different function would have been refused at run time.

  A `CronJob` or `AsyncJob` whose compute (its own, or its scope's) belongs to a
  different backend now fails synth with an error naming the compute. This happens
  when several backends are built from one backend module and the `Compute` comes
  from a sub-module, which stays bound to the first backend that imported it.
  Before, the job was wired to that backend's function: a scheduled run failed
  every time, or synth stopped with a dependency cycle.

  In local dev every block still runs in the dev server.

- 3d83cb6: feat(bb-secret): make `Secret` read-only at runtime by default; add `allowRuntimeWrite`

  A `Secret` is now **read-only at runtime unless you opt in**. By default the instantiated object exposes only `get()` and `listVersions()` — there is no `put()` method (a call is a compile error _and_ the method is absent from the object at runtime), and the deployed execution role is granted **read-only** IAM (`GetSecretValue` + `ListSecretVersionIds`, no `PutSecretValue`). This is the least-privilege default: most apps read a credential that is set out-of-band (console / `aws` CLI / CI), so the running app never needs write access.

  Pass the new `allowRuntimeWrite: true` option to opt into runtime writes — then `put()` is present on the object and the execution role is granted `PutSecretValue`. The option applies to every secret, including one wrapped via `Secret.fromExisting(arn)`.

  ```typescript
  // Read-only (default): no put(); role gets read-only IAM.
  const stripeKey = new Secret(scope, "stripe-api-key");
  const key = await stripeKey.get();

  // Writable: the app sets/rotates the value itself.
  const token = new Secret(scope, "self-rotating-token", {
    allowRuntimeWrite: true,
  });
  await token.put("t-abc123");
  ```

  **Behavioral/typing change (bb-secret is pre-1.0).** `Secret` is now exposed as an overloaded constructor whose return type reflects `allowRuntimeWrite`: `true` yields a `WritableSecret<T>` (has `put`), otherwise the read-only `Secret<T>`. Existing code that called `put()` on a default secret must now pass `allowRuntimeWrite: true`. Deployed stacks created before this change that relied on the runtime writing the secret will lose `PutSecretValue` until the declaration sets `allowRuntimeWrite: true` — add it where the app genuinely writes.

- 82ea78a: A project config can no longer re-enable telemetry that a global config disabled.

  `isTelemetryEnabled()` returned early on a project `telemetry.enabled: true` before reading `~/.blocks/config.json`, so `blocks-telemetry --disable --global` followed by `--enable` left the send gate open while `--status` reported disabled. The gate now resolves through `getTelemetryStatus()`, so only `false` short-circuits and the two cannot disagree. `blocks-telemetry --enable` also warns, naming the mechanism, when a broader opt-out still applies. The env var already overrode both config files, and a project `false` still beats a global `true`.

  Behavior change (0.x minor = breaking channel): if you globally disabled telemetry and relied on a project config to turn it back on, that project stays opted out. Re-enable globally with `npx blocks-telemetry --enable --global`.

- f704a68: feat(auth-common): add the `StatusMessage` UI primitive

  Adds `StatusMessage` to `@aws-blocks/auth-common/ui` (re-exported from `@aws-blocks/blocks/ui`) — a themed, accessible status line for the loading / success / error affordance the starter templates otherwise hand-roll with inline styles.

  - `StatusMessage(options?)` returns a `StatusMessageHandle` (`{ element, set }`): mount `element`, then drive it with `set(kind, text)` as an async operation progresses.
  - Four lifecycle states (`StatusKind`): `idle` (muted), `loading` (muted + spinner), `success` (green), `error` (red) — all driven by the existing `--bb-*` semantic tokens, so the message matches the active light/dark theme.
  - The root is a polite ARIA live region (`role="status"`, `aria-live="polite"`); the `loading` spinner is decorative (`aria-hidden`) and holds still under `prefers-reduced-motion`.
  - Adds the `.bb-status*` / `.bb-spinner` classes and a reduced-motion-aware `bb-spin` keyframe to the shared theme CSS.
  - The `auth-cognito` template now renders its status lines through `StatusMessage` instead of a hand-built classed span.

  No breaking changes — purely additive.

### Patch Changes

- 5dc1d98: fix(bb-agent): authenticate the openai-api provider to Bedrock Mantle with the agent's AWS credentials

  An `openai-api` model whose `endpoint` is a Bedrock Mantle URL (`https://bedrock-mantle.<region>.api.aws/...`) and has no `apiKey` now authenticates with short-term Bedrock API keys minted from the AWS credentials the agent runs with, refreshed automatically. The deployed runtime role is granted the `bedrock-mantle` permissions it needs. `OPENAI_API_KEY` is not used for Mantle endpoints, and an explicit `apiKey` still takes precedence.

- 48c35f6: `Agent` reads and writes its session state under the session bucket's real name, which `FileBucket` now shortens when the `fullId` is over 63 characters. Agents whose bucket name already fits are unchanged.
- 763f67e: AuthBasic now caps the number of failed guesses against a single verification
  code (sign-up confirmation and password-reset OTP). A 6-digit code (~19.8 bits)
  is exhaustively guessable within its 10-minute validity window at any reasonable
  request rate, so an always-on per-code attempt cap narrows that exposure.

  After 5 consecutive wrong guesses the code is invalidated and the user must
  request a fresh one; a wrong guess never extends the code's life. The cap is
  enforced atomically — each attempt is reserved with a compare-and-swap before
  the guess is evaluated, so concurrent guesses (including across Lambda
  instances on one row) cannot bypass it. The error is the same generic
  `InvalidCodeException` on a wrong guess, a lost race, and an exhausted code, so
  no oracle reveals whether the cap was hit. The cap bounds guesses against one
  code; rate-limiting code issuance volume remains an infrastructure-layer
  concern (WAF / API Gateway throttling).

- aaa90b6: AuthBasic now revokes the session token server-side on sign-out. Each session
  JWT carries a unique `jti`; `signOut` records that id on a revocation list (in
  the existing codes store, expiring with the token) so a replayed cookie is
  rejected even though the JWT is still unexpired and signature-valid. The
  umbrella `@aws-blocks/blocks` is bumped because the bundled `bb-auth-basic`
  README/DESIGN docs it mirrors have changed.

  This is a `minor` (not `patch`) bump because it adds exported error constants —
  `AuthBasicErrors.SessionRevoked` (`SessionRevokedException`, thrown by
  `requireAuth` for a signed-out/revoked session, vs `SessionExpiredException` for
  an absent/aged-out one) and `AuthBasicErrors.SignOutIncomplete`
  (`SignOutIncompleteException`, 503, thrown when the revocation write fails) —
  and documents a new throwable name on the shared `BlocksAuth.requireAuth`
  contract in `@aws-blocks/auth-common`.

  `signOut` always clears the local cookie (so sign-out on this device never
  leaves the user stuck signed in), even when the server-side revocation write
  fails; in that case it throws a stable `SignOutIncompleteException` rather than
  the raw SDK error, so no `$metadata`/ARNs leak to the client.

  Legacy-surface behavior change: the deprecated `buildApi().signOut` previously
  always resolved to `{ success: true }`; it now awaits `signOut` and so can
  reject with `SignOutIncompleteException` (503) when the revocation write fails.
  Only direct `buildApi` callers are affected — the `createApi()` state machine
  catches it into the `AuthState.error` field.

  Operator note: the `codes` store gains `{ ttl: true }`. For an already-deployed
  AuthBasic app this is an in-place DynamoDB TimeToLive enablement (an `UpdateTable`)
  on the next `cdk deploy` — no data migration, and correctness does not depend on
  the reaper (reads filter expired items regardless). Caveat: DynamoDB rejects
  another `UpdateTimeToLive` on the same table for ~1 hour after a change, so if an
  unrelated resource fails in the same deploy, CloudFormation rollback (which
  disables TTL) — or a deploy → rollback → redeploy within that hour — can land in
  `UPDATE_ROLLBACK_FAILED`. Deploy AuthBasic apps with this in mind.

- 72c8165: AuthBasic can now lock an account after too many consecutive failed sign-ins,
  an opt-in defense against credential-stuffing and password brute-forcing (issue
  #766). Pass the new `lockout` policy to enable it:

  ```typescript
  const auth = new AuthBasic(scope, "auth", {
    lockout: { maxAttempts: 5, windowSeconds: 900, lockoutSeconds: 900 },
  });
  ```

  Failed attempts are counted **per username** in the existing `codes` store
  (under a `lockout:<username>` key, with a TTL so counters self-reap and never
  grow unbounded). Once `maxAttempts` consecutive failures accumulate within
  `windowSeconds`, the account is locked for `lockoutSeconds`; the lock is
  enforced at the **top of `signIn`**, before the user record is read or the
  password compared, so a locked account sheds the bcrypt cost under attack and
  exposes no timing oracle. A successful sign-in clears the counter.

  This is a `minor` (not `patch`) bump because it adds the exported error constant
  `AuthBasicErrors.AccountLocked` (`AccountLockedException`, 429, branded so the
  name crosses the wire) and the new `lockout` option (`LockoutPolicy`) on
  `AuthBasicOptions`. The error message is generic — it reveals neither the
  username nor any SDK metadata — and `retriable` is left `false` (a lockout
  requires waiting out the window, not an immediate retry).

  Throttling is **disabled unless `lockout` is passed**, so existing apps are
  unaffected. This is per-account credential-guess protection, complementary to —
  not a replacement for — infrastructure-layer rate limiting (CloudFront WAF, API
  Gateway throttling) for volumetric/DDoS protection.

  Per-username counting (rather than per-IP) matches `AuthCognito`'s managed
  lockout and avoids locking out a whole shared NAT/corporate egress on one user's
  typos. The umbrella `@aws-blocks/blocks` is bumped because the bundled
  `bb-auth-basic` README/DESIGN docs it mirrors have changed.

- ee69cd7: docs(bb-file-bucket): document that `corsRules` is required for browser uploads and downloads

  Browser uploads and downloads that worked under `npm run dev` failed after
  deploying to a sandbox or production stack with `No 'Access-Control-Allow-Origin'
header is present on the requested resource`, and nothing in the docs explained
  why. The local dev file-server accepts any origin, but the deployed S3 bucket has
  no CORS configuration unless `corsRules` is set — and it does not inherit the
  stack's `defaults.allowedOrigins` or the Hosting domain.

  - **bb-file-bucket README** — new "Browser Uploads and Downloads (CORS)" section
    with the failing error, a working `corsRules` example (`GET`/`PUT`,
    `allowedHeaders: ['Content-Type']`), how to find the deployed Hosting origin
    (`HostingUrl`), and notes on preflight headers, S3 origin syntax, the scope of
    the wildcard synth guard, which requests need CORS, and wrapped buckets. The
    `corsRules` option row, Best Practices, and Local Development sections now
    point to it.
  - **bb-file-bucket TSDoc / DESIGN.md** — `corsRules` documents its no-CORS
    default, that it is ignored for wrapped buckets, and (new D-FB-15) why it is
    not derived from `defaults.allowedOrigins` or the Hosting domain.
  - **blocks README** — the Security Considerations list notes that
    `defaults.allowedOrigins` covers the API only and FileBucket needs its own
    `corsRules`.

  Documentation only — no runtime or API change.

- e15fe58: fix: publish `TROUBLESHOOTING.md` at the package root

  The package README links to `./TROUBLESHOOTING.md`, but the file only shipped under `docs/`, so the link was dead on npm and in `node_modules/@aws-blocks/blocks/`. It now ships at the package root too.

- 943d405: fix: error constants can be imported in frontend code

  Frontend code imports a Building Block's error constants to match errors with `isBlocksError`, which resolves the
  package's `browser` entry. Some of those imports failed the frontend build:

  - `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, and `LoggingErrors` were missing from the `browser` entries
    of `@aws-blocks/bb-app-setting`, `@aws-blocks/bb-email-client`, `@aws-blocks/bb-file-bucket`, and
    `@aws-blocks/bb-logger`. They are now exported.
  - Any import from `@aws-blocks/bb-auth-basic` or `@aws-blocks/bb-auth-cognito`, including `AuthBasicErrors` and
    `AuthCognitoErrors`, failed with `No matching export ... for import "ApiNamespace"`. The browser stubs no longer
    depend on `ApiNamespace`; their server-only `createApi()` / `buildApi()` now throw if called in the browser.
  - `CronJobErrors.ScheduleNotSupported` was `undefined` in the browser, so `isBlocksError(e, CronJobErrors.ScheduleNotSupported)`
    never matched. The `@aws-blocks/bb-cron-job` and `@aws-blocks/bb-dashboard` browser entries now re-export the
    server's constants instead of keeping their own copies.
  - `@aws-blocks/bb-realtime` had no `browser` entry, so importing `RealtimeErrors` in frontend code pulled in the
    server build and failed to bundle. It now has one.

  `@aws-blocks/blocks`: the conditional-export parity test now checks that every Building Block with error constants
  has a `browser` entry that exports them with the same values, and that the entry bundles for the browser.

- 50b8c94: `npm run deploy` and `npm run sandbox` now check that CDK has been bootstrapped in the target account and Region before they synthesize. In an account and Region that were never bootstrapped, a deploy used to fail only after synthesis, with `SSM parameter /cdk-bootstrap/hnb659fds/version not found`. The commands now read that parameter, with the credentials that the credential check verified and the qualifier from `@aws-cdk/core:bootstrapQualifier` in the CDK context, and stop right away with the command that bootstraps the account and Region: `npx cdk bootstrap aws://<account-id>/<region> --app=`. `--app=` keeps CDK from synthesizing the app to find environments. The commands never bootstrap for you, because bootstrapping creates IAM roles in the account. Only a missing parameter stops the deploy; a denied read, a network error or a timeout does not. The destroy commands do not run this check.
- 943d405: fix: export types missing from the `cdk` entry point

  Some types exported by the default entry point of `@aws-blocks/blocks` were missing from its `cdk` entry, so backend
  code importing them failed to type-check under that condition — for example,
  `import type { SubscribeOptions } from '@aws-blocks/blocks'`.

  The `cdk` entry now exports `AuthActionInput`, `AgentTool`, `DefaultToolContext`, `ToolFactory`, `ToolHandlerArgs`,
  `ToolsConfig`, the `AuthCognito` admin types (`AdminAction`, `AdminActionGate`, `AdminCreateInit`, `AdminDisabled`,
  `AdminGetterOf`, `AdminGrants`, `AdminOptions`, `AdminSurface`, `AdminUser`, `AdminUserFilter`, `CodeDeliveryFn`,
  `GroupAdmin`, `LifecycleAdmin`, `SetPasswordOptions`), `DisconnectReason`, `RealtimeChannel`, `RealtimeSubscription`,
  `SubscribeOptions`.

- a3969b5: fix: actionable errors for runtime methods called during `cdk synth`

  Calling a Building Block's runtime method (for example `db.query()`, `bucket.put()`, `auth.requireAuth()`, or
  `auth.admin`) at the top level of a backend module runs it during `cdk synth`. For many Building Blocks this failed with
  a cryptic `TypeError: x is not a function`; it now throws the same actionable error the other Building Blocks already
  give: `<Class>.<method>() cannot be called during CDK synth. Data methods run at request time — …`.

- 48c35f6: fix: export the same names from every conditional entry point

  Some Building Blocks were missing named exports from their `cdk` or `browser`
  entry points, even though the TypeScript types said they were there. Importing
  one of these names from code evaluated during `cdk synth`, or from a browser
  bundle, failed at import time. Added:

  - `cdk` entry: `InterruptError` (`@aws-blocks/bb-agent`), `BatchSubmitFailedError`
    (`@aws-blocks/bb-async-job`), and `RLSEnabledDatabase` and `PgClientEngine`
    (`@aws-blocks/bb-data`).
  - `browser` entry: the error constants `AgentErrors`, `AppSettingErrors`,
    `EmailErrors`, `FileBucketErrors` and `LoggingErrors` (for `isBlocksError` checks
    in frontend code), plus `InterruptError`, `BedrockModels` and `OllamaModels`
    (`@aws-blocks/bb-agent`) and `fromExisting` (`@aws-blocks/bb-data`).

  The conditional-exports regression test now compares every Building Block's
  `aws-runtime`, `cdk` and `browser` entries against its default entry in both
  directions, so these gaps can't come back unnoticed.

- 48c35f6: The Lambda handler routes Cognito user pool trigger events to the Building Block registered for that user pool (`EventSourceMapping.COGNITO_USER_POOL`). It returns the event unchanged, and it rejects an event for a pool that no block handles.
- 48c35f6: An RPC error response now passes a `Set-Cookie` through only when every browser would delete that cookie, including when it has several `Expires` attributes or one that is not a strict HTTP date. For example, `Expires=Thu, 01 Jan 1970 00:00:00 GMT; Expires=Fri, 01-Jan-2100 00:00:00 GMT` is no longer treated as a deletion, because browsers keep the later date. Cookies cleared the usual way (`Max-Age=0`, or a single past `Expires`) are unaffected.
- 8c73a24: chore(core): declare the `@aws-sdk` devDependencies its tests already use

  `packages/core`'s `client-user-agent.test.ts` dynamically imports
  `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` but never declared them,
  relying on the packages being hoisted to the root by `bb-kv-store`/
  `bb-distributed-table`. A dependency bump that reshuffles hoisting drops that
  incidental resolution and breaks `core`'s build. Declare both as
  devDependencies so the imports resolve regardless of hoisting.

- 48c35f6: An RPC error response no longer passes through a `Set-Cookie` whose `Max-Age` is malformed but could be read as a positive lifetime (such as `+999` or `999abc`), even when its `Expires` is in the past. Error responses carry only cookies that every browser deletes.
- 48c35f6: `Scope.registerLambdaEventHandler()` now throws, for every Building Block, when a handler is already registered for the same event source and identifier, instead of silently replacing the first one. This only fires on a misconfiguration: two blocks in your app consuming the same queue, schedule, WebSocket API or user pool trigger, or a block constructed per request (inside a handler) instead of once at module level. A correctly configured app is unaffected; a misconfigured one now gets an error naming the duplicate, where before one block quietly took over the other's events.
- 54e9443: fix(core): keep x-blocks-type-args when a method is typed from a resolved type

  A method typed from a resolved `ts.Type` rather than the backend entry's AST lost its
  `x-blocks-type-args`, because `detectTransferable` was called without the syntactic
  return-type node that gates type-argument emission. An arity-1 transferable reached that
  way failed spec generation with `found 0` type args.

  The node is now read from the method's own declaration, covering an interface or class
  method and a function-typed or handler-literal property. Entries are emitted only where
  the customer wrote every type argument: a partial list would pass the arity check with
  the wrong types in it.

- 48c35f6: fix(core): only forward real cookie deletions on an API error response

  When an API method throws, only `Set-Cookie` headers that delete a cookie are sent with the error, so a method can clear a session cookie but never issue one. The deletion check used `Date.parse` on `Expires`, so values like `Expires=0` or `Expires=1` counted as deletions. Browsers ignore those values and keep the cookie, so a live cookie could reach the client on an error. The check is now strict. A cookie counts as deleted only with an integer `Max-Age` of `0` or less, or an `Expires` that is an IMF-fixdate (`Thu, 01 Jan 1970 00:00:00 GMT`) at or before now. Any other value is not a deletion and is dropped from the error response.

- d366907: chore: manual dependency bump (2026-10-19)
- 48c35f6: `deploy()` in production mode no longer hangs after the deploy finishes. It used to load your backend's local development (mock) versions of the Building Blocks while generating the client, which started local runtimes (the local `Database` engine, `CronJob` schedules) that kept `npm run deploy` running, and kept logging `[CronJob:…] triggered at …`, after "✅ Deployment complete!". Deploy no longer loads local mocks. As a side effect, it no longer applies migrations to, or writes data into, your local `.bb-data/` database.
- d062eeb: Before they deploy, `npm run deploy` and `npm run sandbox` now print the deployment target: the credentials that CDK deploys with (an AWS profile, access keys from the environment, or container or web identity credentials) and the configured Region. As in CDK, access keys from the environment (including the `AMAZON_` names that CDK also reads) are used before `AWS_PROFILE` unless `cdk.json` sets a profile; the credential check now verifies those keys rather than the profile. When the credential check succeeds, they also show the account name and the AWS account plan (Free or Paid, with its status), read with the same credentials that the check verified. These reads are optional and never stop a deploy. If they are denied, unsupported, empty, malformed or take longer than 2.5 seconds, the value shows as "not available". Account IDs, ARNs, error text and plan credits are not printed. `npm run destroy` and `npm run sandbox:destroy` print only the deployment target.

  When the credentials are the AWS-managed role from the new AWS sign-up experience (a role at the path `/managed/` that `account-access.amazonaws.com` can assume, read with `iam:GetRole`), the output also has a one-line link to `https://settings.aws.com/billing` for spend limits, with a reminder to check that the project selected there matches the deployment target. Other credentials, or a role that cannot be read in time, get no link. When a profile has no Region, the warning now explains how to use `aws login`: set the profile Region to your project's Region before you sign in, and sign in again after you change it.

  `@aws-blocks/core` now depends on `@aws-sdk/client-account`, `@aws-sdk/client-freetier` and `@aws-sdk/client-iam`. They load only when a deploy command runs.

- 48c35f6: `FileBucket` no longer fails `cdk synth` when its derived S3 bucket name is longer than 63 characters. A bucket's name comes from your stack name and scope ids, so a long stack name or deeply nested ids could push it over S3's limit. This also hit blocks that create a bucket internally, such as `Agent`. These names are now shortened to the start of the name plus `-` and an 8-character hash. The result is the same on every deploy, and different scope chains still get different names. Bucket names that already fit are unchanged, so no existing bucket is renamed or replaced. Names that break any other S3 naming rule still fail synth with `ValidationFailed`.
- 63b154f: feat(core): multi-compute routing — per-namespace RPC paths + shared-gateway fan-out

  Make the shared REST API gateway route each API namespace to the compute that hosts it, in two parts.

  **Per-namespace paths.** The typed RPC client now POSTs to `/aws-blocks/api/{namespace}` (the namespace in the path) instead of the shared `/aws-blocks/api` — a gateway routes by URL path, not the JSON-RPC body, so giving each namespace its own path is what lets one gateway fan out to multiple computes. `{namespace}` is the backend export name. The body still carries `namespace.method`, and that is what the runtime handler and the local dev server dispatch: a per-namespace path must be exactly `/aws-blocks/api/{namespace}` and name the same namespace, or the request is rejected with a JSON-RPC `-32600` Invalid Request rather than silently running either one. `POST /aws-blocks/api` keeps working unchanged, so raw HTTP callers that use it are unaffected.

  Migration note for `ApiNamespaceClientOptions.url`: pass the **base** URL (e.g. `/aws-blocks/api`, or `https://d123.cloudfront.net/aws-blocks/api`) — the client now appends `/{namespace}` itself. A pre-qualified URL that already includes the namespace routes to `{url}/{namespace}` and is not supported.

  Deploy order: a web client built with this release calls `/aws-blocks/api/{namespace}`, which needs the gateway resource this release adds. Deploy the backend before, or together with, clients built against it; a gateway deployed from an earlier release may reject the per-namespace path (403). If you run your own proxy or rewrite in front of the API (nginx, a framework rewrite, your own CloudFront behavior), make it forward the whole `/aws-blocks/api/*` subtree, not just the exact `/aws-blocks/api` path — `Hosting` already does.

  The native clients call the same per-namespace paths from `aws-blocks-swift` 0.2.0, `aws-blocks-kotlin` 0.3.0 and the next Dart `blocks_runtime` release. Native clients from earlier releases POST to the bare `/aws-blocks/api` URL, which keeps working and runs every call on the default compute.

  **Gateway fan-out.** The shared gateway now routes each namespace's path to the compute that hosts it. The default compute's function stays behind the catch-all resources, so the RPC root, auth, `RawRoute`s, and any namespace left on the default compute all reach it; a new `/aws-blocks/api/{proxy+}` resource carries the per-namespace RPC paths for those namespaces. Every non-default compute gets its own Lambda integration plus a literal `/aws-blocks/api/{namespace}` (`ANY`) resource for each namespace it hosts. A literal resource wins over the sibling `{proxy+}`, so requests fan out within a single gateway — and a single CloudFront origin under `apiFrontDoor: 'cloudfront'`. Routes key on each namespace's export name — what the client calls — read from the backend module after it is imported, and each namespace's compute is resolved then (the namespace's own `compute` option, else the compute of the scope it was built in). A non-default compute's function gets one API-scoped invoke permission however many namespaces it hosts. Synth fails with a clear error for a namespace on a compute that takes no API traffic, or for an export name API Gateway can't use as a path segment.

  For an app that gives no namespace its own compute (every app before the `ApiNamespace` `{ compute }` option), every namespace resolves to the default compute and the only synthesized change is the additive `/aws-blocks/api/{proxy+}` resource; existing gateway resources keep their logical IDs. The `createSharedGateway` signature (it now takes the per-compute namespace routes + default compute) is `@internal`, and so is the `ComputeBase.namespaces` list this replaces.

- 8565ef7: fix(core): name the customer's `Compute` in shared-gateway synth errors

  The synth errors for a compute that can't serve API namespaces, and for an
  export name API Gateway can't route, named the compute by its construct id —
  for a `Compute` block that is its internal `backing` child. They now give the
  compute's full construct path (for example `MyStack/app/reports/backing`), which
  includes the id you passed to `new Compute(...)`.

- dde6340: feat(hosting): swappable front doors, and bring-your-own doors written as one function

  `Hosting` no longer hard-codes CloudFront. The optional `frontDoor` prop picks
  the public entry point. Omit it and nothing changes: you get the same CloudFront
  distribution as before.

  - `'cloudfront'` (default): the global CloudFront CDN.
  - `{ kind: 'alb', vpc?, internal?, certificate? }`: a regional Application Load
    Balancer, with no CDN. Server-rendered responses are buffered. With
    `certificate` and `features.domain` it serves HTTPS (TLS 1.2+) at your domain,
    with a port 80 → 443 redirect and Route 53 alias records.
  - `{ kind: 'apiGateway', api?: 'http' | 'rest', certificate? }`: Amazon API
    Gateway, with no CDN, no VPC, and scale-to-zero. `'http'` (the default)
    buffers server-rendered responses; `'rest'` streams them. `'rest'` needs a
    custom `domain`: its own URL carries the `/prod` stage, which the app's
    root-relative links miss, so synth fails without one
    (`RestFrontDoorNeedsDomainError`).
  - `{ kind: 'stacked', edge: 'cloudfront', router: 'alb', vpc?, internal?, certificate? }`:
    a CloudFront edge in front of a full ALB router. The edge serves the app's
    static routes straight from the private S3 bucket (origin access control);
    the API and the dynamic routes go through the ALB. The ALB admits only the
    edge: every listener rule requires a secret header the edge sends (otherwise
    403), whose value Secrets Manager generates once per stack and both sides
    read through a CloudFormation dynamic reference; its security group admits
    only the CloudFront origin-facing managed prefix list, or, with
    `internal: true`, only the CloudFront VPC origin the edge reaches it through.
    With a router `certificate` and `features.router.domain`, the edge reaches
    the router over HTTPS on port 443; otherwise that hop is plain HTTP, and an
    internet-facing router warns at synth (`StackedRouterPlainHttp`).
  - `'none'`: no front door. A static site or SPA is served straight from an S3
    website bucket over HTTP. An app with a server fails synth.
  - `{ kind: 'custom', door, wiringCheck? }`: your own door.

  Every door serves the API on the app's own origin (except `'none'`, where the
  browser calls the API cross-origin): `/aws-blocks/*` (RPC and sign-in) and each
  of the backend's raw routes. Only a CloudFront-backed door (the default, or
  the stacked door's edge) claims the backend's API front-door role, so
  `apiFrontDoor: 'cloudfront'` builds no second distribution there. Behind the
  ALB, API Gateway or a bring-your-own door, the API keeps the distribution
  `apiFrontDoor: 'cloudfront'` asks for, and `ApiUrl` stays on it for native
  clients. A plain-HTTP door warns at synth (`PlainHttpFrontDoor`). The backend's trusted origin
  (`BLOCKS_PUBLIC_ORIGIN`, where the OIDC callback lands and whose scheme sets
  the session cookie's `Secure`) belongs to the door that serves `/aws-blocks/*`
  to browsers: a managed `cloudfront` API distribution built beside such a door
  doesn't overwrite it. `'none'` publishes none (the bucket serves no
  `/aws-blocks/*`), and its `config.json` names the same API URL as `ApiUrl`.

  Each door kind takes the settings the app asks it for as `features`, typed for
  that kind: a setting the chosen door doesn't implement does not compile.
  `{ features }` with no `kind` is the CloudFront default with settings.

  - CloudFront: `domain`, `waf`, `logging`, `monitoring`, `skewProtection`,
    `geoRestriction`, `priceClass`, `contentSecurityPolicy`, `ssrDefaultTtl`,
    `cacheKeyCookies`, `cacheKeyHeaders`, `responseHeadersPolicy`, `quotas`.
  - ALB: `domain` (without `wwwRedirect`), `waf` (a REGIONAL web ACL), `logging`,
    `monitoring` (`enabled` only). The ALB's own access logs are off unless
    set; its alarms are on unless `monitoring: { enabled: false }`, as on the
    CloudFront door.
  - API Gateway (HTTP and REST): `domain` (without `wwwRedirect`).
  - Stacked: per layer, `edge: { waf: { webAclArn }, contentSecurityPolicy }` (a
    CLOUDFRONT-scoped web ACL) and `router: { domain, waf, logging, monitoring }`
    (a REGIONAL web ACL; the domain is the name the edge connects to).
  - Custom: `domain`, `waf`, `logging`, `monitoring`, `geoRestriction`,
    `skewProtection`, handed to the door as `input.features`.
  - `'none'`: no settings.

  `geoRestriction.type` takes `'allowlist'` or `'denylist'`; the legacy
  `'whitelist'` / `'blacklist'` mean the same, and any other value fails synth.
  `frontDoor` is validated at synth: an unknown door, an option the kind doesn't
  take, a value of the wrong shape, or an unknown key inside a `features` setting
  fails with `UnsupportedFrontDoorError`, `InvalidFrontDoorOptionError` or
  `InvalidFrontDoorSettingError`, naming it.

  **Deprecated (still supported):** the top-level settings props. On `Hosting`
  (`@aws-blocks/core`): `domain`, `waf`, `logging`, `monitoring`,
  `skewProtection`, `contentSecurityPolicy`, `priceClass`, `geoRestriction`,
  `quotas`, `ssrDefaultTtl`, `cacheKeyCookies`, `cacheKeyHeaders`. On
  `HostingConstruct` (`@aws-blocks/hosting`): `domain`, `waf`, `logging`,
  `monitoring`, `skewProtection` and `cdn` (each `cdn.<x>` is
  `frontDoor.features.<x>`; `cdn.webAclArn` is `frontDoor.features.waf.webAclArn`).
  Use `frontDoor.features.<x>` instead: the names are the same, so migrating is a
  straight move. The aliases are merged into `frontDoor.features` at
  construction, and an app that sets them with no `frontDoor` (or `'cloudfront'`)
  synthesizes the same template, with one exception for JavaScript callers of
  `geoRestriction` (TypeScript only accepted `'whitelist'` / `'blacklist'`): any
  type other than `'whitelist'` used to deny the listed countries, so
  `'allowlist'` now allows them as its name says, and a missing or unknown type
  (e.g. `'Whitelist'`) now fails synth instead of denying. Setting a setting both ways fails synth with
  `FrontDoorSettingConflictError`, naming both; a top-level prop the chosen kind
  doesn't implement fails synth with `UnsupportedFrontDoorSettingError`, naming
  the kind and the prop.

  The ALB and API Gateway doors serve static files through an asset-proxy Lambda
  that answers like the CloudFront door: a missing file returns 404 (the SPA
  fallback applies only to paths without an extension), and each file is served
  with the `Cache-Control` it was uploaded with. It decodes the request path,
  gzips compressible files, answers conditional requests with 304, and adds
  baseline security headers. It switches to a new build only after the build's
  uploads (and the runtime config) have landed. The proxies apply the app's
  redirects (wildcard tail spliced, exact status, never a protocol-relative
  target), per-pattern response headers and error pages with the CloudFront
  door's semantics; synth names what they can't reach (server-rendered and image
  responses, and API Gateway's natively proxied API) with the warning
  `@aws-blocks/hosting:DoorRulesNotApplied`. A file is returned base64-encoded in
  the Lambda response, so it is capped at about 750 KB (gzipped when
  compressible) behind the ALB (1 MB response) and 4.5 MB behind API Gateway
  (Lambda's 6 MB response); synth lists every larger build asset
  (`@aws-blocks/hosting:AssetExceedsProxyLimit`). ALB listener rules are packed
  within the per-rule limits (five condition values, six wildcards; a pattern
  with more wildcards fails synth with `UnsupportedRoutePatternError`), and synth
  warns past the default 100 (`AlbRuleLimit`). Past CloudFront's 25
  cache behaviors, the stacked door's edge serves the remaining static routes
  through the ALB and warns (`@aws-blocks/hosting:StackedEdgeBehaviorLimit`).

  Some apps need the CloudFront door. `compute: { type: 'web-function' }` fails
  synth with `UnsupportedComputeFrontDoorError` behind any other door, and an app
  with Next.js middleware with `MiddlewareNeedsCloudFrontDoorError` (only the
  CloudFront door runs it). A streaming server (Next.js through OpenNext, or
  Nitro with `awsLambda.streaming: true`) fails synth with
  `StreamingServerNeedsStreamingDoorError` behind a door that invokes it without
  streaming (the ALB, the stacked door, the API Gateway HTTP API, or a custom
  door with `serverResponse: 'buffered'`): it would deploy and no page would
  answer. Each built-in door declares what it can serve (streaming, wildcard
  routes, the app's rules on every response, and whether it sets
  `x-forwarded-host`), and the synth checks read those declarations.

  The server is built for the door in front of it. Behind a door that invokes it
  without streaming (the ALB, the stacked door's ALB router, the API Gateway HTTP
  API), a Lambda Web Adapter server (Astro, Nuxt, SvelteKit) answers buffered.
  Serve Next.js through CloudFront, the `'rest'` door, or a door that streams. Behind
  the ALB, the server answers with multi-value headers (so every `Set-Cookie`
  survives), and a native handler server (Nitro's `aws-lambda` preset) runs
  behind a small ALB event shim that maps the ALB event to the API Gateway REST
  shape (method, decoded query, base64 body) and the response back.

  The CloudFront door and the stacked door's edge set `x-forwarded-host` from
  the viewer's `Host`. Behind the ALB and API Gateway doors, a native handler
  server gets it from `Host` through a small shim (a streaming handler stays
  streaming), and a Lambda Web Adapter server that reads its host from
  `x-forwarded-host` through `HOST_HEADER` (SvelteKit) reads `host` instead. Any
  other Lambda Web Adapter server (Astro's Node adapter, Nitro's `node-server`)
  receives the request's headers as sent, so it shouldn't trust
  `x-forwarded-host` behind those doors.

  Redirects behave the same on every door. A wildcard tail spliced onto a
  root-relative destination keeps one leading slash on the CloudFront door too,
  so `/old//evil.example` never answers a protocol-relative `Location`; an
  absolute destination (`https://example.org/moved`) is kept as written. On the
  API Gateway door, a redirect source with a wildcard inside a segment has no
  route, so on an app with a server it warns
  (`@aws-blocks/hosting:RedirectNotExpressible`). The regional doors never route
  the backend's catch-all raw route (`/*`) to the API, which would take every
  page and asset, and warn (`@aws-blocks/hosting:CatchAllApiPathNotRouted`). The
  stacked edge serves the framework build's own 404 page, as the other doors do.
  On the CloudFront door and the stacked door's edge, the app's header rules
  match the path the viewer asked for, as on the regional doors: the
  viewer-response function sees the URI rewritten to the build prefix, so the
  viewer-request function records the viewer's URI for it (`x-blocks-viewer-uri`,
  trusted only on a rewritten URI), and a rule such as `/assets/*` applies.
  Nuxt image optimization (`@nuxt/image` through the IPX Lambda) works under an
  `app.baseURL` behind every door: the ALB and API Gateway doors route the full
  `/<baseURL>/_ipx/...` path to the image Lambda, which now strips the base path
  before IPX's own prefix (`IPX_APP_BASE_URL`).
  The stacked door emits `HostingInvalidationId`, so the post-deploy liveness
  poll waits for the edge's invalidation.

  `HostingConstruct.securityHeadersPolicy` (the CloudFront door's security-headers
  policy, which `Hosting` reuses on the API and auth behaviors) is `undefined`
  behind a door with no CloudFront distribution here; the stacked door's edge
  carries its own policy on every behavior, the API's included.

  `HostingConstruct` exposes the resolved door as `frontDoorKind`, and takes the
  backend API to proxy same-origin as `backendApi: { url, paths? }` (the core
  `Hosting` sets it from `api`).

  A bring-your-own door is one function:
  `defineFrontDoor({ service, serverResponse?, build(scope, input) })` from
  `@aws-blocks/hosting/constructs`. `Hosting` calls `build` once at synth, after it
  has created the bucket, compute and API and before it declares the asset
  uploads. A door that invokes the server without streaming sets
  `serverResponse: 'buffered'` (the default is `'streaming'`). The door receives
  a `DoorInput`:

  - `app`: the build id, base path, Next.js asset prefix, SPA fallback, routes
    already joined to their origins, redirects, headers and error pages.
  - `origins`: the assets bucket and build prefix, the server and image Lambdas
    with their Function URLs (the server's `streaming` says whether it streams,
    and its Function URL uses the matching invoke mode), and the API with every
    path that must reach it.
    The API paths are `/aws-blocks/*` (RPC and sign-in) plus the backend's raw
    routes. `app.errorPages` is the app's `errorPages`, else the 404 and 500
    pages the framework build shipped.
  - `features`: the door's `frontDoor.features`, under the same names and shapes
    (`domain`, `waf`, `logging`, `monitoring`, `geoRestriction`,
    `skewProtection`). A field is present only when the app asked for that
    feature; skew protection is on by default.

  The door returns `{ url, originHandle?, publicBucket?, onUpload?, cutover? }`.

  - `url` is required. It becomes `HostingUrl`, `Hosting.url`,
    `BLOCKS_PUBLIC_ORIGIN` and an allowed CORS origin (a trailing slash is
    removed). A missing `url` fails synth with `MissingFrontDoorUrlError`.
  - `originHandle` is derived from `url` when the door doesn't return one.
  - `onUpload` runs after the asset uploads are declared, so the door can add
    something that runs after them, such as a cache invalidation. What it adds
    under the door's scope also waits for the runtime `config.json` upload.
  - `cutover` names the constructs that switch traffic to the new build; each
    waits for every upload.

  The `cf.*` helpers (`cf.origin`, `cf.behaviors`, `cf.apiBehaviors`,
  `cf.redirects`, `cf.headers`, `cf.errorPages`, `cf.invalidate`) build
  CloudFront origins, behaviors, functions and error responses from the input
  and record what they wired. `cf.redirects` and `cf.headers` run the same
  matcher as the built-in CloudFront door; `cf.errorPages` returns the same error
  responses. From that record, synth fails if nothing reaches the
  static assets (`ServeStaticAsset`). It also fails if the app has an API and
  none of its paths were wired (`ProxySameOriginApi`). Unwired API paths, app
  redirects, headers or error pages the door didn't wire, and more behaviors than
  a distribution allows by default, are synth warnings. A door that wires with
  raw CDK declares it with `cf.recordWired(...)`, or turns the check off with
  `wiringCheck: false`. `assertDoorConformance(door)` runs the same checks in a
  door's own tests.

  The built-in doors (`cloudFrontDoor`, `albDoor`, `apiGatewayDoor`,
  `s3WebsiteDoor`, `cloudFrontEdgeDoor`) are written the same way. The pieces they
  share are exported for your own doors: `generateAlbAssetProxyCode` and
  `generateApiGwAssetProxyCode` (with `AssetProxyOptions`: the app's redirects,
  headers and error pages, and `assetProxyEnvironment()` for the function's
  environment), `generateAlbApiProxyCode`, `backendBaseUrl`, `coalesceRoutes`,
  `routeSpecificity`, `createSecurityHeadersPolicy`, and `ORIGIN_VERIFY_HEADER` /
  `CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST` for a door that stacks CloudFront over
  its own ALB.

  The framework-injected CORS hosting origin matches case-insensitively (an
  ALB's DNS name is case-preserving, the browser's `Origin` is lower case); the
  app's own `CORS_ALLOWED_ORIGINS` patterns keep their case sensitivity.

  `bb-auth-basic` sessions work behind a TLS-less ALB: its same-origin session
  cookie drops `Secure` when the deployed front door serves over plain HTTP
  (`isInsecurePublicOrigin()` and `plainHttpOrigin` in
  `@aws-blocks/auth-common/cookies`). The other auth Building Blocks still set
  `Secure`, so use an HTTPS door with them. Behind `'none'` (an HTTP S3 website
  calling a cross-site API), auth needs `crossDomain: true`; that cookie keeps
  `Secure` and `Partitioned`.

- f8bfab1: fix(hosting): pages that render on demand inside a Nuxt/Nitro ISR folder no longer 404

  With an ISR or SWR route rule that names a folder in `public/` (for example `routeRules: { '/blog/**': { isr: 60 }, '/blog/featured': { prerender: true } }`), the Nitro adapter used to emit a blanket static `/blog/*` route for the folder. Every front door takes the first match, so `/blog/any-other-post` went to the static asset origin and returned 404, including when the prerendered page sat one folder deeper (`/blog/2024/featured`).

  The folder no longer gets a blanket static route. Instead:

  - Its real files keep their own static routes: each file directly in the folder (`/blog/hero.png`), and one route per sub-folder that holds no pages (`/blog/img/*`). They're still served from S3.
  - A page frozen by an explicit `prerender: true` rule keeps its own routes and is still served frozen from S3.
  - Every other path under the folder goes to the server and renders on demand.

  `RouteBehavior` has a new optional `exact` field. A route marked `exact` keeps its own row in the front door's route table: it isn't merged with its siblings into a `<parent>/*` wildcard, and it isn't switched to the server when ISR/SWR is active. The Nitro adapter sets it for the routes above. A site-wide rule (`'/**'`) and apps without ISR/SWR rules are unchanged.

- 3ae22e6: fix(hosting): build Next.js apps with a verified OpenNext version, and explain Edge-route and version mismatches

  - **`@opennextjs/aws` not installed.** Hosting declares OpenNext as an optional peer dependency, so nothing installs it for the app, and a bare `npx @opennextjs/aws build` downloaded the newest release, which is often outside the version range the Next.js adapter is verified against. When the project doesn't declare it, the adapter now builds with `@opennextjs/aws@4.0.3` and prints the command to declare it (`npm install --save-dev @opennextjs/aws@~4.0.3`). If that build fails, it throws `OpenNextNotFoundError` with the same command. Before this change that error could never be raised.
  - **Next.js outside OpenNext's `next` peer range.** When the app's `next` version is outside the range the building OpenNext declares (for example `next@15.5.7` with `@opennextjs/aws@4.0.3`, which requires `>=15.5.18 <16 || >=16.2.6`), the adapter now prints a warning naming both versions and the range. Package managers that skip peer checks would otherwise build an untested pair without a word.
  - **Edge routes on a stack without a region.** A Next.js route with `runtime = 'edge'` is built as Lambda@Edge, which needs the stack's region at synth time. On a stack with no explicit `env.region`, synth failed with CDK's `stacks which use EdgeFunctions must have an explicitly set region`. Hosting now throws `EdgeComputeRequiresRegionError`, which names the route's compute and shows the `env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }` fix.
  - **Package versions in workspaces and monorepos.** The Next.js, Astro, Nuxt and SvelteKit adapters now read `next`, `@opennextjs/aws`, `astro`, `@astrojs/node`, `nitropack`, `@nuxt/image`, `@sveltejs/kit` and `@sveltejs/adapter-node` from the app's own directory. They previously started at its parent, so an app that pins a different version than the one hoisted to the workspace root got the root's version. For example, a Next.js 15 app under a root `next@16` had the Next.js 16 image-optimizer patch applied and missed the peer-range warning.
  - **Local images on Next.js 15.5.16+ and 16.2.0–16.2.4.** The adapter patches OpenNext's call to Next.js's `fetchInternalImage` when Next.js takes an extra `maximumResponseBody` argument. It decided by major version (patch on 16, skip on 15), but that argument arrived in patch releases: it is in 15.5.16 and later, and in 16.2.5 and later, but not in 16.0.x, 16.1.x or 16.2.0–16.2.4. So `/_next/image` returned 500 (`TypeError: … is not a function`) for local images on Next.js 15.5.16+ and on 16.2.3–16.2.4. The adapter now reads the signature from the installed `next` (falling back to those version boundaries).
  - The `@opennextjs/aws` peer dependency range is now bounded: `>=3.10.0 <5.0.0`.
  - `@aws-blocks/create-blocks-app`: the `nextjs` template declares `@opennextjs/aws` (`~4.0.3`) as a devDependency, so new Next.js apps build with a pinned, verified OpenNext.

- 48c35f6: Scripts that use a local `Database` or `DistributedDatabase` now exit when they finish. Before, a short-lived script that imported your backend under local development (a seed script, a one-off CLI step, a test) kept running forever after its last query, because the local database engine held the process open. The local engine also now shuts down cleanly when the process exits, so the next start no longer logs `Removed stale postmaster.pid`. Your local data in `.bb-data/` persists as before, and `npm run dev` is unaffected: the dev server keeps running and serving queries until you stop it.
- d366907: fix: closing a local Database or DistributedData engine no longer hangs with PGlite 0.5.10

  PGlite 0.5.10's `close()` never resolves while the instance is still initializing. An engine destroyed before its
  first query, for example in a test teardown or a process shutting down early, would hang forever. `destroy()` now waits
  for PGlite's initialization to settle (or fail) before closing.

- 48c35f6: fix(core): let API errors clear cookies, and deliver cookies on HTTP API / Function URL events

  - **An API method that throws can now clear cookies in the same response**,
    both locally and on AWS. Before, an error response dropped every
    `Set-Cookie` the method had set, so a method could not, for example, reject
    with a 401 _and_ clear a stale session cookie in one call. Now cookies that
    are being deleted (`Max-Age` of 0 or less, or an `Expires` in the past) are
    delivered with the error. Any other cookie set before the throw is still
    dropped, so a method that signs a user in and then rejects them (for example
    a post-sign-in access check that throws a 403) never hands out a live
    session. The error itself is unchanged, the method's other response headers
    are still not sent with an error, and errors without cookies are returned
    exactly as before. Successful responses and `RawRoute`s are unaffected.
  - **Multiple cookies now work when the Lambda handler is invoked with the
    API Gateway HTTP API / Function URL event format (payload version 2.0).**
    `Set-Cookie` values are returned in that format's `cookies` list, for both
    API methods and `RawRoute`s. The default deployment (API Gateway REST API)
    is unaffected.

- 48c35f6: fix(core): cookies set by an API method are no longer dropped on AWS when more than one is set

  When an `ApiNamespace` method set more than one cookie in a single response
  (for example `context.response.headers.set('set-cookie', …)` followed by
  `append('set-cookie', …)`), only one of them reached the browser on AWS — the
  others were silently lost. Local development was unaffected, so the problem
  only appeared after deploying. Every `Set-Cookie` value is now delivered,
  matching how `RawRoute` responses already behaved. This also fixes `Auth`
  responses that set both the session cookie and the auto-sign-in cookie.

- 72e3259: fix(core): stop `npm run sandbox` printing a DEP0190 deprecation warning on Node 24

  The sandbox started the local dev server by splitting its command on spaces and passing the pieces as separate args together with `shell: true`. Node 24 warns about that combination (DEP0190, args are concatenated rather than escaped). The command now goes to the shell as a single string, so the warning is gone and the dev server starts exactly as before.

- b16e5b6: feat(create-blocks-app): add a one-shot `npm run sandbox:deploy` script to every deployable template

  `npm run sandbox` deploys and then keeps running (CDK watch plus the local dev server), so it never exits and can't be used from scripts or CI. The new `npm run sandbox:deploy` runs the same sandbox script with `--deploy-only`: it deploys once, writes `.blocks-sandbox/config.json`, prints the `BLOCKS_DEPLOYED api=…` line, generates the typed client, and exits. Wait for exit code 0 rather than for the line, since the client is generated after it. `npm run sandbox` is unchanged. The template READMEs and the scaffolded `AGENTS.md` list the new script.

  Existing apps can adopt it by adding `deployOnly: process.argv.includes('--deploy-only')` to the `startSandbox({ ... })` call in `aws-blocks/scripts/sandbox.ts`, and a `"sandbox:deploy": "tsx aws-blocks/scripts/sandbox.ts --deploy-only"` script to `package.json`.

- 48c35f6: `npm run sandbox` telemetry now reports which Building Blocks your app uses (when telemetry is enabled); before, it always reported none. The sandbox now generates the deployed client before deploying, as `npm run deploy` does, so `aws-blocks/client.js` is ready before the deploy starts and an error in the backend surfaces before the deploy rather than after it. The deploy itself is unchanged.
- 0d4ede3: refactor(core, bb-kv-store, bb-distributed-table): share one DynamoDB PITR + encryption resolver

  No synth output change: the same CloudFormation template and the same synth warnings are produced.

  The point-in-time-recovery and encryption resolution — the `retentionDays` 1–35 validation, the `aws-managed`/`customer-managed`/`fromKmsKey` encryption selection, and the auto-created-CMK removal-policy alignment — was duplicated almost line-for-line between the two Blocks-provisioned DynamoDB tables (`bb-kv-store`, `bb-distributed-table`). Both blocks now resolve that behaviour through one shared internal helper in `@aws-blocks/core`. Durability (`removalPolicy`/`deletionProtection`) stays in each block, since the two surface it through different options.

- 63b154f: Document the shared API gateway. The `@aws-blocks/core` README gains a "Shared API gateway" section covering how every path reaches the backend, per-namespace paths, default throttling, opt-in access logs, the 29-second / 10 MB limits, and attaching WAF to the gateway stage or to Hosting's CloudFront distribution. The `bb-lambda-compute` design notes now describe the multi-compute routing: catch-all resources go to the default compute, and per-namespace resources go to the others.
- b6b8ade: fix(core): find the `ApiNamespace` handler by position when generating the native-client spec

  The OpenRPC spec generator took the **last** `new ApiNamespace(...)` argument as
  the handler. Given an argument after the handler (an options object), it read
  that instead: the namespace's methods came out with `unknown` types in the
  Swift, Kotlin and Dart bindings, and methods tagged `@blocksSkipCodegen` leaked
  into the spec. It now uses the handler argument itself, whatever follows it.

- 48c35f6: Vendorized apps using `DistributedTable` with an index, `Database` with migrations, or `DistributedDatabase` now synthesize. A vendorized copy (`npm run vendorize -- <Block>`) contains only the TypeScript sources, so these blocks' deploy-time Lambdas (the GSI manager and the migration runner) previously failed synth with `Cannot find asset` or `Cannot find entry file`. Their handlers are now bundled from the vendorized source at synth, so your edits to them deploy too. Installed (non-vendorized) apps are unchanged: their Lambda assets are byte-for-byte the same.

  The helpers that do this, `deployTimeLambdaCode()` and `deployTimeLambdaEntry()`, are framework-internal (`@aws-blocks/core/cdk/internal`), for Building Blocks in this repository that ship a pre-bundled or compiled Lambda handler; they are not on the public `@aws-blocks/core/cdk` or `@aws-blocks/blocks/cdk` entry.

- Updated dependencies [5dc1d98]
- Updated dependencies [48c35f6]
- Updated dependencies [d1d129f]
- Updated dependencies [0765f84]
- Updated dependencies [5572341]
- Updated dependencies [43603b0]
- Updated dependencies [88747f5]
- Updated dependencies [1076ccc]
- Updated dependencies [763f67e]
- Updated dependencies [aaa90b6]
- Updated dependencies [72c8165]
- Updated dependencies [33edca2]
- Updated dependencies [928c48a]
- Updated dependencies [4d5ea86]
- Updated dependencies [90c1b12]
- Updated dependencies [1d58d60]
- Updated dependencies [dbe7df6]
- Updated dependencies [c3a3b44]
- Updated dependencies [72b5fe0]
- Updated dependencies [7114399]
- Updated dependencies [92909f8]
- Updated dependencies [ee69cd7]
- Updated dependencies [8cff0bb]
- Updated dependencies [943d405]
- Updated dependencies [23fc09f]
- Updated dependencies [50b8c94]
- Updated dependencies [a3969b5]
- Updated dependencies [a3969b5]
- Updated dependencies [943d405]
- Updated dependencies [943d405]
- Updated dependencies [943d405]
- Updated dependencies [943d405]
- Updated dependencies [943d405]
- Updated dependencies [943d405]
- Updated dependencies [943d405]
- Updated dependencies [943d405]
- Updated dependencies [943d405]
- Updated dependencies [a3969b5]
- Updated dependencies [a3969b5]
- Updated dependencies [48c35f6]
- Updated dependencies [ce5dfa9]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [9a32674]
- Updated dependencies [48c35f6]
- Updated dependencies [8c73a24]
- Updated dependencies [48c35f6]
- Updated dependencies [4553866]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [54e9443]
- Updated dependencies [48c35f6]
- Updated dependencies [492d744]
- Updated dependencies [414df36]
- Updated dependencies [d1b4900]
- Updated dependencies [d366907]
- Updated dependencies [91ed1fc]
- Updated dependencies [48c35f6]
- Updated dependencies [d062eeb]
- Updated dependencies [c22eeee]
- Updated dependencies [1546160]
- Updated dependencies [a3969b5]
- Updated dependencies [e68e653]
- Updated dependencies [9aa8ae2]
- Updated dependencies [92c4b20]
- Updated dependencies [27c35e5]
- Updated dependencies [1d8ed6c]
- Updated dependencies [2f59ce5]
- Updated dependencies [3142985]
- Updated dependencies [9c96135]
- Updated dependencies [0ee86e1]
- Updated dependencies [48c35f6]
- Updated dependencies [ea57feb]
- Updated dependencies [63b154f]
- Updated dependencies [8565ef7]
- Updated dependencies [ce5dfa9]
- Updated dependencies [2c73654]
- Updated dependencies [515089c]
- Updated dependencies [a02549a]
- Updated dependencies [dde6340]
- Updated dependencies [f8bfab1]
- Updated dependencies [7477b6e]
- Updated dependencies [3ae22e6]
- Updated dependencies [c8c26f7]
- Updated dependencies [6a53068]
- Updated dependencies [3803f19]
- Updated dependencies [3b5a419]
- Updated dependencies [dd5e807]
- Updated dependencies [48c35f6]
- Updated dependencies [14ee6f1]
- Updated dependencies [d366907]
- Updated dependencies [db15b5e]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [72e3259]
- Updated dependencies [48c35f6]
- Updated dependencies [8565ef7]
- Updated dependencies [3d83cb6]
- Updated dependencies [48c35f6]
- Updated dependencies [0d4ede3]
- Updated dependencies [63b154f]
- Updated dependencies [c0f6a83]
- Updated dependencies [b6b8ade]
- Updated dependencies [82ea78a]
- Updated dependencies [e44ac0c]
- Updated dependencies [33e8d73]
- Updated dependencies [b003705]
- Updated dependencies [f704a68]
- Updated dependencies [48c35f6]
  - @aws-blocks/bb-agent@0.7.0
  - @aws-blocks/bb-knowledge-base@0.3.0
  - @aws-blocks/core@0.8.0
  - @aws-blocks/bb-compute@0.2.0
  - @aws-blocks/bb-app-setting@0.4.0
  - @aws-blocks/bb-async-job@0.3.0
  - @aws-blocks/bb-auth-cognito@0.2.0
  - @aws-blocks/bb-auth-oidc@0.3.0
  - @aws-blocks/bb-container-compute@0.2.0
  - @aws-blocks/bb-cron-job@0.4.0
  - @aws-blocks/bb-dashboard@0.3.0
  - @aws-blocks/bb-data@0.5.0
  - @aws-blocks/bb-distributed-data@0.3.0
  - @aws-blocks/bb-distributed-table@0.3.0
  - @aws-blocks/bb-email-client@0.2.0
  - @aws-blocks/bb-file-bucket@0.4.0
  - @aws-blocks/bb-kv-store@0.4.0
  - @aws-blocks/bb-lambda-compute@0.7.0
  - @aws-blocks/bb-logger@0.3.0
  - @aws-blocks/bb-metrics@0.2.0
  - @aws-blocks/bb-realtime@0.5.0
  - @aws-blocks/bb-secret@0.3.0
  - @aws-blocks/bb-tracer@0.3.0
  - @aws-blocks/hosting@0.5.0
  - @aws-blocks/bb-auth-basic@0.2.0
  - @aws-blocks/auth-common@0.3.0

## 0.8.0

### Minor Changes

- ec7eebe: feat(bb-secret): add the `Secret` Building Block — a single application secret backed by AWS Secrets Manager

  Introduces `@aws-blocks/bb-secret`, re-exported from `@aws-blocks/blocks` as `Secret` (and `SecretErrors`, `SecretOptions`). Each instance is one high-value credential — a third-party API key, OAuth client secret, database connection string, webhook signing key, or encryption key — stored in AWS Secrets Manager (distinct from `AppSetting`, which is backed by SSM Parameter Store).

  - `get(options?): Promise<T | null>` — reads the value, returning `null` when unset or missing (no throw for not-found). `options.version` reads `'current'` (default), `'previous'` (the value before the last change — a rotation grace window), or a specific `SecretVersion` from `listVersions()`.
  - `put(value): Promise<void>` — sets or updates the value at runtime; the prior value becomes the `'previous'` version.
  - `listVersions(): Promise<SecretVersionInfo[]>` — lists retained versions (metadata only, newest first — never values); a returned item passes straight to `get({ version })`.
  - `Secret.fromExisting(arn)` — reference a secret owned outside the stack (no create/seed/delete/tag; read/write + grant only). The sanctioned path for centrally-managed secrets shared across many installations.
  - `name?` — an explicit, well-known Secrets Manager secret name so a team or CI/CD pipeline can set/rotate the value out-of-band via the `aws` CLI; defaults to a name derived from the scope tree.
  - `generate?` — when `true`, seed a random value on first create (signing/HMAC keys that only need to exist); the mock seeds an equivalent value so local and deployed behavior match. **A BB-created secret is otherwise empty by default** — `get()` returns `null` until a value is set, matching the mock and the configure-after-deploy model. (Don't combine `generate` with `schema`: a random string isn't valid JSON.)
  - Optional `schema` (any StandardSchemaV1 — Zod/Valibot/ArkType) for typed JSON secrets with validation on `get`/`put`.
  - `cacheTtlSeconds?` — the runtime caches each fetched value in-process so steady-state reads skip the API; a cached value is held for this long before the next `get()` re-fetches. **Defaults to 300s (5 minutes)**, matching the AWS Secrets Manager agent, so even a long-running process can't serve a rotated value indefinitely; `0` disables caching, and `put()` always clears the cache. Ignored by the mock.
  - `removalPolicy` per-instance override; otherwise follows the stack-wide defaults (production retains, sandbox destroys).

  **Versions & rotation.** `get({ version })` + `listVersions()` expose the current/previous values and the labeled version list, so a key rollout can validate against the previous value during a grace window. `listVersions()` returns the labeled versions (current + previous); anything beyond that is left to the AWS SDK against the secret ARN (exposed on the CDK construct as `secret.secretArn`; the runtime/mock classes deliberately don't expose AWS primitives). The read surface is an options object with a `SecretVersion` / `SecretVersionInfo` (base/subtype) handle contract, so deeper access can be added non-breaking. Automatic rotation is intentionally out of scope — it is credential-type-specific (AWS ships hosted rotators only for database engines); rotate via `put()`/console/CLI, or drive `put()` from a `CronJob` for a custom schedule.

  **Management & lifecycle.** A declaration carries only the name, never the value. Values are set out-of-band via three complementary approaches: auto-generated (random, via `generate: true`, for opaque values); the built-in `/aws-blocks/settings` route (redirects to the settings resource group in the console when deployed, opens `.bb-data/settings.json` locally); or a well-known `name` + the `aws secretsmanager` CLI for CI/CD. There is intentionally no constructor-time value seeding (no source literals, no env-seeding) — consistent with how hosting `secret()` separates declare from set.

  **Resource group + local settings route (`@aws-blocks/core`).** BB-created secrets are tagged `aws-blocks-stack=<stackName>` and the stack's `-settings` resource group now matches `AWS::SecretsManager::Secret` alongside `AWS::SSM::Parameter`, so secrets appear next to `AppSetting` parameters in the console. The local mock persists to the shared `.bb-data/settings.json` (the same file `AppSetting` uses), and the `/aws-blocks/settings` route copy now covers both AppSetting and Secret values — one route for settings and secrets, local and deployed.

  The CDK layer provisions one `secretsmanager.Secret`, grants the shared execution role scoped `GetSecretValue` + `PutSecretValue`, requests the Secrets Manager interface VPC endpoint, and passes the ARN to the runtime via `registerConfig` (`BLOCKS_SECRET_ARN_<ID>`). Runtime methods are `synthGuard`-stubbed on the construct. The browser entry throws `NotSupported`. Covered by unit tests (mock + CDK synth) and the shared `test-apps/comprehensive` e2e suite (local/sandbox/production).

- 8f725b6: fix(bb-data): enable Aurora storage encryption, backup retention, and log export

  Hardens the Aurora Serverless v2 cluster synthesized by `Database`:

  - **Storage encryption at rest** is opt-in via the
    `@aws-blocks/bb-data:encryptStorageByDefault` context flag — set in the new
    `create-blocks-app` cdk.json templates, so new projects encrypt by default with
    the AWS-managed `aws/rds` key. A new optional `storageEncryptionKeyArn` (the ARN
    of a customer-managed KMS key) turns encryption on regardless of the flag and
    also encrypts the auto-generated credentials secret. When neither is set, the
    `StorageEncrypted` property is left unset (so an existing cluster is untouched)
    and a synth warning explains how to opt in.
  - **Automated backups** are on by default and retained **15 days**; this is also
    the point-in-time-recovery window. A single `pointInTimeRecovery` option
    controls it (mirroring every other Blocks block): `true` enables the 15-day
    window, `{ retentionDays: n }` pins a 1–35-day window, and `false` clamps to the
    1-day minimum (Aurora cannot disable automated backups). When omitted it follows
    the stack-wide `defaults.pointInTimeRecovery` (on under `production`, off under
    `sandbox`).
  - **CloudWatch log export** — the PostgreSQL engine log is exported to CloudWatch
    Logs, with retention following the stack-wide `defaults.logRetention`.
  - `iamAuthentication` remains intentionally off (access is exclusively via the RDS
    Data API), and automatic secret rotation is documented as a follow-up.

  `@aws-blocks/create-blocks-app` scaffolds this default into new projects: every
  template's `cdk.json` now sets the `@aws-blocks/bb-data:encryptStorageByDefault`
  context flag, and the Amplify overlay sets the same flag via `setContext`. As a
  result, a `Database` created in a newly scaffolded project encrypts its storage at
  rest by default.

  **Breaking for existing stacks (0.x minor = breaking channel):** the
  backup-retention and CloudWatch log-export changes alter synthesized cluster
  properties, so existing stacks will show a CloudFormation diff.

  Storage encryption is **opt-in** specifically so it does **not** silently replace
  existing clusters: with neither the context flag nor a `storageEncryptionKeyArn`
  set, the `StorageEncrypted` property is left unset and the existing cluster is
  untouched. Opting in (setting the flag, or supplying a key) on an
  already-provisioned, unencrypted cluster requires a **replacement**, and the
  replacement is destructive: RDS cannot encrypt an existing cluster in place, so
  CloudFormation creates a **new, empty** encrypted cluster and repoints the stack.
  There is no in-place path. The migration CustomResource does **not** re-run on a
  cluster swap — its only CloudFormation properties are the service token and the
  migrations hash, neither of which changes when the cluster is replaced — so the new
  cluster comes up with **no schema**; migrations run only when a migration file
  changes (which changes the migrations hash). Under production (RETAIN) the old
  cluster is orphaned/unreferenced; under sandbox (DESTROY) it and its data are
  deleted; under `removalPolicy: 'snapshot'` it is snapshotted as it is replaced
  (though under production's `deletionProtection: true` the follow-up delete may fail
  and leave it in place, unverified on a real deploy). The only safe route is to
  snapshot the existing cluster, restore it with encryption enabled, then cut over.
  Review the diff and snapshot before deploying. The replacement is symmetric:
  turning encryption back off — removing the flag (or `storageEncryptionKeyArn`) from
  a project that already deployed encrypted, e.g. deleting the cdk.json line or a
  merge dropping it — also changes `StorageEncrypted` and so likewise replaces the
  cluster (back to unencrypted), with the same new-empty-cluster / no-schema outcome.

- 4ae500e: feat(create-blocks-app): add a dev:stop command for the local dev server

  Adds a first-class, sanctioned way to stop the local dev server, so there is an
  alternative to `pkill -f tsx` / `killall node` — which match by process name and
  can kill the caller's own shell/agent process.

  - `@aws-blocks/core/scripts` (re-exported by `@aws-blocks/blocks/scripts`) gains
    `stopDevServer`, the CLI entry `runStopCli`, `stopMessage`, and the
    `StopResult` type. Stop acts ONLY on the supervisor identity the dev server
    recorded in its own pidfile (`{pid, ppid, port}`): it SIGTERMs the recorded
    `tsx watch` watcher — the only thing that actually ends `npm run dev` — and
    falls back to the recorded child's listener tree only when the watcher is
    gone. It never scans a port and signals an arbitrary listener, so a stale
    pidfile or an unrelated same-port process is never touched, and the pidfile is
    removed only once the port is confirmed free. Idempotent; never throws;
    `runStopCli` exits non-zero when the stop leaves the port bound.

  - `@aws-blocks/create-blocks-app`: every standalone template gains a `dev:stop`
    npm script and a thin `stop.ts` wrapper; the existing-project and Amplify
    integration paths get `dev:stop` / `blocks:stop` too. The scaffolded
    `AGENTS.md` and the singleton-guard message point at `npm run dev:stop`
    instead of `pkill` / the blunt cleanup script.

- 6d764f7: `AWS_BLOCKS_DISABLE_TELEMETRY` now accepts `true` and `yes` in addition to `1` (case-insensitive, trimmed).

  Previously only the exact value `1` disabled telemetry, so `AWS_BLOCKS_DISABLE_TELEMETRY=true` kept telemetry on. Both packages now accept `1`, `true` and `yes`; `0`, `false`, empty and unset keep telemetry enabled. The `blocks-telemetry --help` output lists the accepted values, and the D-010 usage note in `docs/DECISIONS.md` is updated to match.

  Behavior change (0.x minor = breaking channel): if you already export `AWS_BLOCKS_DISABLE_TELEMETRY=true` or `=yes` for another tool, Blocks telemetry is now disabled where it was previously still on.

- 94a914a: A native package's Dart `name` and `library` are now validated against the
  grammar the Dart generator interpolates them into, and a binding's `export`
  against the one every generator upper-camel-cases, instead of both only being
  checked for a non-blank string. A Dart `name` of `blocks_runtime` is rejected
  because every generated client already imports that library. A value such as
  `My-Package`, `lib/x.dart` or `device link` used to pass spec generation and then
  break codegen in the customer's app, where the block that declared it is no
  longer visible. Swift and Android fields are unaffected.

  `@aws-blocks/blocks` gets the same bump because it re-exports `@aws-blocks/core/scripts`.

- cb0ec01: `blocks.spec.json` can now carry two top-level OpenRPC extensions,
  `x-blocks-native-packages` and `x-blocks-native-bindings`, so native codegen can
  resolve a transferable tag to a package export instead of a hard-coded switch.
  `generateSpec` and `writeSpec` take a new trailing `SpecGenerationOptions`
  carrying the declarations, and invalid metadata throws `NativeCatalogError`
  before any file is written. Nothing populates the declarations yet, so a
  generated spec is unchanged.

  `@aws-blocks/blocks` gets the same bump because it re-exports `@aws-blocks/core/scripts`.

- 005c095: feat(core): read native package and binding declarations from each block's package.json

  A Building Block declares its native packages and transferable bindings under an
  `aws-blocks.native` key in its own `package.json`. `blocks-generate-spec` reads
  that key from every `node_modules` level from the spec project upward and emits the
  `x-blocks-native-packages` and `x-blocks-native-bindings` catalogs, which until
  now nothing populated. Each import specifier resolves to its nearest installed copy,
  as in Node's own resolution. The new `readNativeDeclarations` export supplies the
  same declarations to a project that calls `writeSpec` directly instead of through
  the bin.

  A spec generated for an app where no block declares the key is byte-identical to
  before.

  `blocks-generate-spec` names the packages whose declarations it read, so an author
  can see that an installed dependency contributed a native binding. The line is
  omitted when nothing declares any.

  Generation now exits non-zero without writing a file when an installed block's
  declarations are invalid, or when an installed `package.json` cannot be parsed
  while it carries the `aws-blocks` key — such a manifest cannot be ruled out as a
  declarer, so it is not treated as declaring nothing. A `node_modules` directory
  or a manifest that cannot be read for a reason other than absence, and an
  unparseable manifest that does not carry `aws-blocks` as a JSON key, are warned
  and skipped. A byte-order mark is accepted, as npm accepts one. A `packages` or
  `bindings` set to `null` is now reported rather than read as absent.

  A native declaration error raised before any block could be named now reports
  the position the pass had reached.

  `NativeDeclarationInput` is the same shape with `packages` and `bindings` typed
  `unknown`, which is what a `package.json` yields before anything checks it.
  `SpecGenerationOptions.nativeDeclarations` accepts it, and a typed
  `NativeDeclarationSource` built in code still assigns and stays readable. Code
  that reads `SpecGenerationOptions.nativeDeclarations` back narrows it to the
  exported `NativeDeclarationSource`.

  `@aws-blocks/blocks` gets the same bump because it re-exports `@aws-blocks/core/scripts`.

- 66f4be2: BREAKING: remove `BlocksStack.handler`, `BlocksBackend.handler`, and `Scope.handler`.

  These returned the default compute's Lambda function, so anything wired through them reached only that one function — not every compute an app runs on. Use the stack-wide equivalents instead, which reach every compute:

  | Before                                              | After                                                                                                                                         |
  | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
  | `blocksStack.handler.addEnvironment('KEY', value)`  | `registerConfig(blocksStack, 'KEY', value)` — loaded into `process.env` on every compute at cold start, before the backend module is imported |
  | `resource.grantRead(blocksStack.handler)`           | `resource.grantRead(blocksStack.executionRole)`                                                                                               |
  | `blocksStack.handler.addToRolePolicy(statement)`    | `blocksStack.executionRole.addToPrincipalPolicy(statement)`                                                                                   |
  | `this.handler` inside a custom Building Block       | `this.executionRole` / `registerConfig(this, …)`                                                                                              |
  | `handler.addEnvironment('CORS_ALLOWED_ORIGINS', …)` | `defaults: { ...BlocksPresets.production, allowedOrigins: [...] }`                                                                            |

  `registerConfig` and `executionRole` are exported from `@aws-blocks/blocks/cdk` (and `@aws-blocks/core/cdk`).

  **Precedence differs from `addEnvironment`.** `addEnvironment` wrote a real Lambda environment variable, so the last call won. `registerConfig` entries are loaded at cold start only into keys that aren't already set, so a real environment variable of the same name always wins — for example one the framework sets itself (`NODE_ENV`, `BLOCKS_STACK_NAME`) or one set on the function outside CDK. When that happens with a different value, the compute now logs a warning at cold start naming the ignored keys (names only, never values).

  `registerConfig` can be called from app code after `BlocksStack.create()` / `BlocksBackend.create()` resolves. This already worked for every stack, because the framework always registers config of its own; finalize now creates the config deployment unconditionally, so it no longer depends on that.

- 122c49c: fix(telemetry): honor opt-out when `--telemetry-file` is set

  The flag let an opted-out run build an event, which persisted the installation ID to `~/.blocks/telemetry/installation-id` and printed the first-run notice, and in `@aws-blocks/core` also persisted a project ID into `<project>/.blocks/config.json`. Consent is now checked before the event is built, and in `@aws-blocks/create-blocks-app` again before it is emitted, so an opt-out landing mid-command is honored too. A disabled run writes no identifiers, prints no notice, writes no file and sends no HTTP. `--telemetry-file` now also ignores a whitespace-only path in the space-separated form, matching the `=` form.

  Behavior change (0.x minor = breaking channel): to capture events without sending them, use `BLOCKS_TELEMETRY_ENDPOINT=http://127.0.0.1:1 <cmd> --telemetry-file=<path>` rather than combining the flag with `AWS_BLOCKS_DISABLE_TELEMETRY`. The detached send worker still runs and fails fast against port 1. That run is consented, so it still writes the installation ID and prints the notice.

- 8ca3692: feat: shared, framework-neutral `ui-theme` design-token layer

  Introduce a design-token layer for the Blocks UI so the shared Auth
  components and the starter templates share one consistent, polished look
  with no new runtime framework dependency.

  - `@aws-blocks/auth-common` ships a new theme module: CSS custom
    properties (`--bb-*` for color, spacing, radius, typography, elevation)
    on `:root`, a light and dark palette driven by `prefers-color-scheme`
    with a `data-bb-theme` override hook, and base `.bb-*` component
    classes. The palette declares `color-scheme` so UA-drawn widgets
    (checkboxes, `<select>`, scrollbars, `::placeholder`, autofill) follow
    the active palette, and `.bb-button` has a `:disabled` state. A new
    idempotent, SSR-safe `injectTheme()` adds the stylesheet to the document
    once. The shared `Authenticator`, `AccountMenuBar`, and
    `AuthenticatedContent` now render against these token classes instead
    of inline styles and inject the theme themselves, so the themed look
    travels with the component into any host (lit-html, vanilla, React,
    Next.js) with zero wiring. Every `data-testid` is preserved.
  - `@aws-blocks/blocks` re-exports `injectTheme`, `THEME_CSS`, and
    `THEME_STYLE_ID` from `@aws-blocks/blocks/ui`, and adds a lean
    `@aws-blocks/blocks/theme` subpath that re-exports ONLY the token layer
    (no `Authenticator`/WebAuthn surface) for non-auth hosts. `@aws-blocks/auth-common`
    is marked `sideEffects: false` so a bundler can drop the unused UI
    surface; `@aws-blocks/blocks` is not, because as an aggregator that
    re-exports side-effecting building blocks it is not side-effect-free.
  - `@aws-blocks/create-blocks-app` templates (`default`, `react`,
    `nextjs`, `demo`, `auth-cognito`) adopt the tokens for their own page
    chrome and todo UI, so the whole page is themed and dark-mode-aware;
    the `bare` template stays deliberately minimal. The static templates
    inline the first-paint palette and the `nextjs` template server-renders
    the token `<style>` so a dark-mode user never sees a white flash before
    the bundle runs. A `--bb-color-success` token keeps success messages
    from reading as accent blue.

  Focus states use a real `outline` ring (preserved under forced-colors /
  Windows high-contrast mode) rather than an `outline: none` + `box-shadow`
  ring, which such modes drop.

  Additive and non-breaking.

### Patch Changes

- f8fbc6e: fix(bb-agent): capture the concrete S3 error shape when a deployed Agent's session snapshot cannot be read

  A brand-new conversation has no session snapshot; `S3Storage` already returns
  `NoSuchKey`/`NoSuchBucket` as `null` (and a missing manifest as empty), which
  Strands' `SessionManager` treats as "start fresh", so a genuine first turn is
  not affected. When a snapshot read fails for some OTHER reason — `AccessDenied`,
  a 5xx, a corrupt object — the error now carries actionable diagnostics: the
  deepest cause's `name`, `httpStatusCode` and `requestId` are flattened out of
  the non-enumerable `.cause` (which `bb-logger` otherwise never serializes) and
  logged at `error` level by `runAgent`, so the concrete production error shape is
  recorded for the first time instead of only the opaque `S3 error reading <key>`
  message.

  The read paths deliberately still RETHROW a non-missing fault rather than
  starting fresh: `SessionManager` overwrites `snapshot_latest.json` after a fresh
  start, so swallowing a transient read fault would silently overwrite an
  established conversation's saved history with a blank one. Surfacing the error
  (and now capturing its shape) is the correct behaviour. No public API change —
  `createDeployedSnapshotStorage` is internal and gains a `log: ChildLogger`
  parameter `(bucket, log, S3StorageImpl?)` so the logger is threaded to the
  storage seam.

- 59c9dde: docs(bb-auth-basic): add the frontend login-UI mount + gate seam

  The Quick Start documented the backend (`createApi()`, `requireAuth`) but not
  the frontend half, so builders and agents provisioned `AuthBasic` and assumed a
  login UI would appear — nothing rendered, leaving every authenticated route
  unreachable. The README now shows the end-to-end seam: import
  `Authenticator` / `AuthenticatedContent` from `@aws-blocks/blocks/ui`, mount the
  login UI in the SPA entrypoint, and gate the app shell behind an authenticated
  session, with a pointer to the already-shipped testid contract
  (`authenticator-<field>` / `authenticator-action-<action>`) in
  `auth-common/CUSTOMIZING-AUTH-UI.md`.

  Documentation only — no runtime or API change.

- e682ba7: `LambdaCompute` now reports `bbName`/`bbVersion` to `Scope`, so it appears in telemetry like every other Building Block.

  `LambdaCompute` passed no `bbName` to `Scope`, and `Scope` records a block in its registry only when `bbName` is set, so `Scope.getRegisteredBlocks()` could never name the default compute and `product.buildingBlocks` omitted it. The package already carried the standard `prebuild` (`generate-version.mjs LambdaCompute`), which generates the `BB_NAME`/`BB_VERSION` its constructor now passes through — the same wiring the other blocks use.

  `LambdaCompute` has no customer-facing export, so it is deliberately absent from the umbrella's `aws-blocks.vendorize` map that `scripts/generate-bb-names.mjs` reads. The generator now also emits a `NON_VENDORIZED_BB_NAMES` list, adding it to `OFFICIAL_BB_NAMES` so it is reported as an official block rather than filtered as an unnamed custom one. `@aws-blocks/core` is bumped because that generated file changes; the `cdk` entry point is left alone, as telemetry is reported by the runtime class, not the synth-time construct.

  The default compute is built only at CDK synth, in a child process whose registry no telemetry path reads, so nothing constructs one where telemetry is emitted. Importing `@aws-blocks/blocks` through its default (Node) entry now declares it instead: `Scope._setDefaultBlockForTelemetry` records its name and version, and `getRegisteredBlocks()` folds that in only when telemetry actually reads the registry.

  Declaring rather than constructing keeps the import inert — a process that imports the umbrella and emits no telemetry leaves `totalCount` untouched — and the entry is appended after the blocks the app constructed, so it never displaces them in `product.buildingBlocks`. An app-constructed `LambdaCompute` takes precedence over the declaration, so it is never counted twice. `getRegisteredBlocks()` still exposes only names already on the official list, and customer-chosen block names remain counted-but-unnamed.

- e9241b5: Add umbrella integration-test coverage asserting the shared REST API gateway wiring through the `LambdaCompute` surface. Test-only; no runtime or public API change.
- 3a7eb9e: fix: export runtime values missing from the `cdk` entry points

  Some values exported by a Building Block's default and `aws-runtime` entry points were missing from its `cdk` entry,
  so a backend file importing them crashed `cdk synth` at load time — for example, the `InterruptError` import shown in
  the `bb-agent` README failed with `does not provide an export named 'InterruptError'`. The `cdk` entries now also
  export:

  - `@aws-blocks/bb-agent`: `InterruptError`
  - `@aws-blocks/bb-async-job`: `BatchSubmitFailedError`
  - `@aws-blocks/bb-auth-cognito`: `SessionStore`; standalone session tables also enable DynamoDB TTL when a positive
    session lifetime is configured.
  - `@aws-blocks/bb-data`: `RLSEnabledDatabase`, `PgClientEngine`

  `@aws-blocks/blocks`: picks up the fixed `cdk` entries of the Building Blocks above. The conditional-export parity
  test now also checks every Building Block's `cdk` entry.

- 78f4396: CORS guidance now points at the stack's `defaults.allowedOrigins` everywhere, the stack-level setting every Blocks compute picks up. The runtime warning for a disallowed origin says to add it to `defaults.allowedOrigins` instead of setting the `CORS_ALLOWED_ORIGINS` environment variable; the core README's production example configures `defaults.allowedOrigins` instead of calling `handler.addEnvironment`, credits the sandbox preset (not the CLI) for the localhost pattern, and explains where allowed origins come from (`defaults.allowedOrigins` and, with `Hosting`, the distribution's own domain); the umbrella security checklist follows suit.
- 440ecce: When the AWS credential check before `npm run deploy` and `npm run sandbox` fails, the message now names the profile and the command that fixes its credentials. A profile without credentials gets sign-up and `aws login` guidance, with an AWS CLI install or update hint when the installed CLI does not have `aws login`. Expired `aws login` and IAM Identity Center (SSO) sessions get `aws login` or `aws sso login` for that profile. Rejected access keys, `credential_process`, web identity, a role assumed with environment keys, and environment credentials get guidance for that source. Rejected or expired credentials from outside the AWS config files, such as an instance role, get a hint to check that source instead of sign-up guidance. When AWS cannot be reached, including the SSO portal, the deploy still continues, and the warning now says that AWS could not be reached. The deploy docs and the generated app's `AGENTS.md` describe this behavior.

  `@aws-blocks/core` now requires AWS SDK for JavaScript clients 3.936.0 or later, the first version that reads credentials from `aws login` profiles.

- 92fa27b: Internal: route named-error minting through `@aws-blocks/core`'s `blocksError`. No behavior change.
- 023f02c: Internal: route the remaining per-package error mint sites through core's `blocksError`, and tighten the brand-coverage guard to per-site. No behavior change; two latent unbranded realtime timeout rejects are now wire-safe.
- 5d6656a: feat(core): add the `apiFrontDoor` prop, the `cloudfront` tier, and `publicApiUrl`

  A Blocks app's API is served by the stack's single shared API Gateway REST API. By
  default clients call that gateway's own `execute-api` endpoint — the `'apigateway'`
  tier. You can now put a Blocks-managed CloudFront distribution in front of it
  instead, with a new prop on `BlocksStackProps` / `BlocksBackendProps`:

  ```ts
  await BlocksStack.create(app, "App", {
    // …
    apiFrontDoor: "cloudfront", // default: 'apigateway'
  });
  ```

  - `'apigateway'` — clients call the API Gateway endpoint directly. Nothing extra to
    deploy; unchanged from before.
  - `'cloudfront'` — one CloudFront distribution in front of the gateway (CloudFront →
    API Gateway → Lambda), and the gateway is built as a regional endpoint so there is
    a single CloudFront layer. One catch-all behavior forwards every request to the
    gateway — uncached, all methods, everything except `Host`, HTTP→HTTPS. The
    distribution's URL is published to the runtime as `BLOCKS_PUBLIC_ORIGIN`, so
    absolute URLs the backend builds (such as AuthOIDC's sign-in callback) use it.

  **`publicApiUrl`** on `BlocksStack` / `BlocksBackend` is the URL clients should call
  under either tier: the CloudFront URL + `/aws-blocks/api` under `'cloudfront'`, else
  `apiUrl`. `apiUrl` stays the gateway's own URL (what `Hosting` forwards to). A
  `BlocksStack`'s `ApiUrl` output — what `deploy` / `sandbox` hand a client as
  `BLOCKS_API_URL` — is `publicApiUrl`; with `BlocksBackend`, emit it yourself. The
  Amplify template now publishes `publicApiUrl` as `blocks_api_url`.

  The default is a constant `'apigateway'` — it is **never** derived from the app's
  shape, so adding or removing Building Blocks never silently changes how the API is
  exposed. Any value other than `'apigateway'` or `'cloudfront'` fails synth.

  When an app fronts its frontend with `Hosting`, the API is served from Hosting's
  distribution; under `'cloudfront'` the managed distribution then stands down — one
  distribution, same origin as the frontend, no CORS and no second hop.

  ⚠️ **Switching tiers — or adding or removing `Hosting` under `'cloudfront'` —
  changes the API's endpoint domain.** Browser auth cookies and sessions are bound to
  the origin they were set on, so the change signs every user out. (A stable custom
  domain, a future feature, would avoid this.) Pick a tier, and decide on Hosting,
  before you have real users, and treat a later change as a breaking migration.

- 8b5ef4a: fix(hosting): stop the SSR REST API from leaking an IAM role on every teardown

  The SSR origin's `RestApi` relied on CDK's default `cloudWatchRole: true`, which
  provisions an account-level `AWS::ApiGateway::Account` plus a CloudWatch Logs IAM
  role with `RemovalPolicy.RETAIN`. The SSR stage enables neither execution nor
  access logging, so the role was unused, and because it is retained, every
  `cdk destroy` of a hosting SSR stack left one orphaned IAM role behind — enough,
  over repeated deploys, to exhaust the account's 3000 `RolesPerAccount` quota and
  make all subsequent deploys fail with `ServiceLimitExceeded`. The SSR `RestApi`
  now sets `cloudWatchRole: false` (matching `bb-lambda-compute`), so no role or
  `ApiGateway::Account` is created. Existing stacks drop both resources on their
  next deploy; the previously retained role is not removed by CloudFormation and
  can be deleted manually — but first check `aws apigateway get-account`: if the
  region's `cloudwatchRoleArn` still points at that role, deleting it breaks
  logging for every other API Gateway stage in the region.

- 382dac6: fix(hosting): the image-optimization Lambda no longer follows redirects on remote image fetches

  The IPX image Lambda validated a remote image URL against the allowlist
  (`IMAGE_ALLOWED_HOSTNAMES` / `remotePatterns`) once, before fetching — and the
  fetch then followed HTTP redirects without re-validating the target. An allowlisted
  host with an open redirect (a user-content CDN, say) could therefore steer the fetch
  to any host, including `127.0.0.1` inside the Lambda sandbox.

  Remote fetches now use `fetchOptions: { redirect: 'error' }`, so a 3xx fails the
  image request instead of being followed, and the allowlist holds for every request
  the Lambda makes. **If an allowlisted image host serves its images through a redirect,
  allowlist the final location instead.** The generated Lambda also pins `ipx` to an
  exact version (`3.1.1`) rather than `^3.0.0`, so the fetch behavior this guard relies
  on can't change at deploy time.

- c6d9e49: fix(hosting): the image-optimization Lambda's SVG gate now decides by content, not file extension

  With `dangerouslyAllowSVG` / `IMAGE_ALLOW_SVG` off, the image Lambda rejected SVG
  sources only when the URL ended in `.svg`. An origin's content type isn't tied to its
  path, so an SVG served from `/logo` or `/logo.png` passed the gate and was returned as
  `image/svg+xml` from the application's own origin. SVGO, which IPX runs on SVG input,
  is an optimiser rather than a sanitiser and keeps some script-capable constructs.

  The Lambda now sniffs the image bytes from both the S3 originals bucket and allowlisted
  remote hosts, and rejects SVG content with a `415` before IPX processes it. That also
  covers rasterizing requests such as `?f=png`. As a backstop it refuses any SVG output
  unless SVG is enabled. The `.svg` extension check remains as a cheap pre-filter.
  Nothing changes when SVG is enabled, or for raster images.

- 8a1a4a9: test: cover npm's `ci/<vendor>` user-agent token in the shared `isCI()` case table

  Test-only change: `isCI()` reads `ci-info` and four extra environment variables; it does not look at `npm_config_user_agent`, so an npm user agent carrying a `ci/<vendor>` token is not CI on its own. Nothing pinned that: re-adding a user-agent check left the 30-case table fully green. The table now has a case for the token and one for a `ci/` substring inside another token, so a reintroduced check fails in both `@aws-blocks/core` and `create-blocks-app`, which share the table. The table is excluded from the published package, so no runtime or public API change.

- 2be3318: Test-only: the `bb-knowledge-base` CDK test stub no longer mimics the default-compute `handler` accessor; it grants through the shared `executionRole` like the Building Block does. No runtime or public API change.
- 38ce80c: fix: the local dev surface is no longer reachable from the network or from other websites

  - **Dev server binds loopback.** `npm run dev` now listens on `127.0.0.1` instead of every
    interface. It serves your whole API against local mock data with no authentication, so it
    must not be reachable from other machines. For a container or remote devbox, opt in with
    `BLOCKS_DEV_HOST=0.0.0.0` (or `startDevServer({ host })`); a warning is printed when the host
    isn't loopback.
  - **Local realtime WebSocket matches the deployed one.** A client-sent `publish` was broadcast
    to every subscriber with no authorization. The deployed WebSocket has no client publish, so
    the local server now rejects it as well; publish from the server with `Realtime.publish()`.
  - **Local realtime tokens are signed with a per-process random secret** instead of a constant
    published in this repository, so they can't be forged.
  - **The `/realtime` WebSocket upgrade checks `Origin`.** Only loopback origins can connect, plus
    the opted-in host: with `BLOCKS_DEV_HOST=0.0.0.0`, a same-origin page opened by IP address; with
    a concrete `BLOCKS_DEV_HOST` hostname, that hostname. This closes cross-site WebSocket hijacking from any
    page the developer visits. Non-browser clients that send no `Origin` still connect.
  - **`GET /aws-blocks/settings` opens an editor only under the local dev server.** It no longer
    spawns a process or echoes the working directory when the built-in routes run in a deployed
    Lambda, and it opens the file with `execFile` instead of a shell command.
  - **The `nextjs` template's frontend dev server binds loopback** (`next dev --hostname
127.0.0.1`), like the Blocks dev server.

- fd10117: Fix `cognitoFederated()` failing at `cdk synth` with `CannotFindAsset`.

  The published `@aws-blocks/bb-auth-oidc` package was missing the bundled Lambda that registers the identity provider on the user pool (`dist/idp-registration-lambda/index.js`), so any app using `cognitoFederated()` failed to synthesize. This affected both the Cognito-hosted domain prefix and custom domains. The release build now produces the bundle, so it ships with the package again.

- 03ce866: Keep the local dev server alive when a PGlite init trap aborts constructor-time migrations, and recover from it

  A `Database` / `DistributedDatabase` configured with `migrationsPath` runs its
  migrations eagerly in the constructor, before any query awaits them. If PGlite's
  WASM `_pg_initdb` aborts (notably under memory pressure, where the WASM linear
  heap can't grow), that eager, unawaited promise rejected with no handler — an
  unhandled rejection that terminated the whole `npm run dev` process. A shared
  `trackEager` helper (in `@aws-blocks/data-common`) now attaches a logging handler
  so the dev server survives; the same rejection still reaches callers via the
  ready-gate, so a query after a failed init surfaces a branded
  `QueryFailedException` rather than being swallowed.

  A transient trap no longer wedges the data layer: on an init trap the cached
  rejected promise is cleared, so the next query re-runs the idempotent migrations
  once memory eases (matching the engine's own recover-on-retry behaviour).

- 2da2fd4: Sanitize RawRoute uncaught exceptions so raw driver/SDK details no longer leak.

  A RawRoute whose handler throws an uncaught exception previously forwarded that error's raw name and message to the client, the same leak class the RPC path was already fixed for. The RawRoute catch (both the deployed `lambda-handler` and the local `dev-server` paths) now runs the caught throw through core's shared sanitizer: a Building Block or `ApiError` keeps its BB-authored name and message, and everything else — a driver/SDK exception or a bare `Error` — collapses to a generic `500` / `"Internal error"`, with the full error still logged server-side. A handler's own deliberate `ctx.response` writes are untouched; only the uncaught-exception path is sanitized.

  Two small behavior notes: a RawRoute uncaught exception that previously forwarded its raw name/message now returns a generic 500, and an `ApiError` built with the default name no longer emits `name: "ApiError"` on the wire (status is detected via `isApiErrorLike`, not a name compare).

- 30fc4c2: Use `dsql-lint` for local and synth-time Aurora DSQL compatibility checks, allow
  foreign keys, and refresh the PostgreSQL compatibility guidance.
- 32a4b73: Report `AuthOIDC` as the parent block of its session store, and assert the rendered chain on the wire.

  `AuthOIDC` built its session store with the scope it was given rather than itself, so the store's requests reported only `bb/KVStore` and no owning block. It cannot pass `this`: the store becomes the engine's session store, and the engine is an argument to `super()`. It now passes a parent carrying the block's own name, version and fully-qualified ID, built by the new `buildingBlockParent` helper, and the store's own ID is shortened to `sessions` so the session table name is unchanged.

  `core` adds two exports: `computeScopeFullId`, the rule `Scope.fullId` already applies, and `buildingBlockParent`, which wraps it for a block that must construct a child before `super()` has run. Both replace a copy of that rule inside `bb-auth-oidc`. The Cognito env var prefix moves into the package's shared `utils.ts` alongside the cookie-secret name, so the CDK writer and the runtime reader derive both names from one function.

  Two names change, in local and other non-Lambda `aws-runtime` runs only, where `BLOCKS_STACK_NAME` is unset and the app's root is a `Scope`. In that case the old helper walked one scope too far and produced a leading-dash ID, so the cookie-secret and Cognito env var names it looked up were not the ones the CDK side wrote, and session cookies were named `oidc_-my-app-auth`. Both now resolve. A deployed Lambda always has `BLOCKS_STACK_NAME` set and is unaffected. Under the default condition, which is what a scaffolded app's dev server resolves, the cookie prefix also changes to `oidc_my-app-auth`, from `oidc_my-app_auth` under a plain root and `oidc__my-app_auth` under a `Scope` root, because the dev entry now names cookies with the same expression as the AWS runtime instead of its own. Existing sessions in those two setups are signed out once.

  Nothing covered the chain inside the rendered header, so a change that stopped it reaching the wire would still have passed. `bb-kv-store`'s request-capture helper now takes a parent scope, and `bb-auth-oidc` gains a suite that runs under `--conditions=aws-runtime`, where the session store is the real AWS client, and asserts the captured `user-agent` header carries both blocks root-to-leaf. The CDK suite pins the literal env var names the synth side writes, which nothing checked before, and `core` gains tests for the new helper covering attribution, the official-name gate, and the derived ID.

- da6d4c7: Scope shared Blocks synth state to the owning backend root (`BlocksStack`/`BlocksBackend`) instead of the enclosing `cdk.Stack`, so two `BlocksBackend`s in one stack — and multiple stacks in one synth — stay independent.

  - **Registries** (config, compute, dashboard, tracer, VPC requirements) now key on the backend root, resolved by walking the construct tree (`getBlocksRoot`), not on `cdk.Stack.of(scope)`.
  - **Shared-infra Building Blocks** now provision and dedup their per-backend resources under the backend root: the realtime WebSocket API, the cron scheduler role, and the agent AgentCore runtime grants. Previously a second backend in the same stack could attach to the first's shared infra — most seriously, the agent's Bedrock grants could land on the wrong backend's execution role.
  - **RawRoute** registrations are tagged with their owning backend root; `Hosting` now adds CloudFront behaviors only for routes owned by the backend its distribution fronts, instead of every route in the process-global registry. The per-owner tag also scopes duplicate-route detection, so two backends may register the same method+path.
  - **`Hosting` now registers its origin config against the backend it fronts.** `BLOCKS_PUBLIC_ORIGIN` and `CORS_HOSTING_ORIGINS` are written to the backend named by `props.api`, matching the route-behavior owner — not to `this`, which (when two backends share a stack) resolved via the ambient pointer to the last-created backend and left the fronted backend without its origin config.
  - The config bucket is parented under the resolved backend root rather than read from an ambient process-global, removing a construction-order hazard.
  - **Stack-scoped exceptions — these deliberately keep a stable logical ID.** The app-setting secret bulk-init (`BlocksSecretsBulk`) and the distributed-table GSI manager provider (`BlocksGsiProvider`) stay direct stack children. Both are referenced by existing resources through immutable fields (a SecureString's physical name; a custom resource's `ServiceToken`), so a logical-ID change would force a replacement that CloudFormation either rejects (`ServiceToken` is immutable → failed upgrade) or that silently deletes the SecureString. Keeping them stack-scoped preserves the logical ID; their deploy-time IAM is still scoped (lazily) to only the parameters/tables that register. (Joins the API Gateway account resource as a documented stack-scoped exception.)

  **Compatibility.** Single-`BlocksStack` apps (the common case) are byte-identical — no resource replacement. Apps that embed a `BlocksBackend` inside a customer `cdk.Stack` and use **realtime** or **cron** will see those resources re-parent from the stack to the backend construct, which CloudFormation treats as a replacement on upgrade; neither carries persistent data. For realtime specifically, the WebSocket API URL changes and its stack output key changes from `RealtimeWsUrl` to `BlocksRealtimeWsUrl<hash>` — scripts that read that output by name must update. Secret AppSettings and GSI-backed tables are **not** affected (their shared resources stay stack-scoped).

- ec7eebe: docs: recommend `Secret` for production secrets; position `AppSetting(secret: true)` as a free fallback

  Aligns the Secret ↔ AppSetting guidance with AWS's recommendation that credentials belong in a dedicated secret store. Customer- and agent-facing docs (READMEs, exported-symbol JSDoc) now steer users to `Secret` for any credential protecting a production app and describe `AppSetting` with `secret: true` as a free, encrypted fallback for a low-value secret only — phrased in Blocks terms (`Secret` / `AppSetting`) with a link out to the AWS guidance rather than naming the underlying services inline. The per-BB `DESIGN.md` docs carry the explicit service-level rationale (AWS Secrets Manager vs SSM Parameter Store SecureString).

  Also corrects an inaccurate security tip in the umbrella README that said to "never use `.env` files" — the framework documents legitimate `.env` usage for local dev (e.g. hosting, `bb-data`). The tip now says what it means: don't hardcode secret values in source, and don't ship real secrets to a deployed app through plaintext environment variables — set them through `Secret`/`AppSetting`.

- f1eb149: fix(telemetry): keep every event written to `--telemetry-file` instead of only the first

  The sink created the file with `O_CREAT | O_EXCL` and swallowed the resulting `EEXIST`, so a run that emitted more than one event recorded only the first. In `@aws-blocks/core` a `dev` server that retries a port bind emits `dev/FAIL` then `dev/SUCCESS`, and the success was lost. Events after the first are now appended to the same JSON array. A path that already existed when the run started is still left untouched. The container is unchanged — a JSON array, 2-space indented — so a consumer reading the first element is unaffected, but a file can now hold more than one event: anything asserting exactly one needs updating.

- 7c19c4f: feat: `npm run deploy -- --wait-live` holds `BLOCKS_DEPLOYED` until the new build is actually served

  `cdk deploy` returning is not the same as the new frontend build being served.
  Two edge windows stay open after CloudFormation reports complete, and emitting
  `BLOCKS_DEPLOYED` while either is open lets a caller's immediate self-test hit a
  stale bundle and silently miss a regression.

  - **New opt-in `--wait-live` flag.** When set, `npm run deploy` only prints
    `BLOCKS_DEPLOYED` once the new build is confirmed live, so a request issued
    immediately after the signal returns the new asset.
  - **Per-build config match (the KVS cutover).** Each deploy stamps its build id
    into the runtime config (`/.blocks-sandbox/config.json`) and surfaces it as a
    `HostingBuildId` stack output; the poll declares the config live only when the
    body CloudFront serves carries that exact id, distinguishing the new build from
    a byte-identical config still served by an edge POP routing to the previous
    build during cutover — the common re-deploy case.
  - **Invalidation wait (the compute/SSR window).** For a compute deploy the `/*`
    CloudFront invalidation that flushes the previous build's edge-cached SSR HTML
    is fire-and-forget, so CloudFormation returns before it propagates. The deploy
    now surfaces the invalidation id as a `HostingInvalidationId` stack output and,
    under `--wait-live`, polls `GetInvalidation` until `Completed` before signalling
    — closing the window where the edge still serves old SSR HTML (referencing old
    hashed assets → 403). Pure-static deploys issue no invalidation and skip this.
  - **Bounded probing.** Each config probe carries a per-request timeout
    (`AbortSignal`), so one stalled response cannot hold the deploy past its budget.
    `--wait-live-timeout=<seconds>` tunes the overall budget (default 180); if
    liveness can't be confirmed in time, the deploy — which itself succeeded — prints
    a clear warning and exits non-zero rather than emitting a false "live" signal.
  - **No-op for backend-only apps** (no frontend to verify) and off by default, so the
    existing deploy flow is unchanged unless you opt in.

- Updated dependencies [ec7eebe]
- Updated dependencies [f8fbc6e]
- Updated dependencies [59c9dde]
- Updated dependencies [c20cbfd]
- Updated dependencies [8f9510a]
- Updated dependencies [fbef372]
- Updated dependencies [8f725b6]
- Updated dependencies [e682ba7]
- Updated dependencies [3a7eb9e]
- Updated dependencies [e7e96e6]
- Updated dependencies [9ebda66]
- Updated dependencies [78f4396]
- Updated dependencies [440ecce]
- Updated dependencies [92fa27b]
- Updated dependencies [1a5c18e]
- Updated dependencies [4ae500e]
- Updated dependencies [6d764f7]
- Updated dependencies [4fe7be4]
- Updated dependencies [023f02c]
- Updated dependencies [5d6656a]
- Updated dependencies [60616b1]
- Updated dependencies [a50fb46]
- Updated dependencies [8b5ef4a]
- Updated dependencies [382dac6]
- Updated dependencies [c6d9e49]
- Updated dependencies [8a1a4a9]
- Updated dependencies [2be3318]
- Updated dependencies [38ce80c]
- Updated dependencies [94a914a]
- Updated dependencies [cb0ec01]
- Updated dependencies [005c095]
- Updated dependencies [fd10117]
- Updated dependencies [b8649dc]
- Updated dependencies [03ce866]
- Updated dependencies [2da2fd4]
- Updated dependencies [30fc4c2]
- Updated dependencies [66f4be2]
- Updated dependencies [32a4b73]
- Updated dependencies [da6d4c7]
- Updated dependencies [e3e5e22]
- Updated dependencies [ec7eebe]
- Updated dependencies [e9241b5]
- Updated dependencies [f1eb149]
- Updated dependencies [122c49c]
- Updated dependencies [8ca3692]
- Updated dependencies [7c19c4f]
  - @aws-blocks/bb-secret@0.2.0
  - @aws-blocks/core@0.7.0
  - @aws-blocks/bb-agent@0.6.0
  - @aws-blocks/bb-auth-basic@0.1.11
  - @aws-blocks/bb-data@0.4.0
  - @aws-blocks/bb-lambda-compute@0.6.0
  - @aws-blocks/bb-async-job@0.2.3
  - @aws-blocks/bb-auth-cognito@0.1.12
  - @aws-blocks/bb-app-setting@0.3.2
  - @aws-blocks/bb-dashboard@0.2.2
  - @aws-blocks/bb-email-client@0.1.9
  - @aws-blocks/bb-file-bucket@0.3.1
  - @aws-blocks/bb-kv-store@0.3.1
  - @aws-blocks/bb-metrics@0.1.9
  - @aws-blocks/bb-distributed-table@0.2.2
  - @aws-blocks/bb-knowledge-base@0.2.6
  - @aws-blocks/bb-cron-job@0.3.0
  - @aws-blocks/bb-realtime@0.4.0
  - @aws-blocks/hosting@0.4.1
  - @aws-blocks/bb-auth-oidc@0.2.2
  - @aws-blocks/bb-distributed-data@0.2.2
  - @aws-blocks/auth-common@0.2.0
  - @aws-blocks/bb-logger@0.2.2
  - @aws-blocks/bb-tracer@0.2.2

## 0.7.0

### Minor Changes

- 20be3f0: fix(bb-kv-store): wire point-in-time recovery from the stack preset and add customer-managed encryption

  `KVStore` now honors `defaults.pointInTimeRecovery` (PITR on under `production`, off under `sandbox`) and accepts per-block `pointInTimeRecovery` and `encryption` options — mirroring `DistributedTable`. `encryption: 'customer-managed'` provisions a dedicated CMK, and `KVStore.fromKmsKey(arn)` reuses an existing key across stores. Previously `KVStore` ignored the preset, so production-preset consumers believed PITR was enabled when it was not.

  The default encryption now emits the AWS-managed `aws/dynamodb` KMS key (`SSESpecification: { SSEEnabled: true }`), where before no `SSESpecification` was emitted at all (the AWS-owned key). On an already-deployed table this is an in-place SSE change applied on upgrade, and the `aws/dynamodb` key bills per-request KMS charges that the AWS-owned key does not.

  **Behavior change on next production deploy of an existing app:** an existing `production`-preset `KVStore` table gains Point-in-Time Recovery in place on the next deploy (an in-place update, no table replacement); continuous backups are billed per GB-month of table size. Separately, passing `removalPolicy`, `deletionProtection`, or `ttl` alongside `fromExisting()` now warns at synth (previously only `pointInTimeRecovery` and `encryption` did), so a pipeline running `cdk synth --strict` will fail until those options are removed from the wrapped-table call.

### Patch Changes

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

- 773cef2: fix(astro): allow an empty `dist/client` for pure-SSR builds

  A server/hybrid Astro app with no static assets — no `public/` files and no
  prerendered pages — produces an empty `dist/client`. The adapter treated that as
  a missing build output and threw `AstroBuildOutputMissingError`, blocking synth
  and deploy. `dist/server/entry.mjs` is the real required artifact; an empty (or
  absent) `dist/client` is valid, since CloudFront routes every request to the SSR
  Lambda. The adapter now requires only the server entry and ensures `dist/client`
  exists (creating it when absent, with a build-log breadcrumb) instead of failing.

- ea5f91c: fix(bb-auth-basic): echo the username on the confirm-signup / confirm-reset forms

  AuthBasic's `confirmingSignUp` and `confirmingPasswordReset` states rendered
  `username` as an empty, visible text field — so after signing up (or requesting a
  reset) the user had to **retype** their username on the confirmation step, and a
  mismatch silently broke the flow. The username is now echoed as a **hidden**
  field prefilled with the value just entered (mirroring `bb-auth-cognito`), so the
  confirm form carries it automatically. The `code` / `password` / `newPassword`
  fields are unchanged.

- 2e72825: fix(bb-auth-cognito): `requireRole` reads group membership live so admin group changes take effect without a re-login

  `requireRole` checked the signed-in user's `cognito:groups` **token claim**, which
  is a snapshot from sign-in. After an admin ran `auth.admin.addUserToGroup(user,
'admins')`, that user's live session kept getting **403** until their token
  refreshed or they re-logged in — the "admin surface is unreachable / `requireRole`
  returns 403 for everyone" symptom. The mirror bug: `removeUserFromGroup` did **not**
  revoke a live session, so a removed member kept access until their stale token
  expired.

  `requireRole` now reads membership live at call time — AWS: `AdminListGroupsForUser`
  (paginated); mock: in-process `state.groups` — mirroring how `fetchUserAttributes`
  reads live rather than trusting the token. The returned `CognitoUser.groups`
  reflects the live read. Grants and revocations now apply on the user's next
  request, with no re-login.

  - Costs one extra Cognito call per guarded request. The cheaper identity reads
    (`requireAuth` / `getCurrentUser` / `signIn`) still surface the cached
    `cognito:groups` claim — use `requireRole` when you need live membership.
  - `cognito-idp:AdminListGroupsForUser` is now granted to the execution role
    unconditionally (it backs a client-facing guard), independent of the opt-in
    `admin` surface. Every other `Admin*` action still requires opt-in.
  - Added `admin.test.ts` cases covering the sign-in-then-mutate ordering in both
    directions (grant is honored, revocation locks out); updated the CDK IAM
    least-privilege test for the new baseline grant.

- 4456fd7: Document the full `AuthState` shape returned by `getAuthState()`/`setAuthState()` (`errorName`, `retriable`, and the `confirmingSignIn` state) in the auth READMEs, and note that `bb-auth-cognito` / `bb-auth-oidc` consumers import the type from `@aws-blocks/auth-common`.
- 39628cb: fix(core): anchor and escape CORS allowlist origins

  CORS allowlist entries are compiled to regular expressions. Two matching gaps let a
  plain-looking origin match more broadly than intended:

  - An entry beginning with `^` was used verbatim with no end anchor, so
    `^https://app\.example\.com` also matched `https://app.example.com.extra`.
    `parseCorsPatterns` now compiles every entry as `^(?:<entry>)$`, so the anchors
    bind the whole expression — including every branch of a top-level `|` alternation,
    not just the last.
  - The framework-injected hosting origin (the CloudFront/custom domain) was compiled
    into the regex allowlist as a raw string, so its `.` characters were treated as
    regex metacharacters rather than literals. Hosting origins now travel in a separate
    literal channel (`CORS_HOSTING_ORIGINS`): the origin is registered raw at synth (so
    its CloudFormation token resolves to the real domain) and escaped literally at
    runtime, so a domain like `d123.cloudfront.net` matches its dots literally.

  User-supplied `CORS_ALLOWED_ORIGINS` entries remain regex patterns (the `.*` escape
  hatch and subdomain patterns are unchanged); literal dots in an origin should be
  escaped (`https://app\.example\.com`), as the README documents.

  **Migration.** Automatic end-anchoring of `^`-prefixed entries is a tightening: an
  entry like `^https://app\.example\.com` previously also matched
  `https://app.example.com:8443`, and now does not. If you relied on that prefix
  behavior, append an explicit suffix such as `(:\d+)?` or `.*` to the entry.

  `CORS_HOSTING_ORIGINS` must now be a **raw** origin (it is escaped once at runtime); a
  pre-escaped value would be escaped a second time and stop matching.

- d4b32f2: Add `README.md` and `DESIGN.md` to `@aws-blocks/create-block` and ship them in the published package (`files`), matching the first-party package convention.

  Tidy two `extract-ts-types` test nits (test/comment only, no runtime change): replace a redundant re-assert with a direct check of the documented lingering-bare-key behavior, and link the array/tuple & nested-destructuring boundary to its tracking issue (#552).

- a649895: Emit a machine-readable completion signal on a successful `npm run deploy` **and** `npm run sandbox`.

  `deploy()` now prints one stable last line — `BLOCKS_DEPLOYED url=<frontend> api=<backend>` (a backend-only app omits `url=`) — so a caller (a coding agent, a CI step, a script) can detect "deploy finished + where it lives" by grepping one line instead of parsing streamed CloudFormation output or polling the stack for the URL. `sandbox()` prints the same line on its success path (backend-only — `BLOCKS_DEPLOYED api=<backend>`, since the sandbox serves the frontend locally), so a programmatic caller greps the identical token after either command. The existing human-readable `✅ Deployment complete!` / `📡 API URL` / `🌐 Frontend URL` lines are unchanged; the signal is additive. The formatting is extracted into a pure `formatDeploySignal()` helper with unit coverage, shared by both entry points. The scaffolded `AGENTS.md` documents the line so agents grep it rather than poll.

  For `npm run deploy` specifically (which streams a real CloudFormation deploy), the heartbeat now also names the resource currently converging — e.g. `waiting on HostingDistribution (AWS::CloudFront::Distribution)` — and surfaces a rolling-back resource as a warning rather than silently clearing it, and the frontend URL is surfaced early (on the in-progress path) so a deploy killed at a caller timeout has still reported where the app lives.

- 251aed2: fix(bb-file-bucket): align unknown-`versionId` behavior between the mock and AWS

  On a versioned bucket, an unknown `versionId` diverged between runtimes. S3 does
  **not** signal an unknown `versionId` as `NoSuchVersion` (verified against real
  S3): an id it cannot resolve comes back as `InvalidArgument` ("Invalid version id
  specified") on `GetObject`/`DeleteObject` and `InvalidRequest` on `CopyObject`;
  `NoSuchVersion` is reserved for a well-formed id that no longer exists. The AWS
  runtime now normalizes all of these so the observable contract matches the mock:

  - `get()` — returns `null` for an unknown `versionId` (matching the mock and
    `get()`'s documented "null if it does not exist" contract), instead of throwing.
  - `delete()` — is a silent no-op for an unknown `versionId` (matching the mock),
    instead of throwing.
  - `restoreVersion()` — throws a clean, matchable `FileBucketErrors.VersionNotFound`
    (`NoSuchVersion`) via core's `blocksError` producer, so both `.name`
    (`isBlocksError(e, FileBucketErrors.VersionNotFound)`) and the `.message` agree
    across runtimes — instead of the raw S3 error, whose enumerable `$metadata`
    (request IDs, ARNs) would leak to the client on serialization.

  The raw S3 codes are folded only when a `versionId` was actually supplied, so an
  unrelated `InvalidArgument`/`InvalidRequest` still surfaces. Also adds the public
  `FileBucketErrors.VersionNotFound` constant, and encodes the caller-supplied
  `versionId` in `CopySource` (a value with `&`, `#`, `?`, or a space would
  otherwise corrupt the `x-amz-copy-source` header).

- 6b7fe4c: fix(hosting): retain the ISR tag-table seed custom resource on stack delete

  The `IsrTagTableSeed` custom resource is backed by a Lambda through a CDK
  `Provider`. On stack delete CloudFormation tore the provider's framework Lambda
  down before it sent the custom resource its `Delete`, so the delete invoke hit
  an already-gone function, received no response, and hung to the 30-minute
  custom-resource timeout -- failing the whole stack delete with `DELETE_FAILED`
  and re-failing identically on every retry. The seed custom resource now carries
  `RemovalPolicy.RETAIN`, so CloudFormation drops it on delete without a delete
  invoke and the stack tears down cleanly. This is behavior-preserving: the
  OpenNext `dynamodb-provider` `remove()` path is a no-op, and the seeded rows
  live only in the ISR tag table, which is destroyed with the stack -- so
  retaining the custom resource orphans nothing.

- dae7a86: fix(hosting): warn when a compute resource pins an end-of-life Node.js runtime

  `resolveRuntime` still accepts an explicitly pinned `nodejs18.x` or `nodejs20.x`
  (so an existing/deployed function isn't hard-broken at synth), but both are past
  their AWS Lambda deprecation dates (Node 18: Apr 2025; Node 20: Apr 2026). It now
  emits a CDK synth-time **deprecation warning** for those runtimes, pointing at
  `nodejs22.x` / `nodejs24.x` (or omitting the runtime to use the default). A
  supported runtime, or omitting it, warns nothing; the accepted set and the
  hard error for unrecognized runtimes are unchanged.

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
  throw new Error("Todo not found");

  // after — status, message, and name all reach the client
  throw new ApiError("Todo not found", 404, { name: "TodoNotFoundException" });
  ```

  Building Block errors (`isBlocksError` / `blocksError`) are unaffected — their name and message continue to cross the wire.

- 7b7a59f: fix(bb-cron-job,hosting): scope service-principal grants to the deploying account

  - **bb-cron-job**: the EventBridge Scheduler role's trust policy is now limited to
    schedules in the stack's account and region (`aws:SourceAccount` and an `aws:SourceArn`
    schedule-group pattern).
  - **hosting**: removed a redundant CloudFront `kms:Decrypt` statement from the SSE-KMS key
    policy. The Origin Access Control wiring already grants CloudFront decrypt on the bucket key,
    conditioned on `AWS:SourceArn` matching the account's CloudFront distributions.

- 465a002: fix(telemetry): use ci-info for CI detection so Taskcluster (`TASK_ID` + `RUN_ID`), Netlify, Vercel, and 40+ other CI providers are identified; also keep the previously checked `CODEBUILD_BUILD_ID`, `JENKINS_URL`, `BITBUCKET_BUILD_NUMBER` and `TASKCLUSTER_ROOT_URL` variables, and honor `CI=false`
- e57da06: Report bbName/bbVersion in telemetry.
- Updated dependencies [8da1d1f]
- Updated dependencies [773cef2]
- Updated dependencies [ea5f91c]
- Updated dependencies [bd9a1b8]
- Updated dependencies [2e72825]
- Updated dependencies [4456fd7]
- Updated dependencies [fac0e75]
- Updated dependencies [3fac52c]
- Updated dependencies [0e18d5b]
- Updated dependencies [20be3f0]
- Updated dependencies [5501cb6]
- Updated dependencies [7c24547]
- Updated dependencies [b58f248]
- Updated dependencies [39628cb]
- Updated dependencies [d4b32f2]
- Updated dependencies [a649895]
- Updated dependencies [27646ac]
- Updated dependencies [1f8a412]
- Updated dependencies [fa0406b]
- Updated dependencies [251aed2]
- Updated dependencies [6b7fe4c]
- Updated dependencies [5515483]
- Updated dependencies [dae7a86]
- Updated dependencies [5454763]
- Updated dependencies [757d4a9]
- Updated dependencies [b0be240]
- Updated dependencies [cbedb3c]
- Updated dependencies [f1d2cd5]
- Updated dependencies [de3c17c]
- Updated dependencies [a23b8d8]
- Updated dependencies [7b7a59f]
- Updated dependencies [9e02b82]
- Updated dependencies [465a002]
- Updated dependencies [e57da06]
- Updated dependencies [de3c17c]
- Updated dependencies [9608dce]
  - @aws-blocks/bb-agent@0.5.0
  - @aws-blocks/hosting@0.4.0
  - @aws-blocks/bb-auth-basic@0.1.10
  - @aws-blocks/bb-auth-cognito@0.1.11
  - @aws-blocks/auth-common@0.1.9
  - @aws-blocks/bb-auth-oidc@0.2.1
  - @aws-blocks/bb-app-setting@0.3.1
  - @aws-blocks/bb-kv-store@0.3.0
  - @aws-blocks/core@0.6.0
  - @aws-blocks/bb-file-bucket@0.3.0
  - @aws-blocks/bb-async-job@0.2.2
  - @aws-blocks/bb-data@0.3.1
  - @aws-blocks/bb-distributed-table@0.2.1
  - @aws-blocks/bb-email-client@0.1.8
  - @aws-blocks/bb-knowledge-base@0.2.5
  - @aws-blocks/bb-realtime@0.3.0
  - @aws-blocks/bb-distributed-data@0.2.1
  - @aws-blocks/bb-cron-job@0.2.2
  - @aws-blocks/bb-dashboard@0.2.1
  - @aws-blocks/bb-metrics@0.1.8
  - @aws-blocks/bb-lambda-compute@0.5.1
  - @aws-blocks/bb-logger@0.2.1
  - @aws-blocks/bb-tracer@0.2.1

## 0.6.0

### Minor Changes

- d7312f9: Make observability **compute-driven** so it composes correctly once an app has more than one compute. Logging, tracing, and the dashboard now key off compute state rather than off the Logger / Tracer / Dashboard blocks poking a single implicit compute.

  **Logging is always on; retention is a compute-level setting.** Every compute captures stdout to its own log group unconditionally — there is no "enable logging" step. The retention of that group is set per compute via a new `logRetention` prop on `LambdaCompute` (`@aws-blocks/bb-lambda-compute`), falling back to `defaults.logRetention`. Log **level** is purely per-instance runtime behavior: set it via a `Logger`'s `level` option (default `'info'`). There is no app-wide log-level default and no `LOG_LEVEL` env var.

  **Tracing is presence-gated.** Creating any `Tracer` in the app now enables X-Ray on **every** compute (X-Ray provisions real, costed infrastructure, so it stays off until the app opts in by constructing a Tracer). This replaces the previous model where a Tracer turned on tracing for one implicit compute. `@aws-blocks/core/cdk` adds `registerTracer()` (records Tracer presence) and `finalizeTracing()` (enables tracing on all computes at finalize); `create()` runs it before finalizing dashboards. `Compute.enableTracing()` is now idempotent.

  **The dashboard is organized by compute, with display toggles.** `DashboardOptions` gains `logs?: boolean` (default `true`) and `traces?: boolean` (default `true`) — app-wide display toggles applied uniformly to every compute section. `logs:false` hides the (always-captured) logs section; `traces:false` hides traces even when tracing is enabled.

  The dashboard covers **every** compute in the app (resolved at finalize, so construction order never matters). Each compute renders a health section always, a logs section (unless `logs:false`), and a traces section only when tracing is enabled on it (unless `traces:false`). Metrics remain app-scoped and are passed explicitly. No `computes` selector is exposed yet — it would leak the internal `Compute` type before customers can construct a compute; it arrives with the multi-compute surface.

  **⚠️ Behavior / API changes:**

  - **`Logger` no longer reconfigures log retention.** The CDK `Logger` is now a no-op placeholder (logging is always on and retention moved to the compute). The `retention` option was removed from `LoggingOptions`; set `logRetention` on the compute instead.
  - **A `Tracer` now enables X-Ray on all computes, not one.** Any Tracer in the app turns on tracing fleet-wide.
  - **`Logger` no longer reads the `LOG_LEVEL` environment variable.** Log level is set solely via the per-`Logger` `level` option (default `'info'`); the previously supported `LOG_LEVEL` env-var override has been removed, and Blocks stamps no app-wide log-level config. `BlocksDefaults` has no `logLevel` field.
  - **Removed the deprecated `LoggerBBRef` / `TracerBBRef` dashboard types.** They were no longer consumed — the dashboard reads compute state directly. Loggers and Tracers were never passed to the Dashboard in this model.

### Patch Changes

- 7b86b8e: fix(auth-oidc): make `cognitoFederated()` deployable by registering the IdP via a deploy-time custom resource

  `@aws-blocks/bb-app-setting` now also exports `SECRETS_BULK_CONSTRUCT_ID` — the
  construct id of the shared per-stack secret-init custom resource — so sibling
  blocks can order a resource after the SecureString values are written without
  hard-coding the string. `bb-auth-oidc`'s IdP-registration custom resource uses
  it to take an explicit dependency on that resource (compile-time coupling, so a
  rename can't silently break the ordering guarantee).

  `cognitoFederated()` previously produced a CloudFormation template that always
  failed to deploy (#447). It registered the federated identity provider with a
  native `AWS::Cognito::UserPoolIdentityProvider` resource, writing the IdP
  `client_id` / `client_secret` into `ProviderDetails` as
  `{{resolve:ssm-secure:...}}` dynamic references. CloudFormation only permits
  `ssm-secure` references on a small allowlist of properties that excludes
  `ProviderDetails`, so `cdk synth` succeeded but every deploy failed at
  change-set creation — before any resource was created — leaving the stack in
  `REVIEW_IN_PROGRESS` with `SSM Secure reference is not supported in [...ProviderDetails...]`.

  The IdP is now registered by a **deploy-time custom resource**: a small
  Lambda-backed provider reads and decrypts the IdP credential SecureString
  parameters via the SDK at deploy time and calls Cognito's
  `CreateIdentityProvider` / `UpdateIdentityProvider` / `DeleteIdentityProvider`.
  Only the parameter _names_ cross into the CloudFormation template — the secret
  values never appear in it. The handler's role is least-privilege: scoped to
  `cognito-idp:{Create,Update,Delete}IdentityProvider` on the pool ARN,
  `ssm:GetParameter` on the specific parameter ARNs, and `kms:Decrypt` conditioned
  on `kms:ViaService = ssm.<region>`.

  A `secret: true` `AppSetting` is an SSM SecureString at `/<fullId>` (not an AWS
  Secrets Manager entry — the `blocks secret` CLI does not apply). Set its value by
  writing the SecureString directly (`aws ssm put-parameter … --type SecureString
--overwrite`) or via the `AppSetting` runtime `put()`. Because the credentials
  are read at deploy time and are not stack properties, the custom resource
  re-reads SSM on every `cdk deploy`, so a credential set or rotation takes effect
  on the next deploy. A synth-time check rejects two providers configured with the
  same `identityProvider`.

  Verified end-to-end against a real account: `cdk deploy` succeeds (no change-set
  rejection) and the identity provider is created on the User Pool, including the
  path where a real `AppSetting(secret: true)` provisions the SecureString during
  the same deploy.

  This is a `minor` bump for `@aws-blocks/bb-auth-oidc` (pre-1.0 minor = a behavior
  change): the synthesized template for a `cognitoFederated()` provider no longer
  contains a native `UserPoolIdentityProvider` resource — the IdP is now a custom
  resource — so anyone asserting on that resource in a snapshot will see a diff.
  The public API is unchanged.

- 4342149: fix(bb-dashboard): depend on `@aws-blocks/bb-lambda-compute@^0.4.0`

  `bb-dashboard` declared its `@aws-blocks/bb-lambda-compute` devDependency as
  `^0.3.0`, which excludes the current workspace version (`0.4.0`). npm therefore
  installed the published `0.3.0` tarball into `bb-dashboard` instead of linking
  the local workspace, and two failures followed: the root `package-lock.json`
  fell out of sync (breaking `npm ci` repo-wide), and `bb-dashboard`'s CDK test
  crashed with `ERR_PACKAGE_PATH_NOT_EXPORTED` importing
  `@aws-blocks/bb-lambda-compute/cdk` — a subpath the old `0.3.0` did not export.

  Aligning the range to `^0.4.0` links the local workspace (which exports
  `./cdk`), fixing both. Dev-dependency-only; no runtime or API change.

- e2c3c62: fix(bb-distributed-data): re-run the DSQL role grant when the app's IAM role is replaced

  `DistributedDatabase` maps the app's IAM role ARN to a DSQL database role with
  `AWS IAM GRANT`. The migration/provisioning CustomResource is documented as running
  on every deploy so the mapping "stays in sync if the app Lambda's IAM role is
  recreated", but its properties were `{ migrationsHash, dbRole }` only — the role ARN
  reached the Lambda as an environment variable and nothing else.

  CloudFormation re-invokes a CustomResource only when its **properties** change. When
  an IAM role replacement changed the ARN while migrations stayed the same, both
  properties were unchanged, so CloudFormation skipped the resource entirely. The
  Lambda's `APP_ROLE_ARN` env var was updated but the function was never called, leaving
  the DSQL grant pointing at the old, deleted ARN. Every query then failed with SQLSTATE
  `28000` (`invalid_authorization_specification`, "unable to accept connection, access
  denied") while the deploy itself reported success and the IAM policy still showed a
  correct `dsql:DbConnect` — the breakage lived in DSQL's internal role mapping, which is
  invisible from the CloudFormation layer.

  `appRoleArn` is now a CustomResource property, so a role replacement re-invokes the
  resource and `provisionAppRole()` re-issues the grant as part of the deploy. The value
  is a CDK token, so it differs only when the role is genuinely replaced — this does not
  force the resource to run on every deploy.

  This was latent from the initial version and stayed dormant while each Lambda kept its
  own stable execution role. It surfaced once the shared execution role landed (#320,
  #341): upgrading `@aws-blocks/core` across that range replaces the per-Lambda
  `HandlerServiceRole` with the shared `BlocksRole`, which is exactly the role-ARN change
  that the CustomResource failed to notice.

  `@aws-blocks/blocks` gets a `patch` bump because it re-exports `bb-distributed-data`
  (satisfies the umbrella publish guard); no umbrella source changed.

  Fixes #556.

- f552ebe: fix(core): follow a factory-returned, destructured `ApiNamespace` when extracting spec schemas (#444)

  `blocks-generate-spec` lost the TypeScript parameter/result schemas for an
  `ApiNamespace` that was constructed inside a factory, returned as a property,
  destructured, and then exported (e.g. `const { api } = new Factory().build()`).
  The extractor's indirect pass only handled a simple identifier binding
  (`const api = …`), so a destructured binding fell through and the method's
  schema was attributed to a bare, unqualified key — which, under a method-name
  collision with another namespace, cross-assigned or degraded to
  `{ "type": "unknown" }` (the same class of bug as #445, via the factory path).

  The indirect pass now also handles **object binding patterns**: for each
  destructured binding it resolves the property's type off the initializer and
  extracts the methods keyed by the local (exported) namespace name — so a
  factory-returned namespace keys qualified (`api.method`) exactly like a
  directly-constructed one, and same-named methods across namespaces no longer
  collide. Renamed bindings (`const { foo: bar } = …`) read the correct property.

- 9aa0814: `blocks-generate-spec`: stop cross-assigning schemas between namespaces that share a method name.

  The TypeScript type extractor keyed method schemas by the bare method name, so when two `ApiNamespace`s each exposed an operation with the same name (e.g. `widgets.create` and `subscriptions.create`), one namespace's parameter/result schemas silently overwrote the other's in the generated OpenRPC document — producing incorrect client types. Method schemas are now keyed by the namespace-qualified name (`namespace.method`), matching how the spec routes operations; the consumer falls back to the bare name for methods the extractor couldn't attribute to a namespace, so no previously-working case regresses.

- 81609a8: `KVStore.put`: allow `ifNotExists` and `ifValueEquals` to compose.

  Previously the two conditional-write options were mutually exclusive — the AWS runtime silently ignored `ifValueEquals` when `ifNotExists` was also set, and the mock rejected the write outright, so passing both was unusable (and the two layers diverged). They now compose with **OR**: the write succeeds when the key is absent **or** its current value matches, and fails only when the key exists **and** the value differs. This is the optimistic "create it, or update it only if unchanged" pattern (`attribute_not_exists(pk) OR value = :expected`). Each option used alone is unchanged.

- 5eee114: Add npm keywords for discoverability via `npm search keywords:aws-blocks`

  Every published package now carries an npm `keywords` array: the shared `aws-blocks`
  discovery tag plus 2–5 functional keywords describing the package's domain and the
  AWS services it uses (e.g. `realtime`, `websocket`, `pubsub` for `bb-realtime`;
  `ci-cd`, `pipelines`, `deployment` for `pipeline`). Metadata only — no runtime,
  API, or behavior change.

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

- acd1628: Share the RawRoute registry across duplicate copies of `@aws-blocks/core` so routes registered through one copy are dispatched (and synthesized into CloudFront behaviors) by another, instead of silently returning 404. Unmatched routes now log a diagnostic, and a duplicate core copy warns once.
- 6496713: Simplify VPC implementation: replace `registerVpcEndpoint` (instanceof-based) with two explicit methods (`registerVpcGatewayEndpoint` / `registerVpcInterfaceEndpoint`), simplify `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`, and strip persistent test VPC to bare minimum.
- bd67438: feat(auth-oidc): let `stubIdp()` declare test users inline

  `stubIdp()` gains an optional `users?: StubUser[]`. Previously the stub IdP's
  identity directory could only be seeded from a `users.json` file in the mock
  data dir (with a single default user otherwise), so declaring test users meant
  committing/gitignoring a data file. Inline `users` are now the authoritative
  directory for the login screen and the `users` handed to `onAuthorize`, taking
  precedence over `users.json` and the built-in default. Omitting it is unchanged
  (file → default fallback), so existing apps and the AWS runtime are unaffected.

- a47d71c: fix(data): map duplicate-key unique-constraint violations to JSON-RPC 409 (Conflict) instead of 500

  A duplicate-key / unique-constraint violation (SQLSTATE `23505`,
  `UniqueConstraintViolation`) now surfaces to clients as JSON-RPC error
  **code 409 (Conflict)** instead of a generic **500**. Previously the engine
  translators set `error.name` on the raw driver error and re-threw a plain named
  `Error`; the JSON-RPC serializer maps any non-`ApiError` to 500, so a routine,
  expected duplicate-key conflict was indistinguishable from an internal server
  error. This mirrors the `40001`/OCC → 409 mapping already established for these
  Blocks.

  Each affected conflict is now an `ApiError` with `status: 409`, so on the client
  `error.status === 409`. The structured `error.name` is preserved end-to-end, so
  `isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)` (and the
  `DistributedDatabaseErrors` equivalent) keeps matching by name on both server and
  client; the typed error constants are unchanged.

  - `@aws-blocks/bb-data` — a duplicate-key violation (SQLSTATE `23505`,
    `DatabaseErrors.UniqueConstraintViolation`) across the PGlite, pg-client, and
    Data API engines (both the SQLState-parsed and message-matched Data API paths),
    routed through a shared `uniqueConstraintConflict()` helper.
  - `@aws-blocks/bb-distributed-data` — a DSQL duplicate-key violation (SQLSTATE
    `23505`, `DistributedDatabaseErrors.UniqueConstraintViolation`) in
    `translateDsqlError`, in both the mock and real engines.

  The conflict is **not** flagged `retriable`: a duplicate key is deterministic, so
  a blind retry of the same insert fails identically (unlike the `40001`
  serialization failures, which stay retriable). The client-visible message is a
  fixed, stable string; the raw driver text (which can name columns / constraints)
  is retained only as `cause` for server-side diagnostics. Genuine infrastructure
  errors (`ConnectionFailed`, `QueryFailed`) are unchanged and correctly stay 500,
  and the `SerializationFailure`/OCC paths are untouched.

  This is a `minor` bump. Both data packages are pre-1.0, where `minor` is this
  repo's signal for a change that can alter existing behavior: callers that
  branched on `error.status === 500` for these conflicts (or on the JSON-RPC error
  code) will now see `409`. Code that matches conflicts by name via
  `isBlocksError` — the documented pattern — is unaffected.

  `@aws-blocks/blocks` gets a `patch` bump because it re-exports `bb-data` and
  `bb-distributed-data` (satisfies the umbrella publish guard); no umbrella source
  changed.

  Fixes #508.

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

- 6496713: fix(bb-data): place shared-VPC Aurora in the subnets the VPC actually has

  When `Database` runs inside a bring-your-own VPC, its Aurora cluster was pinned
  to `PRIVATE_ISOLATED` subnets. The VPC in every docs example
  (`new ec2.Vpc(app, 'AppVpc', { maxAzs: 2, natGateways: 1 })`) has no isolated
  tier, so following the documented setup and adding a `Database` failed synth
  with "no isolated subnet groups in this VPC."

  Aurora is reached over the RDS Data API (HTTPS via the interface endpoint), not
  a raw Postgres socket, so the placement tier does not affect reachability — it
  only has to be a tier the VPC actually has. The shared-VPC path now prefers the
  isolated tier when the VPC has one (keeping the DB off any NAT path) and falls
  back to `PRIVATE_WITH_EGRESS` otherwise, via the VPC context's `selectSubnets`.
  The standalone path is unchanged — it still builds its own VPC with a dedicated
  isolated tier.

  This is a `patch` bump: pre-1.0, where this repo reserves `minor` for breaking
  changes. The behavior change only affects the shared-VPC path that previously
  failed synth, so it is strictly a fix. The umbrella `@aws-blocks/blocks` gets
  the same bump because it re-exports `Database`.

  Also adds `Template.fromStack` unit coverage for `finalizeVpc` in
  `@aws-blocks/core` — asserting the provisioned `AWS::EC2::VPCEndpoint` set, the
  gateway/interface dedup, and the always-on CloudWatch Logs + SSM endpoints —
  which previously had no test exercising the provisioning path.

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

- 6496713: fix(core): harden VPC integration — scoped endpoint SG, runtime-subnet validation, instructive subnet errors

  Second-pass hardening of VPC support based on review feedback.

  **Interface endpoints are no longer reachable from the whole VPC.** They now get
  a dedicated security group that allows 443 only from the Blocks Lambda SG, and
  the endpoints are created with `open: false` to suppress CDK's default
  "allow 443 from the entire VPC CIDR" rule. On a bring-your-own VPC this stops
  unrelated workloads from reaching every Blocks interface endpoint.

  **`VpcRequirements.subnetRole` is replaced by `requiresEgress`.** The old field
  was declared but never consumed. `requiresEgress` expresses a real, validated
  capability: whether the BB's parent runtime (the shared handler Lambda) must be
  able to reach the internet. `finalizeVpc` validates it against the runtime's
  actual placement and fails synth with an actionable message on a mismatch — it
  never relocates the runtime (that's the customer's explicit choice).
  `bb-distributed-data` (DSQL) declares `requiresEgress: true`, turning a
  previously silent runtime failure (DSQL in isolated subnets deploys clean, then
  every call times out) into a build-time error.

  **`VpcContext.selectSubnets` is now instructive.** It takes the requesting BB and
  verifies the VPC actually has the requested subnet tier, throwing a BB-named,
  actionable error instead of the opaque CDK "no subnet groups" error. It accepts
  an explicit `{ fallback }` so a BB can opt into graceful degradation (e.g. Aurora
  over the Data API works from `private-with-egress` when there is no isolated
  tier); the downgrade is never silent. `bb-data` uses this.

  **Other fixes:** Lambda placement now fails fast with an actionable error when a
  VPC has no private-with-egress tier and none was specified; `bb-data` drops its
  unused 5432 ingress rule (Aurora is reached over the RDS Data API, not a socket);
  removed `any` casts from the Lambda props and endpoint/CIDR handling; de-duplicated
  the VPC/non-VPC branches in `BlocksStack`.

  All pre-1.0 `patch` bumps — no breaking changes to shipped, consumed API
  (`subnetRole` had no consumers). The umbrella `@aws-blocks/blocks` re-exports the
  affected types.

- 6496713: fix(core): VPC review follow-ups — egress capability, endpoint trim, S3 gateway

  Refines VPC support based on review feedback (all changes to the net-new,
  unreleased VPC feature).

  **`VpcRequirements.runtimeSubnet` becomes `requiresEgress?: boolean`.** A BB's
  runtime need is a capability ("my code must reach the internet"), not a specific
  subnet tier. Modeling it as a single role wrongly rejected a valid placement
  (e.g. a BB needing egress placed in a `public` subnet). `finalizeVpc` now resolves
  whether the runtime's placement actually provides egress — from the selected
  subnets, not a guessed role — and validates `requiresEgress` against that. When
  egress can't be determined (e.g. an imported VPC whose subnets aren't known at
  synth) it warns rather than fabricating a pass/fail. `bb-distributed-data` (DSQL)
  now declares `requiresEgress: true`.

  **SSM interface endpoint is no longer always provisioned.** Only `AppSetting` and
  the auth blocks (which compose `AppSetting`) use SSM, so it now flows from Building
  Block requirements. An app that uses neither no longer pays for an unused interface
  endpoint. CloudWatch Logs stays always-on (every in-VPC Lambda needs it for log
  delivery).

  **The S3 gateway endpoint is now always provisioned.** The runtime pulls config,
  secrets, and migrations from S3 at cold start. Gateway endpoints are free
  (route-table entries, no ENI), so this closes a real cold-start access gap at no
  cost.

- 302090a: Local dev server: handle raw-socket errors during the WebSocket upgrade instead of crashing.

  The `upgrade` handlers routed the HTTP upgrade without attaching an `'error'` listener to the raw `net.Socket` first. A stale WebSocket client that reset its connection inside the upgrade window emitted ECONNRESET on a socket with no handler, so Node's default unhandled-`'error'` behaviour killed the dev server process right after port bind. Both upgrade paths now attach `socket.on('error', () => socket.destroy())` as their first statement, the HTTP server answers malformed/aborted requests via a `clientError` handler, and the `noServer` `WebSocketServer` logs server-level errors rather than throwing. The fix is scoped to the vulnerable socket — a genuine error anywhere else still crashes as before.

- Updated dependencies [7b86b8e]
- Updated dependencies [4342149]
- Updated dependencies [e2c3c62]
- Updated dependencies [2806ae2]
- Updated dependencies [f552ebe]
- Updated dependencies [9aa0814]
- Updated dependencies [012cd89]
- Updated dependencies [81609a8]
- Updated dependencies [5eee114]
- Updated dependencies [d7312f9]
- Updated dependencies [d7312f9]
- Updated dependencies [21443ba]
- Updated dependencies [acd1628]
- Updated dependencies [6496713]
- Updated dependencies [bd67438]
- Updated dependencies [a47d71c]
- Updated dependencies [0385f7e]
- Updated dependencies [daf523a]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [302090a]
  - @aws-blocks/bb-auth-oidc@0.2.0
  - @aws-blocks/bb-app-setting@0.3.0
  - @aws-blocks/bb-dashboard@0.2.0
  - @aws-blocks/bb-distributed-data@0.2.0
  - @aws-blocks/core@0.5.0
  - @aws-blocks/hosting@0.3.1
  - @aws-blocks/bb-kv-store@0.2.0
  - @aws-blocks/auth-common@0.1.8
  - @aws-blocks/bb-agent@0.4.1
  - @aws-blocks/bb-async-job@0.2.1
  - @aws-blocks/bb-auth-basic@0.1.9
  - @aws-blocks/bb-auth-cognito@0.1.10
  - @aws-blocks/bb-cron-job@0.2.1
  - @aws-blocks/bb-data@0.3.0
  - @aws-blocks/bb-distributed-table@0.2.0
  - @aws-blocks/bb-email-client@0.1.7
  - @aws-blocks/bb-file-bucket@0.2.1
  - @aws-blocks/bb-knowledge-base@0.2.4
  - @aws-blocks/bb-lambda-compute@0.5.0
  - @aws-blocks/bb-logger@0.2.0
  - @aws-blocks/bb-metrics@0.1.7
  - @aws-blocks/bb-realtime@0.2.1
  - @aws-blocks/bb-tracer@0.2.0

## 0.5.0

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
  _count_, not tokens or wall-clock — pair them with a billing or CloudWatch alarm
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

- c45eb92: Extend stack-wide `BlocksDefaults` (introduced in the Infrastructure Options work) with three additive fields, and adopt them across the Blocks-managed infrastructure. Each field is read independently via `option ?? scope.defaults.field` — a per-block option always wins, and no field is derived from another.

  `@aws-blocks/core/cdk` now adds to `BlocksDefaults` (and both `BlocksPresets`):

  - `logRetention: RetentionDays` — how long Blocks-managed CloudWatch log groups keep events. Preset sandbox `ONE_WEEK`, production `ONE_YEAR`.
  - `throttling: { rateLimit, burstLimit }` — request-rate limits applied to every Blocks API Gateway stage. Preset sandbox `200 / 400`, production `1000 / 2000`.
  - `accessLogging: boolean` — structured JSON access logs on every Blocks API Gateway stage. **Off by default in both presets** (opt-in), because enabling it mutates the account/region-level API Gateway CloudWatch role singleton.

  Also newly exported from `@aws-blocks/core/cdk`: the `BlocksThrottling` type and `ensureApiGatewayAccount()` (provisions the account-level API Gateway CloudWatch Logs role once per stack). `Scope` gains a `handlerLogGroup` getter for the shared handler log group.

  **Log retention** — Blocks-managed log groups now follow `defaults.logRetention` instead of AWS's infinite default: the shared handler Lambda (now owned by `BlocksStack`/`BlocksBackend` as `scope.handlerLogGroup`), the `bb-distributed-table` GSI-manager Lambdas, the `bb-distributed-data` DSQL migration Lambda, the `bb-data` Aurora migration Lambda, and the `bb-app-setting` secret-init Lambda. `bb-logger` reconfigures the shared handler group's retention — **only when an explicit per-Logger `retention` is set** (a bare `Logger` no longer writes it back, so it can't clobber another Logger's value) — rather than creating its own `/aws/lambda/<fn>` group. (Note: the framework `custom-resources.Provider` Lambdas these BBs wrap still use AWS's default retention — the L2 `Provider` exposes no log-group/retention override.)

  **Throttling** — applied to the core REST API stage and the `bb-realtime` WebSocket stage. On a WebSocket stage the throttle unit is messages/second across the connection.

  **Access logging** — when enabled, each stage writes structured JSON access logs to a dedicated CloudWatch log group (retention = `defaults.logRetention`, removal policy = `defaults.removalPolicy` so production **RETAIN**s the audit trail on teardown). The account-level API Gateway CloudWatch Logs role is provisioned once per stack and shared across stages.

  **⚠️ Behavior changes on upgrade:**
  - **Throttling now caps the core REST API and WebSocket stages.** Before this change these stages had no stage-level throttle (they ran at the API Gateway account default, ~10k rps). After upgrade, sandbox is capped at 200 rps / 400 burst and production at 1000 rps / 2000 burst. Apps serving above the production ceiling will see `429`s — raise it with a per-stack `throttling` override (`defaults: { ...BlocksPresets.production, throttling: { rateLimit, burstLimit } }`).
  - **The shared handler Lambda log group changes.** The handler previously logged to Lambda's auto-created `/aws/lambda/<fn>` group (infinite retention); it now logs to a framework-owned group with the default retention. On upgrade the old auto group is left orphaned in CloudWatch (unmanaged, still infinite) — delete it manually if you want its history/cost gone. Likewise a `bb-logger`-created retention group from a prior version is replaced.
  - **Access logging** is **opt-in (off in both presets)**. When enabled it requires the account-level API Gateway CloudWatch Logs role — an account/region-level singleton, so enabling it is safe for **one Blocks stack per region** (see `ensureApiGatewayAccount()` for the multi-stack teardown caveat). It defaults off (rather than on for production) so an upgrade never mutates that account-wide singleton without an explicit opt-in.
  - **`BlocksDefaults` gains three required fields** (`logRetention`, `throttling`, `accessLogging`). Apps that spread a `BlocksPresets` preset (the documented path) are unaffected; code that hand-rolls a literal `BlocksDefaults` object will need to add the new fields to compile.

  `bb-dashboard` now points its log widgets at the framework-owned handler log
  group (`scope.handlerLogGroup.logGroupName`) instead of reconstructing
  `/aws/lambda/<fn>` — the handler now writes to a dedicated group with a
  CDK-generated name, so the old convention would leave the "Recent Errors" /
  "Log Volume" widgets querying an empty group.

  Hosting adoption of these defaults (SSR REST API + compute log groups) ships in a separate change.

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

- f2f186c: fix(hosting): DeleteOldBuilds no longer expires the build that is currently served (#480)

  The `DeleteOldBuilds` S3 lifecycle rule expired every object under `builds/`
  after `buildRetentionDays` (default 30), including the build that CloudFront KVS
  `meta.b` currently points to. An app that did not deploy within the retention
  window had its live build's objects expired out from under an otherwise-healthy
  stack — the router kept rewriting to the now-empty prefix, so every static path
  returned 403 (hosting ≤ 0.1.4) or 404 (≥ 0.1.5) while the API path stayed 200.
  Recovery required a redeploy.

  **Fix.** The lifecycle rule now matches only objects tagged
  `aws-blocks:build-state=superseded`. At the KVS cutover, after the pointer flips
  to the new build, the cutover handler tags the _outgoing_ build's objects
  superseded (best-effort; list + tag/untag only — the handler is granted **no** S3
  delete-object permission). The live build is never tagged, so it is never expired,
  regardless of deploy cadence. Superseded builds are still cleaned up after
  `buildRetentionDays`. S3 lifecycle `TagFilters` are inclusion-only (there is no
  "NOT tagged" predicate), which is why the superseded build is tagged rather than
  the live build excluded.

  **Rollback-safety hardening.** The same cutover also _clears_ the build-state tag
  on the _incoming_ build's objects, symmetric to tagging the outgoing one. Without
  this, a rollback that re-points `meta.b` back to a retained build that was tagged
  superseded by an earlier cutover would hand the now-live build to
  `DeleteOldBuilds` — #480 again. Clearing is best-effort and uses
  `s3:DeleteObjectTagging` (tags only, never objects).

  **`buildRetentionDays` is now configurable from `@aws-blocks/core`.** Previously
  `HostingProps` dropped it (only `retainOnDelete` was forwarded), so the only way
  to change retention was an L1 bucket override. It now flows through to the
  hosting bucket lifecycle rule. Must be at least `skewProtection.maxAge`
  (converted to days) or synth throws `InvalidSkewProtectionMaxAgeError`, as
  before.

  **New advisory guard.** An optional `storage.deployIntervalDays` hint emits a
  synth-time **warning** (never an error) when the deploy cadence is at or beyond
  `buildRetentionDays`, i.e. when superseded builds could age out before the next
  deploy and shrink the rollback window. The live build is unaffected, so this is
  a rollback-window note, not a correctness gate.

  Pre-1.0 `minor` per this repo's convention: the change alters the synthesized
  lifecycle rule and the `KvKeys` custom resource (a benign in-place bucket-config
  - Lambda-role update on the next deploy; no bucket replacement), and adds a new
    IAM grant (`s3:ListBucket` + `s3:PutObjectTagging` + `s3:DeleteObjectTagging`,
    scoped to `builds/*`) to the
    cutover handler. Build artifacts uploaded before the upgrade carry no
    `build-state` tag and are therefore never expired by the new rule — including
    the live build — so the upgrade cannot delete a running build; from the next
    deploy onward each superseded build is tagged and reclaimed normally.

- 46b7c89: Generate the local `aws-blocks` package's client entry point on fresh checkouts, under the correct export conditions.

  The templates declare `./client.js` as the package's `browser`/`import` entry and gitignore it as generated, so a scaffold built on any machine other than the one that scaffolded it failed to resolve the package, and `cdk synth` failed with it (the Hosting block builds the frontend during synthesis).

  `@aws-blocks/blocks` gains a `blocks-generate-client` bin (mirroring `blocks-generate-spec` and `blocks-vendorize`) that spawns the core generator worker with `--conditions=aws-runtime`, so the emitted client imports `aws-middleware` rather than `mock-middleware` regardless of how the hook is invoked. `@aws-blocks/core` exports the existing `generate-client-worker` subpath so the bin can resolve it. The templates wire `"prebuild": "blocks-generate-client"` (including `backend`, where the hook is dormant until a `build` script exists) and gitignore `.hosting/`, the Vite output written during synthesis.

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

- fe0f04a: fix(blocks): drop `jobQueueUrl` from the `Agent` `getSdkIdentifiers` overload

  The Agent BB no longer runs its loop on an internal AsyncJob (it moved to a Bedrock AgentCore Runtime),
  so it no longer registers a `jobQueueUrl` identifier. The umbrella `getSdkIdentifiers(agent)` overload
  still declared it, promising a field that resolves to `undefined` at runtime. Remove it; the overload
  now returns only `conversationsTableName`, `messagesTableName`, `sessionBucketName`, `realtimeWsUrl`,
  and `realtimeCallbackUrl`.

- 585feea: Document AuthCognito setAuthState error-state semantics, including retriable challenge failures and CodeMismatch handling.
- 64ddd74: refactor(core): retarget the config registry to the shared role and every compute

  `finalizeConfigRegistry` no longer takes a single handler function. It now takes
  the owning construct plus the shared execution role and the stack's computes
  (`finalizeConfigRegistry(root, executionRole, computes)`) and:

  - grants `s3:GetObject` on the config object **once to the shared execution
    role** instead of to one function's role, so every compute that assumes the
    role can read it; and
  - stamps `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY` on **every compute** via
    `compute.setEnv(...)` rather than on a single hardcoded handler.

  Adds a per-stack compute registry (`registerCompute` / `getComputes`): computes
  self-register on their owning stack in the `Compute` base constructor (state
  keyed on the stack, resolved via `cdk.Stack.of()`, like the config registry), so
  a multi-stack synth keeps each stack's computes isolated. `create()` reads the
  registry directly via `getComputes(stack)`.

  Behavior-preserving for the default single-compute app: the same config object
  is written to S3, the same two coordinates reach the runtime, and the same
  `s3:GetObject` permission is available — now via the shared role. Internal
  refactor; no public API or runtime-config-loading change.

- 165093b: `CronJob`: validate the schedule (and timezone) at synth so an invalid expression fails fast instead of after minutes of deploy.

  The CDK layer passed `schedule`/`timezone` straight into the EventBridge `CfnSchedule` with no validation, so an invalid expression — e.g. `rate(10 seconds)` (EventBridge's minimum is 1 minute) or a malformed `cron(...)` — passed `cdk synth` and was only rejected by EventBridge minutes into provisioning. The mock already validated these, so local dev and deploy diverged.

  The schedule parser and timezone check are now a shared `schedule` module used by both the mock and the CDK construct. `CronJob`'s constructor validates up front and throws `CronJobErrors.InvalidSchedule` / `CronJobErrors.InvalidTimezone` at synth, before any infrastructure is created.

  The synth gate is deliberately lenient for `cron(...)` — it checks the 6-field shape and defers field-level semantics (`L`/`W`/`#`, year fields, named days) to EventBridge — so it never rejects an advanced-but-valid schedule. The local mock, which must actually simulate the schedule, still can't model those forms; it now throws the new `CronJobErrors.ScheduleNotSupported` (rather than `InvalidSchedule`) for them, so local dev doesn't call a deployable schedule "invalid". No behavior change for valid, mock-supported schedules.

- 8de4a56: `DistributedTable` mock: order GSI sort-key ties deterministically to match DynamoDB.

  When a GSI sort key was shared by multiple items, the mock's `query` fell back to Map insertion order for the tied rows — so results depended on write order / disk-reload order and diverged from deployed behavior. The mock now tie-breaks on the base-table primary key (partition key, then sort key), matching DynamoDB's observed ordering for index rows with equal sort keys, and reverses the whole order (ties included) under `order: 'desc'`. AWS doesn't document a contractual guarantee for the tie order, so the mock is intentionally deterministic even where DynamoDB's contract is unspecified. No change for unique sort keys.

- Updated dependencies [9111c0c]
- Updated dependencies [fe0f04a]
- Updated dependencies [1b66571]
- Updated dependencies [d8a3901]
- Updated dependencies [585feea]
- Updated dependencies [64ddd74]
- Updated dependencies [df667c5]
- Updated dependencies [df667c5]
- Updated dependencies [64ddd74]
- Updated dependencies [df667c5]
- Updated dependencies [646614b]
- Updated dependencies [165093b]
- Updated dependencies [ed158cf]
- Updated dependencies [c45eb92]
- Updated dependencies [8de4a56]
- Updated dependencies [4a830a6]
- Updated dependencies [f2f186c]
- Updated dependencies [46b7c89]
- Updated dependencies [1da58fd]
- Updated dependencies [4b74c7f]
- Updated dependencies [2cb9d74]
- Updated dependencies [1da58fd]
  - @aws-blocks/bb-agent@0.4.0
  - @aws-blocks/bb-file-bucket@0.2.0
  - @aws-blocks/bb-auth-cognito@0.1.9
  - @aws-blocks/bb-knowledge-base@0.2.3
  - @aws-blocks/core@0.4.0
  - @aws-blocks/bb-cron-job@0.2.0
  - @aws-blocks/bb-data@0.2.7
  - @aws-blocks/bb-logger@0.1.6
  - @aws-blocks/bb-realtime@0.2.0
  - @aws-blocks/bb-distributed-table@0.1.7
  - @aws-blocks/bb-distributed-data@0.1.8
  - @aws-blocks/bb-app-setting@0.2.1
  - @aws-blocks/bb-dashboard@0.1.5
  - @aws-blocks/bb-lambda-compute@0.4.0
  - @aws-blocks/bb-async-job@0.2.0
  - @aws-blocks/hosting@0.3.0
  - @aws-blocks/auth-common@0.1.7
  - @aws-blocks/bb-auth-basic@0.1.8
  - @aws-blocks/bb-auth-oidc@0.1.10
  - @aws-blocks/bb-email-client@0.1.6
  - @aws-blocks/bb-kv-store@0.1.8
  - @aws-blocks/bb-metrics@0.1.6
  - @aws-blocks/bb-tracer@0.1.8

## 0.4.0

### Minor Changes

- 08ab129: Add `pointInTimeRecovery: boolean | { retentionDays: number }` to `BlocksDefaults` (and to `BlocksPresets`: `true` in `production`, `false` in `sandbox`).

  This extends the stack-wide infrastructure-defaults posture with the continuous-backup knob, so a Building Block whose service supports it (DynamoDB Point-in-Time Recovery) can resolve its default from `scope.defaults.pointInTimeRecovery` — read independently, the same way as `removalPolicy` and `deletionProtection`. `true` enables backups with the service default window, `false` disables them, and `{ retentionDays: n }` pins the window (the block validates `n` against its service's range) — on/off and window are one field since a window only means anything when backups are on. Blocks whose service has no equivalent simply ignore it. `bb-distributed-table` is the first consumer.

  > The property **name** (`pointInTimeRecovery`) and its `{ retentionDays }` shape are a public `@aws-blocks/core/cdk` surface addition and want API-BR sign-off before release.

### Patch Changes

- 1ff9d03: `AppSetting`: support a customer-managed KMS key for secrets via `kmsKeyArn`.

  Secret (`SecureString`) parameters were always encrypted with the default `aws/ssm` AWS-managed key, so their decrypt scope couldn't be controlled (e.g. for cross-account access or a dedicated key policy). Passing `kmsKeyArn` (also accepted by `AppSetting.fromExisting`) now encrypts the secret with that customer-managed key:

  - the bulk-init Custom Resource creates the parameter with the CMK (`KeyId`);
  - the shared handler is granted `kms:Decrypt`/`Encrypt` scoped to that specific key ARN (instead of the `aws/ssm` `ViaService` wildcard);
  - the runtime `put()` re-specifies the key on overwrite so it doesn't silently fall back to `aws/ssm`;
  - adding/changing/removing `kmsKeyArn` on an already-deployed secret re-encrypts its current value under the new key at deploy time, so decryption keeps working after a key rotation.

  `kmsKeyArn` is only valid with `secret: true` and must be a non-empty ARN. The default (no `kmsKeyArn`) is unchanged.

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

- ca8cfb6: feat(bb-async-job): submitBatch auto-chunks batches larger than SQS limits

  `submitBatch` previously rejected any batch over 10 payloads with
  `BatchTooLarge`, so a caller with more than 10 jobs had to reimplement SQS's
  chunking rules by hand. It now accepts up to 10,000 payloads and packs them
  into `SendMessageBatch` requests bounded by both SQS per-request limits — at
  most 10 entries and at most 256 KB of aggregate message body — sent with
  bounded concurrency (at most 5 requests in flight) rather than one long serial
  loop. Each batch entry's `Id` is the payload's original index, so the returned
  `jobIds` stay in input order and every id is the same SQS `MessageId` that
  `getStatus()` / `waitUntilComplete()` look up. `BatchTooLarge` is now thrown
  only when a batch exceeds the 10,000-payload soft cap — a guardrail against a
  single call fanning out to an unbounded number of SQS requests.

  A batch spanning multiple chunks is **not atomic**: an earlier chunk can land
  before a later one fails. The all-or-nothing signal is unchanged — a partial
  failure still throws `BatchSubmitFailed` — but the thrown error (now a typed
  `BatchSubmitFailedError`) reflects the partial reality across all chunks:
  `.jobIds` carries the real `MessageId` for every entry that made it onto the
  queue (with `null` at each failed index) and `.failed[]` lists every failure
  sorted by index, so a caller can retry only the failed indexes instead of
  re-submitting the whole batch. Two failure kinds feed `.failed[]`: an
  entry-level rejection is scoped to its index, while a transport-level `send()`
  rejection (throttling, connection, auth) fails that whole chunk and
  short-circuits the chunks not yet started (`code: 'BatchSubmitAborted'`) instead
  of hammering an unhealthy endpoint. An entry SQS returns in neither list becomes
  a `MissingResult` failure so a `null` id never escapes as a success.

  On full success the `trackStatus` write is now best-effort — a failure recording
  `queued` (e.g. DynamoDB throttling on a large fan-out) is logged rather than
  thrown, since the handler backfills the record anyway; otherwise a bookkeeping
  error would make a caller re-submit an already-enqueued batch. `recordQueuedBatch`
  also issues its conditional writes in groups of 25 (mirroring `BatchWriteItem`)
  rather than one unbounded `Promise.all`.

  The mock runtime submits one message at a time and never partially fails, so the
  transport/abort paths are AWS-only; it enforces the same soft cap and validates
  every payload before enqueuing any, matching the AWS runtime.

  This is a `patch` bump: pre-1.0, this repo uses `minor` to signal a breaking
  change, and this is not breaking — a batch of ≤10 behaves exactly as before, no
  public type changed (`BatchSubmitFailedError` is additive), and the previous
  `BatchTooLarge` threshold simply moved from 10 to 10,000. `@aws-blocks/blocks`
  gets the same bump because it re-exports `AsyncJob`.

- f00adb0: feat(core): resolve `Scope.compute`; the default compute owns the handler + gateway

  Add a `Scope.compute` getter that resolves the compute a block runs on: the
  nearest `_compute` assigned on the block or an ancestor scope, else the owning
  stack/backend's default compute.

  The default is a `LambdaCompute` that now **owns** the Lambda function + API
  Gateway. `setupBlocksInfra` no longer creates them; `BlocksStack` /
  `BlocksBackend` expose `handler` / `gateway` / `apiUrl` as getters that delegate
  to the default compute. The compute is created in `create()` before the backend
  module is imported, so a block reading `this.compute` in its constructor
  resolves to it. `_compute` is internal (no public option yet).

  Core no longer imports a concrete compute: `create()` requires a
  `defaultComputeFactory` on its props (`CoreBlocksStackProps` /
  `CoreBlocksBackendProps` — the public `BlocksStackProps` / `BlocksBackendProps`
  plus that factory) and calls it to build the default. The umbrella
  `@aws-blocks/blocks` supplies `LambdaCompute` by spreading the factory onto the
  props in a thin `create()` wrapper, so apps built on `@aws-blocks/blocks` are
  unaffected — their call site is unchanged.

  **Breaking (direct `@aws-blocks/core` consumers only):** core no longer provides
  a built-in default compute. `BlocksStack.create()` / `BlocksBackend.create()`
  now require a `defaultComputeFactory` field on the props (typed
  `CoreBlocksStackProps` / `CoreBlocksBackendProps`); props without it no longer
  type-check (and it throws at synth if forced). This break is inherent to moving
  the Lambda + API Gateway out of core — it is not specific to how the factory is
  passed. Migrate by either:

  - using `@aws-blocks/blocks` (`import { BlocksStack } from '@aws-blocks/blocks/cdk'`),
    which injects a Lambda default for you — the recommended path; or
  - supplying your own factory on the props:
    `BlocksStack.create(scope, id, { ...props, defaultComputeFactory: (root) => new LambdaCompute(root, 'DefaultCompute') })`,
    which requires depending on `@aws-blocks/bb-lambda-compute` and the internal
    `@aws-blocks/core/cdk/internal` types.

  **Resource replacement on redeploy:** because the Lambda function and API
  Gateway now live under the default compute's construct path
  (`.../DefaultCompute/...`), their CloudFormation logical IDs change, so a
  redeploy **replaces** the function + API Gateway and the API URL changes. These
  are internal resources, not a customer-facing contract. Any consumer with an
  already-deployed stack — in particular an Amplify Gen2 frontend wired to the
  current API Gateway URL (this repo carries a Gen2 nested-stack regression test,
  so Gen2 integration is real) — should confirm they can absorb a URL change
  before upgrading.

- de4f209: `KnowledgeBase.retrieve`: validate `maxResults` consistently across the mock and AWS runtimes.

  `maxResults` was normalized with `Math.min(Math.max(v ?? 10, 1), 100)`, which silently passed fractional and non-finite values (`1.5`, `NaN`, `Infinity`) straight through — the mock and the AWS `RetrieveCommand` then diverged, and Bedrock rejects a non-integer `numberOfResults`. A new shared `normalizeMaxResults` helper (used by both runtimes) keeps the documented clamp for finite integers and now rejects fractional/non-finite values up front with `KnowledgeBaseErrors.ValidationError`, before any search or Bedrock request.

  Fixes #430.

- f00adb0: `LambdaCompute`: default the function to **arm64 (AWS Graviton)**.

  The compute's Lambda now defaults to `Architecture.ARM_64` instead of CDK's `x86_64` default. arm64 Lambda is ~20% cheaper per GB-second than x86_64 at equivalent performance. Because `LambdaCompute` is the default compute for every `@aws-blocks/blocks` app, the shared handler runs on Graviton out of the box.

  The framework's own Building Blocks are pure-JavaScript esbuild bundles with no architecture-specific native code, so the switch is transparent for them. A backend `entry` bundle is the customer's own handler plus whatever they import, though — so an app that bundles an **x86-only native dependency** into its backend should be aware of the default. There is no per-app override yet; a customer-facing way to pin the architecture (`architecture` on `LambdaComputeProps` is present but internal for now) will be exposed alongside the public compute-configuration surface.

  > **Behavior change on next deploy:** the handler function's architecture is `arm64` (an in-place update on an existing function).

- 27346f3: Make AuthOIDC `requireAuth()` throw `ApiError(401, NotAuthenticatedException)` so the documented `handle401()` 401-redirect pattern works for a signed-out protected call.

  Previously `requireAuth()` threw a bare `Error` with no `status`. Over the JSON-RPC boundary `errorResponseFromCatch` serializes a non-`ApiError` as code `500`, so the client received an `ApiError` with `status === 500`. The README's `if (handle401(e, provider)) return;` helper only acts on `err instanceof ApiError && err.status === 401`, so it never matched and the app never redirected to sign-in — the error just surfaced. This aligns AuthOIDC with AuthCognito, whose `requireAuth()` already throws `ApiError(401, …)`. The error name is preserved, so existing `isBlocksError(e, AuthOIDCErrors.NotAuthenticated)` checks are unaffected.

- 5bfae0a: Reject oversized JSON-RPC request bodies at the shared parser. `parseRpcRequest` now caps the body at 10 MiB (`MAX_RPC_BODY_BYTES`, the same limit API Gateway enforces in production) and returns a `413` error named `PayloadTooLarge` before parsing or dispatch. In production API Gateway rejects an oversized body at the edge before the Lambda runs; enforcing the same limit at the parser means the local dev server rejects the same body instead of buffering it and wedging the local database (e.g. PGlite). Because both the Lambda handler and the dev server route through this one parser, the cap lives in a single place, and `decodeRpcResponse` surfaces it client-side as `ApiError.status === 413`.
- 0ac3879: `sandbox` / `deploy`: fail fast with an actionable message when AWS credentials are missing or expired.

  Both commands previously spent ~10 seconds synthesizing the CDK app before the first AWS call, so an unconfigured or expired credential surfaced only afterwards — as an opaque CDK/CloudFormation error that didn't name the real cause. `startSandbox` and `deploy` now run a bounded STS `GetCallerIdentity` check up front and, on a real credential error (missing/expired/invalid), exit immediately with guidance (`aws configure` / `aws sso login`, `AWS_PROFILE`, or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) instead of wasting the synth.

  The check is deliberately conservative: it only blocks on a genuine credential error (surfacing the SDK error _name_, never the raw message, which can embed an ARN/account id); a network or service error warns and lets the deploy proceed; and it skips (with a warning) when no region is set in `AWS_REGION` / `AWS_DEFAULT_REGION`, rather than guessing a region in the wrong partition (GovCloud/China). The scaffolded `sandbox` template entrypoint now `.catch`es and exits cleanly, matching `deploy`, so the guidance prints without an unhandled-rejection stack trace.

- Updated dependencies [1ff9d03]
- Updated dependencies [5798492]
- Updated dependencies [ca8cfb6]
- Updated dependencies [08ab129]
- Updated dependencies [f00adb0]
- Updated dependencies [f00adb0]
- Updated dependencies [309a236]
- Updated dependencies [08ab129]
- Updated dependencies [9d4ccea]
- Updated dependencies [de4f209]
- Updated dependencies [f00adb0]
- Updated dependencies [27346f3]
- Updated dependencies [5bfae0a]
- Updated dependencies [0ac3879]
- Updated dependencies [e4dac4a]
- Updated dependencies [9bd5b3e]
  - @aws-blocks/bb-app-setting@0.2.0
  - @aws-blocks/core@0.3.0
  - @aws-blocks/bb-async-job@0.1.5
  - @aws-blocks/bb-agent@0.3.5
  - @aws-blocks/bb-distributed-table@0.1.6
  - @aws-blocks/bb-lambda-compute@0.3.0
  - @aws-blocks/bb-kv-store@0.1.7
  - @aws-blocks/bb-file-bucket@0.1.5
  - @aws-blocks/bb-data@0.2.6
  - @aws-blocks/bb-knowledge-base@0.2.2
  - @aws-blocks/bb-email-client@0.1.5
  - @aws-blocks/bb-auth-cognito@0.1.8
  - @aws-blocks/bb-auth-oidc@0.1.9
  - @aws-blocks/bb-distributed-data@0.1.7
  - @aws-blocks/hosting@0.2.0
  - @aws-blocks/bb-auth-basic@0.1.7
  - @aws-blocks/bb-realtime@0.1.5
  - @aws-blocks/auth-common@0.1.6
  - @aws-blocks/bb-cron-job@0.1.5
  - @aws-blocks/bb-dashboard@0.1.4
  - @aws-blocks/bb-logger@0.1.5
  - @aws-blocks/bb-metrics@0.1.5
  - @aws-blocks/bb-tracer@0.1.7

## 0.3.1

### Patch Changes

- 448a47c: fix(bb-lambda-compute): add package metadata, prebuild, and pin dependency ranges

  Bring `@aws-blocks/bb-lambda-compute`'s package.json in line with its siblings:

  - add the `repository` / `homepage` / `bugs` blocks. Without `repository.url`,
    provenance publishing fails with `E422 … "repository.url" is ""` because npm
    cannot match the package against the sigstore attestation's source repo;
  - add the `prebuild` version-generation script (`generate-version.mjs`);
  - pin `@aws-blocks/core` to `^0.2.0` instead of `*`, matching every other
    package.

  Also pin the umbrella `@aws-blocks/blocks`'s dependency on
  `@aws-blocks/bb-lambda-compute` to `^0.2.0` instead of `*`, now that the package
  publishes a real version.

- Updated dependencies [448a47c]
  - @aws-blocks/bb-lambda-compute@0.2.1

## 0.3.0

### Minor Changes

- 7b4c62d: Add infrastructure `defaults` chosen once at the app entry point, replacing the per-block `sandboxMode` logic and the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin dance for removal-policy and deletion-protection.

  `@aws-blocks/core/cdk` now exports `BlocksDefaults` and the `BlocksPresets.sandbox` / `BlocksPresets.production` starting points. `BlocksStack.create` / `BlocksBackend.create` take a required `defaults` prop; start from a preset and override individual fields with a spread. `defaults` is anchored on the owning `BlocksStack`/`BlocksBackend` (resolved by walking up the construct tree, like `handler`/`executionRole`), so multiple backends in one stack each keep their own posture. Building Blocks read the resolved values via `scope.defaults`, and a per-block option always wins (`option ?? scope.defaults.field`).

  Adopted across the stateful Building Blocks: `bb-kv-store`, `bb-data`, `bb-distributed-data`, `bb-distributed-table`, and `bb-knowledge-base` now take their removal policy and deletion protection from `defaults` instead of reading the `sandboxMode` context themselves. (`bb-distributed-table` reads `defaults` directly for now; a richer per-block `protection` override lands with #282.)

  The `create-blocks-app` scaffolding templates are updated to pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production` (replacing the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin), so newly-generated apps satisfy the required prop.

  **Breaking:** `BlocksStack.create` / `BlocksBackend.create` now require a `defaults` field — pass `BlocksPresets.sandbox` or `BlocksPresets.production` (typically `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`). The previously-shipped experimental `hardening` prop and its `resolve*` helpers are removed; log-retention, API throttling, access-logging and point-in-time-recovery move into `defaults` in follow-up, per-feature changes.

### Patch Changes

- 6df9e2d: fix(data): declare the `data-common` TypeScript project reference in `bb-data` and `bb-distributed-data`

  Both packages depend on `@aws-blocks/data-common` in `package.json`, but neither
  listed it in its `tsconfig.json` `references`. Because `src/` ships in these
  tarballs, `data-common`'s declarations have to already exist for the compiler to
  resolve `@aws-blocks/data-common` — and nothing in the project-reference graph
  guaranteed that.

  Correct build order was therefore supplied by the position of `data-common` in
  the root `workspaces` array (index 8, ahead of `bb-data` at 10 and
  `bb-distributed-data` at 11) rather than by the dependency graph. Any build that
  does not follow that array order fails with:

  ```
  packages/bb-distributed-data/src/validation.ts(12,54): error TS2307:
    Cannot find module '@aws-blocks/data-common' or its corresponding type declarations.
  ```

  That was already reachable from the repo's own scripts: the former
  `npm run build:packages` resolved its `-w` targets in a different order and hit
  exactly this, which is why `scripts/agent-bench/steps/1-init-bench-app.sh`
  carried the comment "`build:packages` runs alphabetically and trips over
  bb-data". Adding the two missing references fixes the root cause, so build order
  now comes from the project-reference graph rather than from the ordering of the
  root `workspaces` array.

  No API, runtime, or packaged-output change — `tsconfig.json` is not in either
  package's `files`, so the published tarballs are unchanged.

- 3614a09: Stop `import.meta.url` from crashing the deployed Lambda. The backend handler is bundled to CommonJS, where `import.meta` is empty, so `fileURLToPath(import.meta.url)` in a handler, a Building Block's `aws-runtime` code, or a dependency became `fileURLToPath(undefined)` and threw at Lambda load (every request 502'd). esbuild only warned, so the broken bundle deployed. The handler bundling now shims `import.meta.url` / `import.meta.dirname` / `import.meta.filename` to their CommonJS equivalents (`pathToFileURL(__filename)`, `__dirname`, `__filename`) — the approach esbuild blesses and Rollup applies by default — so the bundle loads cleanly and a dependency that merely contains `import.meta` no longer trips a build failure. Exposes `blocksNodejsBundling()` from `@aws-blocks/core/cdk` (re-exported by `@aws-blocks/blocks`) so every framework `NodejsFunction` gets the same treatment. Note: inside the bundle these resolve to the bundled output location, not your source tree.
- edbf1aa: fix(bb-knowledge-base): disable `installLatestAwsSdk` on the ingestion custom resource

  The `StartIngestion` `AwsCustomResource` left `installLatestAwsSdk` at its default
  (`true`), so the provider Lambda ran an `npm install` of the AWS SDK on every
  invocation before it could call the API. That costs roughly 15-30s of extra cold
  start and raises the shared provider Lambda to 512MB of memory, though that
  reduction is only realized once every `AwsCustomResource` in the stack opts out —
  the provider is a stack-level singleton and its `memorySize` is resolved once at
  synth. The per-resource cold-start saving applies regardless.

  Nothing needed it. The resource calls `BedrockAgent.startIngestionJob`, a stable
  API already bundled in the Lambda runtime's AWS SDK v3, so the bundled client is
  sufficient and the install is pure overhead. Setting `installLatestAwsSdk: false`
  also silences CDK's `installLatestAwsSdkNotSpecified` synth-time warning for this
  construct.

  The tradeoff being accepted: the provider now uses whichever SDK v3 the Lambda
  runtime bundles at deploy time rather than installing the newest one. That is safe
  here because `startIngestionJob` is a foundational Bedrock Agent operation present
  since the client's initial release, not a recent addition.

  Internal construct wiring only — no public API change. The synthesized
  `Custom::AWS` resource now renders `InstallLatestAwsSdk: false`.

  Upgrade note: because `InstallLatestAwsSdk` renders as a property on the
  `Custom::AWS` resource while the `physicalResourceId` stays stable, the first
  deploy after upgrading is a CloudFormation _Update_ and fires `onUpdate` — so one
  `startIngestionJob` kicks off. This is harmless (ingestion is idempotent and
  fire-and-forget), but expect to see an ingestion start right after upgrading.

- 5262062: feat: extract `LambdaCompute` into `@aws-blocks/bb-lambda-compute`

  The abstract `Compute` base stays in core as a framework primitive; the concrete
  `LambdaCompute` (a `NodejsFunction` fronted by its own API Gateway, assuming the
  shared execution role) moves into a new package, `@aws-blocks/bb-lambda-compute`.

  The package is CDK-only and its sole export is internal — customers cannot
  instantiate a compute yet. Nothing in the default path constructs it, so this is
  additive and non-breaking.

- bfb9a63: Polish the PGlite init-retry helper (`data-common`) following #205 review:

  - Narrow the WASM-trap classifier to specific signatures (`RuntimeError: unreachable`, `wasm trap: unreachable`, Emscripten `Aborted(<reason>)`) instead of matching the bare word `unreachable`, so an unrelated probe failure whose text/stack merely contains "unreachable" (e.g. an `assertUnreachable` helper) is no longer misclassified as retryable. The `Aborted(` prefix (not just the empty `Aborted()`) is matched so memory-pressure aborts like `Aborted(Cannot enlarge memory arrays)` / `Aborted(OOM)` — the case this retry exists for — are caught. A `RuntimeError`-named error whose message contains `unreachable` is also treated as a trap, so the real V8/Node trap (message is literally `"unreachable"`, prefix only in the stack) is caught without depending on the stack surviving.
  - Classify retryability BEFORE consulting the attempt budget in `initializePgliteWithRetry`, so instance cleanup is uniform (a non-retryable error is always rethrown untouched) and `maxAttempts === 1` no longer closes the instance on a non-trap failure.
  - Guard `maxAttempts` against `NaN` (which `?? 3` does not default), preventing an unbounded close/recreate loop on a persistent trap.
  - Wrap a `recreate()` failure so the original init trap is preserved as the error `cause`, keeping debugging pointed at "PGlite kept trapping" rather than only the secondary recreate error.
  - Mark the four init-retry exports (`initializePgliteWithRetry`, `isPgliteUnreachableTrap`, `PgliteLike`, `PgliteInitRetryOptions`) `@internal` — they exist only so the engine packages can share the helper — and document the `PgliteLike` methods.

- e4b1498: Retry PGlite's WASM initialization on the intermittent `_pg_initdb` `unreachable` trap.

  PGlite defers `initdb` to the first query, which can trap with `unreachable` under memory pressure (notably on CI when several PGlite-backed dev servers boot concurrently) and kill the dev server mid-`runMigrations`. `PGliteEngine` (bb-data) and `DsqlMockEngine` (bb-distributed-data) now force initialization through a shared bounded retry (`initializePgliteWithRetry` in data-common) that closes the aborted WASM instance and boots a fresh one, so a transient init trap recovers instead of crashing the process.

- 8966cfb: fix(telemetry): detect Render and Taskcluster as CI

  Telemetry CI detection (`isCI()`) checked a fixed list of CI env vars but
  omitted Render and Taskcluster. Render sets `RENDER=true` on every build and
  service; Taskcluster tasks always set the namespaced `TASKCLUSTER_ROOT_URL`.
  Runs on those platforms were therefore reported as real user sessions instead
  of `ci:true`, inflating user metrics. `RENDER` and `TASKCLUSTER_ROOT_URL` are
  now included in both `isCI()` implementations (`@aws-blocks/core` and
  `@aws-blocks/create-blocks-app`). The umbrella `@aws-blocks/blocks` gets a patch
  bump because it re-exports `@aws-blocks/core`.

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [6df9e2d]
- Updated dependencies [3614a09]
- Updated dependencies [edbf1aa]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [e4b1498]
- Updated dependencies [406ba89]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-kv-store@0.1.6
  - @aws-blocks/bb-data@0.2.5
  - @aws-blocks/bb-distributed-data@0.1.6
  - @aws-blocks/bb-distributed-table@0.1.5
  - @aws-blocks/bb-knowledge-base@0.2.1
  - @aws-blocks/bb-lambda-compute@0.2.0
  - @aws-blocks/bb-realtime@0.1.4
  - @aws-blocks/auth-common@0.1.5
  - @aws-blocks/bb-agent@0.3.4
  - @aws-blocks/bb-app-setting@0.1.4
  - @aws-blocks/bb-async-job@0.1.4
  - @aws-blocks/bb-auth-basic@0.1.6
  - @aws-blocks/bb-auth-cognito@0.1.7
  - @aws-blocks/bb-auth-oidc@0.1.8
  - @aws-blocks/bb-cron-job@0.1.4
  - @aws-blocks/bb-dashboard@0.1.3
  - @aws-blocks/bb-email-client@0.1.4
  - @aws-blocks/bb-file-bucket@0.1.4
  - @aws-blocks/bb-logger@0.1.4
  - @aws-blocks/bb-metrics@0.1.4
  - @aws-blocks/bb-tracer@0.1.6

## 0.2.7

### Patch Changes

- 1e37c67: docs: per-block docs folders + committed BB catalog with CI sync check; CLAUDE/agents docs resolved via require.resolve

  `@aws-blocks/blocks` now ships one docs folder per Building Block under `docs/<block>/`
  (`README.md` / `API.md` / `DESIGN.md`), plus a committed, marker-delimited Building Block
  catalog in the package README that a `sync-docs --check` CI gate keeps in sync. The README's
  catalog section and the scaffolded `AGENTS.md` (`@aws-blocks/create-blocks-app`) now direct
  tools and agents to locate docs programmatically via
  `require.resolve('@aws-blocks/blocks/docs/<block>/README.md')` (and
  `require.resolve('@aws-blocks/blocks/docs/README.md')` for the catalog) rather than assuming a
  `node_modules/` path or following the human-facing relative links. Also adds a Security
  Considerations section to the package README.

- Updated dependencies [cb779c8]
  - @aws-blocks/core@0.1.18

## 0.2.6

### Patch Changes

- 75f5446: Add optional `fallback` parameter to `AuthenticatedContent` for rendering alternative content when the user is not authenticated.
- 2ed4177: Add stable `data-testid` hooks to the auth UI components so e2e suites can target the shipped `Authenticator` instead of forking it. Covers every interactive element (field inputs, hidden ones included, and submit buttons) plus the containers worth asserting against: the root, per-action wrappers, heading, error, the signed-in marker, `AuthenticatedContent`, and `AccountMenuBar`. Presentational markup such as hint text and layout wrappers stays unhooked. The full selector contract, including the `<action>:<provider>` form federated actions produce, is documented in CUSTOMIZING-AUTH-UI.md.

  The `@aws-blocks/blocks` umbrella package receives a `patch` because it re-exports these components from `@aws-blocks/auth-common/ui`. Sibling patch releases stay inside the umbrella's caret ranges, so `changeset version` never bumps it on its own (#212), and it is republished explicitly to stay in step with the components it hands to consumers.

- 5b2aede: `DistributedTable`: reconcile reads with the schema via a new `readValidation` mode (default `'coerce'`).

  **Behavioral change to the read path (preview).** Writes always validated against `schema`, but reads (`get`, `getBatch`, `query`, `scan`) returned the raw stored value. After a schema change, a row written under the old schema no longer conformed to type `T`: a newly added field was absent from the read (so the value silently violated `T`, and a `.default()` was never applied or persisted on write-back), and a required-no-default field made the read-modify-write cycle (`get()` → mutate → `put()`) throw `ValidationFailed`.

  Reads now reconcile stored items with the schema via `readValidation?: 'off' | 'coerce' | 'strict'`:

  - **`'coerce'`** (default) — apply the schema (fill defaults, narrow types) so legacy rows conform to `T` and round-trip cleanly, **without dropping data**: the coerced output is deep-merged over the raw stored item, so attributes not in the current schema (older-schema fields, columns another writer owns) are preserved rather than silently stripped on a read-modify-write. Arrays are replaced wholesale. On a value that can't be coerced, return the raw value + log a warning — **never throws**.
  - **`'strict'`** — throw `ValidationFailed` on any non-conforming item (opt-in; treats a mismatch as corruption).
  - **`'off'`** — return the raw stored value with no validation (the previous default behavior).

  ```ts
  const orders = new DistributedTable(scope, "orders", {
    schema: orderSchemaV2, // adds `currency: z.string().default('USD')`
    key: { partitionKey: "orderId" },
    // readValidation: 'coerce' is the default
  });
  const order = await orders.get({ orderId: "o1" }); // legacy row → currency: 'USD'
  await orders.put({ ...order, total: 20 }); // conforms to T; round-trips
  ```

  Migration note: the default is now `'coerce'` (previously reads returned raw values). Pass `readValidation: 'off'` to restore raw reads. Coercion is best-effort and validator-dependent — transform-bearing schemas (e.g. Zod) fill defaults and narrow types; check-only Standard Schema validators pass values through unchanged. `null` (a missing item) is untouched in all modes.

- feb5be4: Re-export the `auth.admin` types (`AdminOptions`, `AdminUser`, `AdminCreateInit`, `GroupAdmin`, `LifecycleAdmin`, `AdminSurface`, `AdminGetterOf`, `AdminDisabled`) from the umbrella package so consumers using `@aws-blocks/blocks` can name the values `auth.admin` returns and annotate `admin` options.
- 9de27dd: fix(core): stream CloudFormation progress to stdout and stop a stray SIGTERM from killing an in-flight deploy

  `npm run deploy` wrote nothing to stdout for the whole CloudFormation phase, and
  a backgrounded deploy was killed (exit 143) while CloudFormation kept going and
  finished server-side. Callers had no progress signal, could not tell success from
  failure, and re-ran deploys that had actually worked.

  Two causes, both fixed:

  - The CDK CLI picks its log stream as `isCI ? stdout : stderr`, so every
    CloudFormation event went to stderr and `npm run deploy > deploy.log` captured
    zero bytes. The deploy now passes `--ci` (log lines on stdout, errors still on
    stderr) and `--progress events` (one line per resource transition instead of a
    progress bar that needs a TTY).
  - The deploy ran `cdk deploy` through a blocking synchronous spawn with the child
    in this process's group, so signals could not be handled and the default
    SIGTERM disposition killed the CLI mid-deploy. The CDK CLI is now spawned in
    its own process group with its output piped and relayed line by line as it
    arrives, plus an idle heartbeat while a slow resource is converging. A single
    SIGTERM, or any SIGHUP, no longer abandons a converging deploy: it logs and
    keeps streaming. Ctrl-C, or a second SIGTERM, aborts and reaps the CDK process
    tree. Repeat deliveries of the same signal inside the coalescing window log one
    line instead of one per delivery.

  Worth knowing before you upgrade:

  - **The signal resilience is POSIX-only.** It needs process groups (`detached` is
    passed only when `process.platform !== 'win32'`) and real signal delivery, and
    Windows has neither: nothing outside the process delivers SIGTERM/SIGHUP there,
    so a kill on the process tree still ends the deploy and the abort path reaps by
    pid. Streaming, the heartbeat and the `--ci` argv apply on every platform.
  - **The `❌ Deployment failed.` banner moved from stderr to stdout**
    (`console.error` → `console.log`), so a caller capturing only stdout can tell a
    failed deploy from a killed process. Anything grepping _stderr_ for that exact
    string will no longer match it. The failure _reason_ has not moved: the CDK CLI
    keeps error-level output on stderr even under `--ci`, and the deploy entrypoint
    still prints the error itself with `console.error`, so stderr remains the place
    to grep for why a deploy failed. Both halves of that split are now covered by
    tests, including one against the real CDK CLI.

- 58f77dd: Document four things people were reverse-engineering from compiled output.

  - **Runtime config resolution.** The client config is served at the dotted path `/.blocks-sandbox/config.json`; `/config.json` is not a route, so a 404 there means nothing. `{"_placeholder":true}` in the frontend build output is the Hosting construct's synth-time stub (the real `apiUrl` is still an unresolved CloudFormation token), so it is expected pre-deploy rather than a broken config. Covers the resolution order, what each environment should actually return, and what a genuine failure looks like.
  - **`RawRoute`.** Full section in the core README: constructor signature, a `GET` example that sets status, `Content-Type` and body, what you can read off `ctx.request` and write to `ctx.response`, path/parameter/wildcard syntax, and the registration rules (reserved paths, duplicate routes, register-during-load). Also added a "serve a raw HTTP endpoint" entry to the block catalog decision tree, which had no pointer to it.
  - **Server-initiated OIDC sign-in.** New section in the `bb-auth-oidc` README for `GET /aws-blocks/auth/signin/<provider>`: the redirect chain through the IdP and the callback, the pending-auth and session cookies, the JSON error shape, a runnable `curl` walkthrough, when to use it instead of the client PKCE API, and a pointer to the integration tests that assert each response. One route is mounted per configured provider, so an undeclared provider name 404s instead of reporting `ProviderNotConfiguredException`, which comes from `getSignInUrl()`.
  - **Error and RPC semantics.** `ApiError`'s constructor arguments (including `cause` staying server-side and `retriable`), how its `status` becomes the JSON-RPC error code and decodes back into an `ApiError` on the client, `hasAuthError`'s signature and when it applies instead of `isBlocksError`, how `params` is read as positional args vs a named object, that a top-level JSON array body (a batch) is rejected with `-32600`, and that `broadcastAuthChange` comes from `@aws-blocks/blocks/ui` rather than the package root.

  Docs only, plus tests locking in the documented `ApiError`, `params` and batch-rejection behaviour, and the documented `404`s on the OIDC sign-in and sign-out routes.

- b83aaba: Add opt-in TTL support to `KVStore` and use it to expire `AuthCognito` session records.

  `KVStore` gains a `ttl` construct option that enables DynamoDB Time-to-Live on the table, plus per-write expiry via `put(key, value, { ttlSeconds })` or `{ expiresAt }`. Both default to off, so existing tables and every existing `put()` call are unaffected. Because DynamoDB deletes expired items asynchronously, `get` and `scan` also filter expired items on read in every runtime, and the local mock emulates the same expiry semantics. Maintenance sweeps that need to act on rows the reaper has not collected yet can opt out with `scan({ includeExpired: true })`.

  `AuthCognito` now enables TTL on its sessions table and stamps each session write with `now + sessionTtlSeconds`. Session records store live Cognito refresh tokens, so without an expiry the table grew without bound and retained those credentials at rest indefinitely; abandoned sessions are now reaped automatically. Authorization is unchanged — validity is still decided by token revalidation on every request.

  Two things to know before upgrading:

  - **Your next `cdk deploy` enables TTL on the existing sessions table.** Even though this is a patch, `AuthCognito` now passes `{ ttl: true }`, so the deploy issues a one-time `UpdateTimeToLive` against the live table. That is an online, non-disruptive DynamoDB operation — no downtime, no data loss — but it is a mutation of a live resource, so it shouldn't surprise anyone diffing a patch upgrade.
  - **Only sessions written after the upgrade expire.** A missing `ttl` attribute means "never expires" (matching DynamoDB), and existing rows are not backfilled, so sessions created before the upgrade keep their refresh tokens at rest indefinitely. Backfilling would need a one-time migration writing `ttl` onto every existing row. To close the retention gap immediately, revoke the pre-existing sessions instead — the revoke sweep deletes rows regardless of expiry state.

- f583c75: Add opt-in job status tracking to AsyncJob

  Pass `trackStatus: true` and AsyncJob records each job's lifecycle, which you can read with two new methods:

  - `getStatus(jobId)` returns the job's current state plus every state it has passed through.
  - `waitUntilComplete(jobId, options?)` waits until the job reaches `complete` or `failed`, with `timeoutMs`, `pollIntervalMs`, and `AbortSignal` support.

  Transitions are appended rather than overwritten, so intermediate states stay observable no matter when you read them. A handler that finishes in a millisecond still records that it went through `processing`, and a caller that checks once after the job settled sees the whole sequence. That removes the need to pad a handler with an artificial delay just to make the `processing` state catchable, and a retry appends another `processing` entry so attempt counts are visible too.

  Appends are guarded by a compare-and-swap, so the two ways two writers can hold the same record at once cannot drop a transition: a `queued` write arriving after SQS already delivered the message, and a duplicate delivery of the same message on an at-least-once queue.

  When the handler gets there first it creates the record itself, dating the submission from the moment it first saw the job, since that is all it knows. The `queued` write that arrives afterwards replaces that placeholder with the real submission time instead of dropping it, so `submittedAt` and the first transition always report when the job was submitted rather than when it started being processed.

  Enabling the flag provisions one DynamoDB table for the job's status records, with a 24 hour TTL, and adds a write on submit plus one per state change. Leave it off and nothing is provisioned; `submit()` stays a single SQS call and the status methods throw `StatusNotTracked`.

  Status writes on the handler path are logged rather than thrown, so bookkeeping can never retry work that succeeded or mask work that failed. The trade is that a dropped terminal write leaves a finished job without a terminal state, so read `waitUntilComplete()`'s `Timeout` as "status unknown" rather than "still running".

- 3c56267: `AuthBasic` and `Logger` now report `bbName`/`bbVersion` to `Scope`, so they appear in telemetry like every other Building Block.

  Both were listed in the umbrella's `aws-blocks.vendorize` map, so `scripts/generate-bb-names.mjs` had already generated them into `OFFICIAL_BB_NAMES` — but neither passed `bbMeta` to `super()`, and `Scope` only records a block in its registry when `bbName` is set. Their entries in that set were therefore inert: `Scope.getRegisteredBlocks()` could never name either block, so `product.buildingBlocks` under-reported two of the most widely used blocks. Each package now carries the standard `prebuild` (`generate-version.mjs AuthBasic` / `Logger`), which generates the `BB_NAME`/`BB_VERSION` its constructor passes through — the same wiring the other blocks use.

  `Logger` is composed internally by most other blocks (`new Logger(this, 'logger', { level: 'error' })`), so it will now be reported for effectively every application, and `totalCount` rises accordingly. That is the intended reading of the existing `Logger` entry in the vendorize map, not a new disclosure: `getRegisteredBlocks()` still exposes only names already on the official list, and customer-chosen block names remain counted-but-unnamed.

  `@aws-blocks/blocks` takes a `patch` because it re-exports both blocks; sibling releases stay inside its caret range, so `changeset version` would not bump it on its own (#273, #212). `@aws-blocks/core` needs no bump — both names were already present in the generated `OFFICIAL_BB_NAMES`, so that file is byte-identical.

- 0491157: `Metrics`, `Tracer`, and `DistributedDatabase` now report `bbName`/`bbVersion` to `Scope`, so they appear in telemetry like every other Building Block.

  All three were listed in the umbrella's `aws-blocks.vendorize` map, so `scripts/generate-bb-names.mjs` had already generated them into `OFFICIAL_BB_NAMES` — but none passed `bbMeta` to `super()`, and `Scope` only records a block in its registry when `bbName` is set. Their entries in that set were therefore inert: `Scope.getRegisteredBlocks()` could never name them, so `product.buildingBlocks` under-reported them. Each package now carries the standard `prebuild` (`generate-version.mjs Metrics` / `Tracer` / `DistributedDatabase`), which generates the `BB_NAME`/`BB_VERSION` its constructor passes through — the same wiring the other blocks use.

  `bb-tracer` and `bb-distributed-data` ship distinct mock implementations (their default entry does not re-export the AWS class), so both `index.aws.ts` and `index.mock.ts` carry the change; `bb-metrics`'s mock re-exports the AWS class, so its single runtime change covers both conditions. CDK entry points are deliberately left alone — telemetry is reported by the runtime class, not the synth-time construct.

  This is a follow-up to #298 (`AuthBasic`/`Logger`), completing telemetry parity for every vendorized block whose runtime class extends `Scope`. `@aws-blocks/blocks` takes a `patch` because it re-exports all three; sibling releases stay inside its caret range, so `changeset version` would not bump it on its own. `@aws-blocks/core` needs no bump — all three names were already present in the generated `OFFICIAL_BB_NAMES`, so that file is byte-identical.

- Updated dependencies [75f5446]
- Updated dependencies [feb5be4]
- Updated dependencies [2ed4177]
- Updated dependencies [feb5be4]
- Updated dependencies [49b3bd9]
- Updated dependencies [5b2aede]
- Updated dependencies [7b3bb06]
- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [bd59e60]
- Updated dependencies [b83aaba]
- Updated dependencies [a584007]
- Updated dependencies [f583c75]
- Updated dependencies [2d3dfdc]
- Updated dependencies [3c56267]
- Updated dependencies [0491157]
  - @aws-blocks/auth-common@0.1.4
  - @aws-blocks/bb-auth-cognito@0.1.6
  - @aws-blocks/bb-agent@0.3.3
  - @aws-blocks/bb-data@0.2.4
  - @aws-blocks/bb-distributed-table@0.1.4
  - @aws-blocks/core@0.1.17
  - @aws-blocks/bb-auth-oidc@0.1.7
  - @aws-blocks/bb-file-bucket@0.1.3
  - @aws-blocks/bb-kv-store@0.1.5
  - @aws-blocks/bb-distributed-data@0.1.5
  - @aws-blocks/bb-async-job@0.1.3
  - @aws-blocks/bb-auth-basic@0.1.5
  - @aws-blocks/bb-logger@0.1.3
  - @aws-blocks/bb-metrics@0.1.3
  - @aws-blocks/bb-tracer@0.1.5

## 0.2.5

### Patch Changes

- 0f3c73c: Reject `ALTER TABLE DROP COLUMN` at dev time, including the keyword-less Postgres shorthand (`ALTER TABLE t DROP col` / `DROP IF EXISTS col`). It is not in DSQL's supported `ALTER TABLE` subset ("unsupported ALTER TABLE DROP COLUMN statement", 0A000), but the PGlite-based local mock previously accepted it, so the error only surfaced on deploy. Migration and mock validation now fail locally instead. The supported forms — `ALTER COLUMN ... DROP DEFAULT` / `DROP NOT NULL` / `DROP EXPRESSION` / `DROP IDENTITY` and `DROP CONSTRAINT` — are not affected.

  The `@aws-blocks/blocks` umbrella package receives a `patch` because its published `docs/` folder is assembled from sibling block READMEs at build time (`scripts/sync-block-docs.mjs`), so this `bb-distributed-data` README update changes `@aws-blocks/blocks` packaged content.

- Updated dependencies [0f3c73c]
  - @aws-blocks/bb-distributed-data@0.1.4

## 0.2.4

### Patch Changes

- 09b94b8: Bump the Database block's Aurora PostgreSQL engine version from the retired `16.4` to `16.13`, and make the engine version configurable.

  AWS retired Aurora PostgreSQL `16.4` in us-east-1, after which `CreateDBCluster` failed with `Cannot find version 16.4 for aurora-postgresql`, blocking every deployment of a `Database` block. The default now points at the latest available `16.x` minor (`16.13`) for the longest deprecation runway.

  A new optional `postgresVersion` option on `DatabaseOptions` lets callers override the engine version (e.g. `postgresVersion: '16.13'`), so the next AWS retirement is a configuration change rather than a framework code fix. Overrides are validated at synth time (must be `MAJOR.MINOR`, e.g. `16.13`), so a malformed value fails fast with a clear error instead of an opaque `CreateDBCluster` failure.

  The `@aws-blocks/blocks` umbrella package receives a `patch` because its published `docs/` folder is assembled from sibling block READMEs at build time (`scripts/sync-block-docs.mjs`), so this `bb-data` README update changes `@aws-blocks/blocks` packaged content.

- Updated dependencies [09b94b8]
  - @aws-blocks/bb-data@0.2.3

## 0.2.3

### Patch Changes

- fc8cfad: Republish the umbrella `@aws-blocks/blocks` package so its tarball matches the updated re-exported APIs (`@aws-blocks/core`, `@aws-blocks/bb-agent`) and synced block docs. The sibling patch releases stayed within `blocks`' caret dependency ranges, so `changeset version` did not auto-bump the umbrella package, and the publish integrity guard requires a version bump when packed content changes.
- Updated dependencies [c4313cd]
- Updated dependencies [997c736]
  - @aws-blocks/bb-agent@0.3.2

## 0.2.2

### Patch Changes

- d898838: Include synced building block documentation updates.

## 0.2.1

### Patch Changes

- 8de7091: Include synced building block documentation updates.
- Updated dependencies [c7f1e7c]
- Updated dependencies [5491cae]
  - @aws-blocks/bb-distributed-data@0.1.3
  - @aws-blocks/bb-realtime@0.1.3

## 0.2.0

### Minor Changes

- b6fb281: Add `isSynced()` / `waitUntilSynced()` ingestion-sync API to KnowledgeBase.

  Bedrock ingestion runs asynchronously after deploy, so during the initial pre-sync window `retrieve()` returns an empty array even for queries that would later match — making "empty" ambiguous between "not yet synced with your latest data" and "synced, no match". The new methods resolve that ambiguity (mirroring Bedrock's own "Sync" / "sync with your latest data" terminology):

  - `isSynced(): Promise<boolean>` — `true` once the data source's most recent ingestion job is `COMPLETE`; `false` while it is not yet synced with your latest data. This reports data _freshness_, not availability — `retrieve()` is always callable and serves the prior synced snapshot during a re-ingestion. Both local-folder and imported `s3://` sources register a BB-managed data source, so both are tracked (the "no managed data source → synced" shortcut applies only to deployments predating this API, which have no data source id injected). Throws a typed `IngestionFailedException` (including `failureReasons`) if the latest job failed.
  - `waitUntilSynced(options?: { timeoutMs?: number; pollIntervalMs?: number; maxConsecutiveTransientErrors?: number; signal?: AbortSignal }): Promise<void>` — polls until synced (defaults: `timeoutMs` 300000, `pollIntervalMs` 5000, `maxConsecutiveTransientErrors` 3), throwing a typed `KnowledgeBaseTimeoutException` on timeout or propagating `IngestionFailedException` on a failed job. Up to `maxConsecutiveTransientErrors` _consecutive_ transient control-plane errors are tolerated (the counter resets on a clean poll); terminal errors short-circuit immediately. Transient covers both throttling / transient network failures **and** a _not-yet-visible_ knowledge base — during the post-deploy window the control plane can briefly return `ResourceNotFoundException` (the freshly-created KB/data source hasn't propagated yet), which is ridden out rather than treated as terminal; a _missing-KB config_ error (`KB_ID` unset) stays terminal. The poll interval carries ±20% jitter (only the delay between polls varies, never the poll count or the deadline) so many KBs don't poll in lockstep. Pass an optional `signal` (`AbortSignal`) to cancel the wait — checked before each poll and during the inter-poll delay — which rejects with the signal's abort reason (default: a `DOMException` named `'AbortError'`).

  Purely additive — `retrieve()` and all existing signatures are unchanged. The local mock reports synced immediately (no async ingestion window in local dev).

  The umbrella `@aws-blocks/blocks` package now also re-exports the new `WaitUntilSyncedOptions` type (alongside the existing `KnowledgeBase` re-exports) from both its runtime and CDK entry points, so consumers importing from `@aws-blocks/blocks` can reference it directly.

### Patch Changes

- Updated dependencies [b6fb281]
- Updated dependencies [b6fb281]
  - @aws-blocks/bb-knowledge-base@0.2.0

## 0.1.9

### Patch Changes

- Updated dependencies [e839301]
- Updated dependencies [179817f]
  - @aws-blocks/core@0.1.10
  - @aws-blocks/bb-data@0.2.1
  - @aws-blocks/bb-agent@0.3.0

## 0.1.8

### Patch Changes

- Updated dependencies [42fcbdf]
  - @aws-blocks/bb-data@0.2.0

## 0.1.7

### Patch Changes

- Updated dependencies [f946736]
- Updated dependencies [53adfb8]
- Updated dependencies [ce61bb7]
  - @aws-blocks/bb-agent@0.2.0
  - @aws-blocks/bb-auth-oidc@0.1.6

## 0.1.6

### Patch Changes

- 1da34f1: fix(auth): propagate the structured error name through `setAuthState()`

  The recommended client auth path is `createApi()` → `setAuthState()`. When an
  action failed, `setAuthState()` caught the thrown `ApiError` and returned an
  `AuthState` carrying only `error: e.message`, discarding the structured
  `e.name` (e.g. `'InvalidCredentialsException'`). Because `AuthState` had no
  field for an error name, a hand-rolled client could not branch on error type
  (e.g. "try sign-in, fall back to sign-up for a brand-new user") without
  brittle string-matching the human-facing message.

  `AuthState` now carries an optional `errorName`, and the `bb-auth-basic` and
  `bb-auth-cognito` `setAuthState` implementations populate it from the thrown
  `ApiError.name` (skipping the generic `'ApiError'` default). A new
  `hasAuthError(state, name)` type guard in `@aws-blocks/core` lets clients
  branch on the returned state — `isBlocksError` only matches thrown `Error`
  instances, so it cannot be used on the plain `AuthState` object. Rule of
  thumb: throw path → `isBlocksError`; returned `AuthState` → `hasAuthError`.

- Updated dependencies [f42c604]
- Updated dependencies [03b971a]
- Updated dependencies [1da34f1]
- Updated dependencies [683bf49]
  - @aws-blocks/core@0.1.6
  - @aws-blocks/bb-auth-oidc@0.1.4
  - @aws-blocks/auth-common@0.1.3
  - @aws-blocks/bb-auth-basic@0.1.3
  - @aws-blocks/bb-auth-cognito@0.1.5
  - @aws-blocks/bb-kv-store@0.1.4

## 0.1.5

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
- Updated dependencies [f24d3c3]
- Updated dependencies [d4a1390]
  - @aws-blocks/auth-common@0.1.2
  - @aws-blocks/bb-agent@0.1.3
  - @aws-blocks/bb-app-setting@0.1.3
  - @aws-blocks/bb-async-job@0.1.2
  - @aws-blocks/bb-auth-basic@0.1.2
  - @aws-blocks/bb-auth-cognito@0.1.4
  - @aws-blocks/bb-auth-oidc@0.1.3
  - @aws-blocks/bb-cron-job@0.1.3
  - @aws-blocks/bb-dashboard@0.1.2
  - @aws-blocks/bb-data@0.1.2
  - @aws-blocks/bb-distributed-data@0.1.2
  - @aws-blocks/bb-distributed-table@0.1.3
  - @aws-blocks/bb-email-client@0.1.3
  - @aws-blocks/bb-file-bucket@0.1.2
  - @aws-blocks/bb-knowledge-base@0.1.3
  - @aws-blocks/bb-kv-store@0.1.3
  - @aws-blocks/bb-logger@0.1.2
  - @aws-blocks/bb-metrics@0.1.2
  - @aws-blocks/bb-realtime@0.1.2
  - @aws-blocks/bb-tracer@0.1.4

## 0.1.4

### Patch Changes

- 7fd51e0: fix(bb-auth-cognito): discriminate `SignInResult` on a string `status` field

  `SignInResult` (from `signIn` / `confirmSignIn` / `autoSignIn`) now discriminates
  on a string `status` (`'signedIn' | 'continueSignIn'`) instead of the `isSignedIn`
  boolean, so native-client codegen (Swift / Kotlin / Dart) emits clean, named,
  switch-decoded variants. Narrow with `if (result.status === 'signedIn')`.

  Breaking change to the `SignInResult` shape (pre-release): `isSignedIn` is removed,
  not aliased.

- Updated dependencies [7fd51e0]
- Updated dependencies [e98bab4]
  - @aws-blocks/bb-auth-cognito@0.1.3
  - @aws-blocks/core@0.1.3

## 0.1.3

### Patch Changes

- 835c425: docs(bb-agent): document AgentStreamChunk types and Message roles
- Updated dependencies [835c425]
- Updated dependencies [dd07335]
  - @aws-blocks/bb-agent@0.1.2

## 0.1.2

### Patch Changes

- 7b80811: Add in-repo Building Block docs discoverability.

  The `@aws-blocks/blocks` package now ships a `docs/` folder containing every Building Block README (one per block) plus a generated `index.md` with a decision tree and catalog. This gives humans and AI agents a single, stable path to all block documentation — `node_modules/@aws-blocks/blocks/docs/` — instead of scattering them across 19+ individual package paths.

  - `@aws-blocks/blocks`: adds `docs/` to the published package (assembled at build time via `scripts/sync-block-docs.mjs`). README expanded to be a comprehensive guide (architecture, workflow, best practices, common mistakes).
  - `@aws-blocks/create-blocks-app`: AGENTS.md templates updated to point to the blocks README and docs folder as the canonical entry points.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-auth-cognito@0.1.1
  - @aws-blocks/bb-auth-oidc@0.1.1
  - @aws-blocks/auth-common@0.1.1
  - @aws-blocks/bb-app-setting@0.1.1
  - @aws-blocks/bb-distributed-table@0.1.1
  - @aws-blocks/bb-file-bucket@0.1.1
  - @aws-blocks/bb-kv-store@0.1.1
  - @aws-blocks/bb-metrics@0.1.1
  - @aws-blocks/bb-realtime@0.1.1
  - @aws-blocks/bb-agent@0.1.1
  - @aws-blocks/bb-async-job@0.1.1
  - @aws-blocks/bb-auth-basic@0.1.1
  - @aws-blocks/bb-cron-job@0.1.1
  - @aws-blocks/bb-dashboard@0.1.1
  - @aws-blocks/bb-data@0.1.1
  - @aws-blocks/bb-distributed-data@0.1.1
  - @aws-blocks/bb-email-client@0.1.1
  - @aws-blocks/bb-knowledge-base@0.1.1
  - @aws-blocks/bb-logger@0.1.1
  - @aws-blocks/bb-tracer@0.1.1

## 0.1.0

Initial version
