# @aws-blocks/core

## 0.8.0

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

- 48c35f6: feat(core): Node clients resend a call once when the connection closes before the response headers arrive (at-least-once delivery); `retryStaleConnection: false` opts out

  In Node (CLIs, SSR servers, scripts), an API call made after a few idle seconds could fail with `TypeError: fetch failed` (cause `other side closed`, `ECONNRESET` or `EPIPE`) when the deployed API had closed the pooled keep-alive connection just as the call was sent. The typed client now resends such a call once on a new connection, but only when `fetch` failed before the response headers arrived, with `TypeError: fetch failed` whose cause is an undici socket error (`UND_ERR_SOCKET`, for example `other side closed`), `ECONNRESET` or `EPIPE`.

  **This makes delivery at-least-once.** In the idle-close race the first copy never reached your method. But Node's `fetch` doesn't say whether the connection was a reused one, so the same failure on a fresh connection is resent too, including a server that read the request and crashed before answering: in that rare case a method runs twice. Behind API Gateway or CloudFront a crashed backend answers with a 5xx, which is never retried. Keep state-changing methods idempotent where a duplicate would matter, or pass `retryStaleConnection: false` to `ApiNamespaceClient` (or to the generated `generateClient`) for at-most-once delivery. Timeouts, aborts, failures after the response headers arrived (while reading the body), and HTTP or JSON-RPC errors are still never retried. Browser behaviour is unchanged (browsers already resend in this case).

- 48c35f6: The Lambda handler routes Cognito user pool trigger events to the Building Block registered for that user pool (`EventSourceMapping.COGNITO_USER_POOL`). It returns the event unchanged, and it rejects an event for a pool that no block handles.
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

- 48c35f6: Two Building Blocks that would handle the same Lambda event now fail `cdk synth`, instead of deploying and then failing every request on cold start. This covers two `AsyncJob`s whose queue names collide, and two `CronJob`s or `Realtime` blocks that end up with the same scope-qualified id (for example `x-y`/`z` and `x`/`y-z`). The error names the event key and both blocks.

  `registerConfig()` now also fails synth when another construct has already registered the same config key for the same backend with a different value, naming the key and both constructs; before, the second value silently replaced the first and both blocks read the same resource at runtime. Config keys built from a block id fold case and map every non-alphanumeric character to `_`, so ids such as `orders-a` and `orders_a` (or `Orders` and `orders`) collided this way: rename one of the blocks. Registering a key again from the same construct, or with the same value, is unaffected. Keys shared by design keep their last-one-wins behaviour: `Hosting`'s `BLOCKS_PUBLIC_ORIGIN` / `CORS_HOSTING_ORIGINS`, the dashboard URL, and `AppSetting`'s `BLOCKS_SSM_PARAM_*` key.

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

- 9c96135: feat(bb-file-bucket): customer-managed KMS encryption, Object Lock, and a stack-wide default for S3 access logging

  - **`encryption`** on `FileBucket` takes the same values as `KVStore` and `DistributedTable`. `'aws-managed'` (the default) keeps SSE-S3. `'customer-managed'` creates a dedicated KMS key for the bucket, with rotation on, and removes it along with the bucket. `FileBucket.fromKmsKey(arn)` uses a key you already own. Both KMS options use S3 Bucket Keys. The runtime role is granted the key permissions, so `put`/`get` and presigned URLs keep working.
  - **`objectLock: { mode: 'governance' | 'compliance', retentionDays }`** turns on S3 Object Lock with a default retention for every new object version. It needs versioning (on by default) and a retained bucket, and both are checked at synth: `versioned: false` and a `'destroy'` removal policy, which is the sandbox default, both fail synth. Pass `removalPolicy: 'retain'` to use Object Lock in a sandbox. Object Lock can only be turned on when the bucket is first created. S3 requires a signed checksum on every upload to such a bucket, which a presigned URL can't carry, so `putUrl()` and `createUploadHandle()` throw the new `FileBucketErrors.PresignedUploadUnsupported` there; upload with `put()`.
  - **`BlocksDefaults.storageAccessLogging`** (optional) turns S3 server access logging on or off for every `FileBucket` without changing API Gateway access logging. It is unset in both presets, so `FileBucket` still falls back to `accessLogging` and existing stacks deploy unchanged.

  `encryption` and `objectLock` are ignored on a bucket wrapped with `FileBucket.fromExisting`, and synth warns when either is set there. `@aws-blocks/blocks` re-exports `ObjectLockOptions` and the FileBucket key reference type, as `FBExternalKmsKeyRef`.

  `@aws-blocks/core` now parses the `encryption` option in one place for all three storage blocks. An unrecognized value still warns and falls back to the AWS-managed default.

- 63b154f: feat(core): multi-compute routing — per-namespace RPC paths + shared-gateway fan-out

  Make the shared REST API gateway route each API namespace to the compute that hosts it, in two parts.

  **Per-namespace paths.** The typed RPC client now POSTs to `/aws-blocks/api/{namespace}` (the namespace in the path) instead of the shared `/aws-blocks/api` — a gateway routes by URL path, not the JSON-RPC body, so giving each namespace its own path is what lets one gateway fan out to multiple computes. `{namespace}` is the backend export name. The body still carries `namespace.method`, and that is what the runtime handler and the local dev server dispatch: a per-namespace path must be exactly `/aws-blocks/api/{namespace}` and name the same namespace, or the request is rejected with a JSON-RPC `-32600` Invalid Request rather than silently running either one. `POST /aws-blocks/api` keeps working unchanged, so raw HTTP callers that use it are unaffected.

  Migration note for `ApiNamespaceClientOptions.url`: pass the **base** URL (e.g. `/aws-blocks/api`, or `https://d123.cloudfront.net/aws-blocks/api`) — the client now appends `/{namespace}` itself. A pre-qualified URL that already includes the namespace routes to `{url}/{namespace}` and is not supported.

  Deploy order: a web client built with this release calls `/aws-blocks/api/{namespace}`, which needs the gateway resource this release adds. Deploy the backend before, or together with, clients built against it; a gateway deployed from an earlier release may reject the per-namespace path (403). If you run your own proxy or rewrite in front of the API (nginx, a framework rewrite, your own CloudFront behavior), make it forward the whole `/aws-blocks/api/*` subtree, not just the exact `/aws-blocks/api` path — `Hosting` already does.

  The native clients call the same per-namespace paths from `aws-blocks-swift` 0.2.0, `aws-blocks-kotlin` 0.3.0 and the next Dart `blocks_runtime` release. Native clients from earlier releases POST to the bare `/aws-blocks/api` URL, which keeps working and runs every call on the default compute.

  **Gateway fan-out.** The shared gateway now routes each namespace's path to the compute that hosts it. The default compute's function stays behind the catch-all resources, so the RPC root, auth, `RawRoute`s, and any namespace left on the default compute all reach it; a new `/aws-blocks/api/{proxy+}` resource carries the per-namespace RPC paths for those namespaces. Every non-default compute gets its own Lambda integration plus a literal `/aws-blocks/api/{namespace}` (`ANY`) resource for each namespace it hosts. A literal resource wins over the sibling `{proxy+}`, so requests fan out within a single gateway — and a single CloudFront origin under `apiFrontDoor: 'cloudfront'`. Routes key on each namespace's export name — what the client calls — read from the backend module after it is imported, and each namespace's compute is resolved then (the namespace's own `compute` option, else the compute of the scope it was built in). A non-default compute's function gets one API-scoped invoke permission however many namespaces it hosts. Synth fails with a clear error for a namespace on a compute that takes no API traffic, or for an export name API Gateway can't use as a path segment.

  For an app that gives no namespace its own compute (every app before the `ApiNamespace` `{ compute }` option), every namespace resolves to the default compute and the only synthesized change is the additive `/aws-blocks/api/{proxy+}` resource; existing gateway resources keep their logical IDs. The `createSharedGateway` signature (it now takes the per-compute namespace routes + default compute) is `@internal`, and so is the `ComputeBase.namespaces` list this replaces.

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

- 48c35f6: `hosting-secret remove --force` and `blocks secret remove --force` now always need `--yes` (or `-y`) to confirm, in every stage, and print a warning first that names the stage (or says an un-staged value is shared by every stage, including production) and that the delete is immediate with no recovery window. Without `--yes` the command refuses before it calls Secrets Manager. **This changes existing CLI behaviour:** scripts that run `remove --force` must add `--yes`. A plain `remove` is still recoverable, `config` removes are unchanged, and the programmatic `removeValue()` / `removeSecret({ force: true })` stay non-interactive and log the same warning.
- 82ea78a: A project config can no longer re-enable telemetry that a global config disabled.

  `isTelemetryEnabled()` returned early on a project `telemetry.enabled: true` before reading `~/.blocks/config.json`, so `blocks-telemetry --disable --global` followed by `--enable` left the send gate open while `--status` reported disabled. The gate now resolves through `getTelemetryStatus()`, so only `false` short-circuits and the two cannot disagree. `blocks-telemetry --enable` also warns, naming the mechanism, when a broader opt-out still applies. The env var already overrode both config files, and a project `false` still beats a global `true`.

  Behavior change (0.x minor = breaking channel): if you globally disabled telemetry and relied on a project config to turn it back on, that project stays opted out. Re-enable globally with `npx blocks-telemetry --enable --global`.

- e44ac0c: Report the hosting framework in CLI telemetry. The `Hosting` construct records its resolved framework during synth and the deploy/sandbox orchestrator attaches it to the telemetry event, gated to the values the ingestion schema accepts (`nextjs`, `nitro`, `nuxt`, `astro`, `sveltekit`, `spa`, `static`). Backend-only projects report no framework.
- b003705: The `AWSToolsMetrics.AWSBlocks` template metadata can now be turned off with `AWS_BLOCKS_DISABLE_TEMPLATE_METADATA=1`, the CDK context `blocks:template-metadata=false`, or by turning off CDK version reporting (e.g. `cdk deploy --no-version-reporting`).

### Patch Changes

- 90c1b12: Stabilize the core telemetry HTTP tests by waiting for delivery instead of fixed delays and cleaning up their local servers, temporary files and environment even when a test fails or times out.
- 50b8c94: `npm run deploy` and `npm run sandbox` now check that CDK has been bootstrapped in the target account and Region before they synthesize. In an account and Region that were never bootstrapped, a deploy used to fail only after synthesis, with `SSM parameter /cdk-bootstrap/hnb659fds/version not found`. The commands now read that parameter, with the credentials that the credential check verified and the qualifier from `@aws-cdk/core:bootstrapQualifier` in the CDK context, and stop right away with the command that bootstraps the account and Region: `npx cdk bootstrap aws://<account-id>/<region> --app=`. `--app=` keeps CDK from synthesizing the app to find environments. The commands never bootstrap for you, because bootstrapping creates IAM roles in the account. Only a missing parameter stops the deploy; a denied read, a network error or a timeout does not. The destroy commands do not run this check.
- ce5dfa9: Container compute no longer requires a local Docker daemon to deploy. Instead of
  building a container image from a Dockerfile (`ContainerImage.fromAsset`, which
  shells out to `docker build`), the task now runs a stock public Node image
  (`public.ecr.aws/docker/library/node:24-slim` by default) verbatim via
  `fromRegistry`, and the application code is shipped as an S3 asset and fetched at
  container start by a dependency-free bootstrap using the task IAM role. `cdk
deploy` of a container-backed `Compute`/`AsyncJob` now needs no Docker.

  The container base image moves from Node 22 to Node 24 to match the framework's
  default Lambda runtime (`DEFAULT_NODE_RUNTIME`).

  The `image` option on a `container` `Compute` keeps its name but its contract is
  clarified: it is the runtime image, used verbatim (no build), and must provide a
  Node 24 runtime; your application code is always injected by Blocks at boot, not
  baked into the image.

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
- 48c35f6: `removeSecret()` from `@aws-blocks/core/scripts` now accepts `force: true`, matching `blocks secret remove --force --yes`: the secret is deleted immediately instead of being scheduled for deletion, so its name is free to reuse at once.
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
- 91ed1fc: fix(core): deploy every stack with `npm run deploy`

  `npm run deploy` now passes `--all` to `cdk deploy`. Apps that synthesize more than one stack — `Hosting` with an explicit `env.region` other than `us-east-1` (which adds a `us-east-1` CloudFront-alarm monitoring stack), or any Lambda@Edge function such as a Next.js `runtime = 'edge'` route (which adds the CDK edge-support stack in `us-east-1`) — previously failed before any stack was deployed, because the CDK CLI refuses a multi-stack app without a stack selector. This matches `npm run sandbox`, which already passes `--all`.

- 48c35f6: `deploy()` in production mode no longer hangs after the deploy finishes. It used to load your backend's local development (mock) versions of the Building Blocks while generating the client, which started local runtimes (the local `Database` engine, `CronJob` schedules) that kept `npm run deploy` running, and kept logging `[CronJob:…] triggered at …`, after "✅ Deployment complete!". Deploy no longer loads local mocks. As a side effect, it no longer applies migrations to, or writes data into, your local `.bb-data/` database.
- d062eeb: Before they deploy, `npm run deploy` and `npm run sandbox` now print the deployment target: the credentials that CDK deploys with (an AWS profile, access keys from the environment, or container or web identity credentials) and the configured Region. As in CDK, access keys from the environment (including the `AMAZON_` names that CDK also reads) are used before `AWS_PROFILE` unless `cdk.json` sets a profile; the credential check now verifies those keys rather than the profile. When the credential check succeeds, they also show the account name and the AWS account plan (Free or Paid, with its status), read with the same credentials that the check verified. These reads are optional and never stop a deploy. If they are denied, unsupported, empty, malformed or take longer than 2.5 seconds, the value shows as "not available". Account IDs, ARNs, error text and plan credits are not printed. `npm run destroy` and `npm run sandbox:destroy` print only the deployment target.

  When the credentials are the AWS-managed role from the new AWS sign-up experience (a role at the path `/managed/` that `account-access.amazonaws.com` can assume, read with `iam:GetRole`), the output also has a one-line link to `https://settings.aws.com/billing` for spend limits, with a reminder to check that the project selected there matches the deployment target. Other credentials, or a role that cannot be read in time, get no link. When a profile has no Region, the warning now explains how to use `aws login`: set the profile Region to your project's Region before you sign in, and sign in again after you change it.

  `@aws-blocks/core` now depends on `@aws-sdk/client-account`, `@aws-sdk/client-freetier` and `@aws-sdk/client-iam`. They load only when a deploy command runs.

- c22eeee: `npm run sandbox:destroy` now removes every stack the sandbox deploy creates (`cdk destroy --all`, the same selection `npm run sandbox` deploys with). Before, a sandbox app with more than one stack, such as one with a separate stack for an `ec2.Vpc.fromLookup`, or with `Hosting` and a Lambda@Edge function (an edge-runtime route or Next.js middleware) deployed outside us-east-1, which adds an `edge-lambda-stack-*` stack, could not be torn down: CDK refused with "specify which stacks to use", and the command failed after its retries without deleting any stack. Every top-level stack the app synthesizes in sandbox mode is deleted, dependent stacks first, including a stack you add yourself, and CDK prints each stack as it deletes it. Give such a stack a name derived from the sandbox's stack name, so it is not shared with production or other sandboxes, and don't create a stack in sandbox mode if it must outlive the sandbox.

  When a delete attempt fails, the S3 buckets that are emptied before the retry, and the stack events that tell whether AWS throttled the delete, are now read from every stack of the app, each looked up in its own Region (the edge stack is in us-east-1) with the profile and Region CDK uses (`cdk.json`, `AWS_DEFAULT_PROFILE`), instead of only the stacks `cdk ls` names, with the SDK's default Region. A Lambda@Edge function can only be deleted after CloudFront removes its replicas, which can take a few hours: when the edge stack fails to delete for that reason, the command now says so and stops instead of retrying; run `npm run sandbox:destroy` again later. The destroy also passes the same `projectRoot` as the sandbox deploy, so both resolve the same stack names.

- 1546160: `sandbox:destroy` and production `destroy` now ride out AWS API throttling
  during teardown. When the stack's events show a resource delete failed on a
  throttle (most often API Gateway's `DeleteRestApi` quota of one request every
  30 seconds per account, hit when several stacks in one account are torn down at
  once), the retry backs off exponentially with randomized waits (up to about 1,
  2, 4, then 5 minutes) and keeps retrying for about 20 minutes after the first
  failure, instead of giving up after the fixed 60s and 120s waits. The
  randomization keeps parallel teardowns from retrying in lockstep. Because each
  delete attempt can itself take several minutes, a destroy that stays throttled
  can now run for about 30 minutes before it fails (about 18 minutes before this
  change). When it does fail on a throttle, it says so and suggests waiting a few
  minutes before running destroy again.

  Failures that are not throttles keep the existing schedule (60s, then 120s),
  except that none is retried once throttling has used up the 20-minute budget.
  Detection reads the stack events with the caller's credentials
  (`cloudformation:DescribeStackEvents`); if they cannot be read, a warning is
  printed and the failure is treated as not throttled.

- 8565ef7: fix(core): name the customer's `Compute` in shared-gateway synth errors

  The synth errors for a compute that can't serve API namespaces, and for an
  export name API Gateway can't route, named the compute by its construct id —
  for a `Compute` block that is its internal `backing` child. They now give the
  compute's full construct path (for example `MyStack/app/reports/backing`), which
  includes the id you passed to `new Compute(...)`.

- 515089c: fix(hosting): serve the default 404 page behind every front door

  A multi-page static site that ships no 404 page of its own and sets no
  `errorPages.notFound` (for example Astro with `output: 'static'` and no
  `404.astro`) now gets AWS Blocks' default "404 — Page Not Found" page, at HTTP
  404, behind every front door, not only CloudFront. The ALB and API Gateway
  (HTTP and REST) doors serve it from their asset proxy instead of a plain-text
  `Not Found`. A bring-your-own door receives it as `DoorInput.app.errorPages.notFound`
  (`_not_found.html`), so `cf.errorPages` wires it too. The precedence is the same
  on every door: the app's `errorPages.notFound`, then the framework's
  `errorPages[404]`, then the default. The stacked door's edge and
  `cf.errorPages` now serve an error page at its own key (the default
  `_not_found.html`, or a framework page under any name) instead of always
  pointing at `404.html` / `500.html`. An SPA keeps its `index.html` fallback, a
  site with a server keeps its own 404, and the `'none'` door keeps its S3
  website error document.

  Every door now makes the same decision from the manifest:
  - only an explicit `staticAssets.spaFallback: true` is an SPA, as in routing,
    so a custom adapter's manifest that leaves it unset gets the default page
    rather than S3's 403 (the built-in adapters always set it);
  - an image optimizer doesn't count as a server, so a static site with one
    still gets the default page on CloudFront too;
  - the build's cutover waits for the default page's upload, so a miss never
    reaches a new build before its 404 page does.

  The CloudFront door no longer maps 403 twice for a static site that ships a
  500 page but no 404 page. `cf.origin` now lets CloudFront list the assets
  bucket (scoped to the door's distribution, as on the built-in doors), so a
  missing file is a 404 and a bring-your-own door's `cf.errorPages` can serve
  the page. The CloudFront template of an app built by a built-in adapter is
  otherwise unchanged.

  The docs now match the doors' behavior:
  - the ALB door's own alarms are on unless `monitoring: { enabled: false }`;
  - only a CloudFront-backed door takes over the API's address under
    `apiFrontDoor: 'cloudfront'`;
  - the ALB packs listener rules within five condition values and six wildcards
    per rule;
  - which servers behind the ALB and API Gateway doors are given `Host` as
    `x-forwarded-host`, and which receive the client's value.

- 6a53068: Security headers (and the CSP) now cover the API and auth CloudFront
  behaviours, not just the static site. Before, a `ResponseHeadersPolicy` was
  attached only to the static root; requests through `/aws-blocks/api`,
  `/aws-blocks/api/*`, `/aws-blocks/auth/*` and the raw-route proxies went out
  with no security headers at all, so the two surfaces where it matters most —
  auth and API — were the ones left uncovered (issue #765).

  Both front-door paths are fixed:

  - **Hosting-claimed path:** the behaviours added in `addApiBehaviors` now reuse
    the distribution's existing `securityHeadersPolicy` — the same policy already
    on the static behaviours — so there is one policy per distribution and no
    drift. To reach it, `CdnConstruct` and `HostingConstruct` now expose the
    policy as a public `securityHeadersPolicy` field.
  - **Standalone managed front door** (`api-front-door.ts`): has no Hosting
    construct to borrow from, so it attaches the AWS-managed
    `ResponseHeadersPolicy.SECURITY_HEADERS` to its default behaviour. The managed
    policy creates no CloudFormation resource and consumes no account
    `ResponseHeadersPolicy` quota (capped at 20 per account by default), so a
    cloudfront-tier app near that cap can't fail a deploy, and it matches what the
    Hosting-fronted path ships by default. It carries HSTS, X-Content-Type-Options,
    X-Frame-Options, X-XSS-Protection and Referrer-Policy — no CSP, since the API
    subtree serves JSON and redirects rather than documents.

  This is a `minor` bump for `@aws-blocks/hosting` because it adds public API
  (`CdnConstruct.securityHeadersPolicy` and `HostingConstruct.securityHeadersPolicy`)
  and a `patch` for `@aws-blocks/core` because it only changes behaviour (no new
  public surface). Existing apps gain the headers automatically on their next
  synth. On the Hosting-fronted path the API/auth behaviours reuse the policy
  already on the static site, so there is no new option to set and no behaviour
  change beyond the added response headers. On the standalone managed front door
  the behaviour attaches the AWS-managed `SECURITY_HEADERS` policy — no new
  CloudFormation resource and no quota impact.

- db15b5e: fix(core): make the API Gateway 29s integration default explicit and warn on an undeliverable alarm topic

  Two right-sizing fixes to the production defaults a deployed Blocks app ships with.

  - **API Gateway integration timeout is set explicitly to 29s.** `LambdaIntegration` already defaults to 29s, so this is no runtime change — it writes the boundary into the synthesized template (an explicit `TimeoutInMillis: 29000` on each Lambda method) so it is visible at review and aligned with the handler's own 28s deadline guard (`APIGW_TIMEOUT_MS`), which already emits a structured 504 just before the cut-off. A request still in flight at 29s is cut off by API Gateway regardless of how long the Lambda may run; the shared handler's function timeout (up to 900s) is the async-work ceiling and is unreachable on the synchronous HTTP path. The `bb-lambda-compute` `memory`/`maxTimeoutSeconds` docs now explain that the generous defaults are sized for the shared async path and how to right-size an API-only compute.
  - **Hosting monitoring warns at synth when an alarm topic has no subscriber.** When monitoring is enabled and an alarm topic ends up with no subscriber, it can enter ALARM but deliver to no one. A shared validation now emits a loud synth warning, applied to both the regional alarm topic and the off-region us-east-1 support-stack topic that carries the CloudFront 5xx alarm, so each topic is judged on its own alarms and subscribers. The check is deferred to synth so it accounts for subscriptions added after construction — a direct `topic.addSubscription`, or a `LambdaSubscription`/`SqsSubscription` whose subscription resource lands in another stack — and it stays quiet when no alarm is wired or when every alarm already routes to a delivery action other than the topic. The message names the `acknowledgeWarning` escape hatch for callers who accept the gap knowingly.

- 48c35f6: fix(core): two more names an API method map can't be called by

  On top of the RPC dispatch guard: a property the method map hides with `Object.defineProperty` (non-enumerable), and any method of a Building Block instance that an API handler returns instead of a method object, now return the same `-32601` "Method not found" error as an unknown name.

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

- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).
- 48c35f6: Vendorized apps using `DistributedTable` with an index, `Database` with migrations, or `DistributedDatabase` now synthesize. A vendorized copy (`npm run vendorize -- <Block>`) contains only the TypeScript sources, so these blocks' deploy-time Lambdas (the GSI manager and the migration runner) previously failed synth with `Cannot find asset` or `Cannot find entry file`. Their handlers are now bundled from the vendorized source at synth, so your edits to them deploy too. Installed (non-vendorized) apps are unchanged: their Lambda assets are byte-for-byte the same.

  The helpers that do this, `deployTimeLambdaCode()` and `deployTimeLambdaEntry()`, are framework-internal (`@aws-blocks/core/cdk/internal`), for Building Blocks in this repository that ship a pre-bundled or compiled Lambda handler; they are not on the public `@aws-blocks/core/cdk` or `@aws-blocks/blocks/cdk` entry.

- Updated dependencies [88747f5]
- Updated dependencies [d366907]
- Updated dependencies [27c35e5]
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
- Updated dependencies [db15b5e]
- Updated dependencies [48c35f6]
- Updated dependencies [c0f6a83]
  - @aws-blocks/hosting@0.5.0
  - @aws-blocks/pipeline@0.2.4

## 0.7.0

### Minor Changes

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

- b8649dc: feat(core): report the BB user-agent chain as the Postgres `application_name`

  The two pg-based Building Blocks now report the block's user-agent chain as the
  Postgres `application_name` (`aws-blocks/<core> bb/Database/<version>`), so the
  origin of a connection is visible to the server — in `pg_stat_activity` where
  the server exposes it, and in provider dashboards. `bb-data` does this on its
  `connectionString` path; the RDS Data API path is HTTP and unaffected.
  `bb-distributed-data` does it on the DSQL path.

  The chain is supplied as pg's `fallback_application_name`, which libpq
  documents for a library setting a default name "but allow it to be overridden by
  the user" — so an `application_name` already set in the caller's connection
  string, or their `PGAPPNAME`, is used instead and never replaced.

  `Scope.formatUserAgentString()` renders the chain for any string-typed sink and
  applies the two Postgres constraints on `application_name` itself: it keeps the
  value within the 63-**byte** `NAMEDATALEN - 1` limit by dropping whole parent
  entries from inside the chain rather than letting the server clip mid-token
  (omitting the value outright if it will not fit as whole entries), and it emits
  only printable ASCII, which is all Postgres preserves. Only official BB names
  enter the chain, so a custom block's name is never exposed.

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

- da6d4c7: Scope shared Blocks synth state to the owning backend root (`BlocksStack`/`BlocksBackend`) instead of the enclosing `cdk.Stack`, so two `BlocksBackend`s in one stack — and multiple stacks in one synth — stay independent.

  - **Registries** (config, compute, dashboard, tracer, VPC requirements) now key on the backend root, resolved by walking the construct tree (`getBlocksRoot`), not on `cdk.Stack.of(scope)`.
  - **Shared-infra Building Blocks** now provision and dedup their per-backend resources under the backend root: the realtime WebSocket API, the cron scheduler role, and the agent AgentCore runtime grants. Previously a second backend in the same stack could attach to the first's shared infra — most seriously, the agent's Bedrock grants could land on the wrong backend's execution role.
  - **RawRoute** registrations are tagged with their owning backend root; `Hosting` now adds CloudFront behaviors only for routes owned by the backend its distribution fronts, instead of every route in the process-global registry. The per-owner tag also scopes duplicate-route detection, so two backends may register the same method+path.
  - **`Hosting` now registers its origin config against the backend it fronts.** `BLOCKS_PUBLIC_ORIGIN` and `CORS_HOSTING_ORIGINS` are written to the backend named by `props.api`, matching the route-behavior owner — not to `this`, which (when two backends share a stack) resolved via the ambient pointer to the last-created backend and left the fronted backend without its origin config.
  - The config bucket is parented under the resolved backend root rather than read from an ambient process-global, removing a construction-order hazard.
  - **Stack-scoped exceptions — these deliberately keep a stable logical ID.** The app-setting secret bulk-init (`BlocksSecretsBulk`) and the distributed-table GSI manager provider (`BlocksGsiProvider`) stay direct stack children. Both are referenced by existing resources through immutable fields (a SecureString's physical name; a custom resource's `ServiceToken`), so a logical-ID change would force a replacement that CloudFormation either rejects (`ServiceToken` is immutable → failed upgrade) or that silently deletes the SecureString. Keeping them stack-scoped preserves the logical ID; their deploy-time IAM is still scoped (lazily) to only the parameters/tables that register. (Joins the API Gateway account resource as a documented stack-scoped exception.)

  **Compatibility.** Single-`BlocksStack` apps (the common case) are byte-identical — no resource replacement. Apps that embed a `BlocksBackend` inside a customer `cdk.Stack` and use **realtime** or **cron** will see those resources re-parent from the stack to the backend construct, which CloudFormation treats as a replacement on upgrade; neither carries persistent data. For realtime specifically, the WebSocket API URL changes and its stack output key changes from `RealtimeWsUrl` to `BlocksRealtimeWsUrl<hash>` — scripts that read that output by name must update. Secret AppSettings and GSI-backed tables are **not** affected (their shared resources stay stack-scoped).

- e9241b5: Move the backend's API Gateway REST API out of the compute and into a single stack-level shared gateway.

  `BlocksStack` / `BlocksBackend` now build one shared REST API at finalize time and integrate the default compute's function through the new `Compute.apiHandler()` contract, instead of each `LambdaCompute` creating its own gateway. This is the seam multi-compute routing builds on: one gateway can front every compute in the app. The gateway is built in the default compute's construct scope with the same construct ids as before, so a deployed app's REST API, stage, and `execute-api` URL are unchanged on upgrade. `BlocksStack.gateway` / `apiUrl` (and `BlocksBackend`'s) keep their types and values, but are now available only once `create()` resolves: the gateway is built after the backend module is imported, so reading them during that import (including in the backend module's default export) throws a "not fully initialized" error. Throttling and access logging behave as before.

  `LambdaCompute` no longer exposes `apiGateway` / `apiUrl` (the package is internal and not customer-facing); read them from the stack's `gateway` / `apiUrl`.

- 122c49c: fix(telemetry): honor opt-out when `--telemetry-file` is set

  The flag let an opted-out run build an event, which persisted the installation ID to `~/.blocks/telemetry/installation-id` and printed the first-run notice, and in `@aws-blocks/core` also persisted a project ID into `<project>/.blocks/config.json`. Consent is now checked before the event is built, and in `@aws-blocks/create-blocks-app` again before it is emitted, so an opt-out landing mid-command is honored too. A disabled run writes no identifiers, prints no notice, writes no file and sends no HTTP. `--telemetry-file` now also ignores a whitespace-only path in the space-separated form, matching the `=` form.

  Behavior change (0.x minor = breaking channel): to capture events without sending them, use `BLOCKS_TELEMETRY_ENDPOINT=http://127.0.0.1:1 <cmd> --telemetry-file=<path>` rather than combining the flag with `AWS_BLOCKS_DISABLE_TELEMETRY`. The detached send worker still runs and fails fast against port 1. That run is consented, so it still writes the installation ID and prints the notice.

### Patch Changes

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

- e682ba7: `LambdaCompute` now reports `bbName`/`bbVersion` to `Scope`, so it appears in telemetry like every other Building Block.

  `LambdaCompute` passed no `bbName` to `Scope`, and `Scope` records a block in its registry only when `bbName` is set, so `Scope.getRegisteredBlocks()` could never name the default compute and `product.buildingBlocks` omitted it. The package already carried the standard `prebuild` (`generate-version.mjs LambdaCompute`), which generates the `BB_NAME`/`BB_VERSION` its constructor now passes through — the same wiring the other blocks use.

  `LambdaCompute` has no customer-facing export, so it is deliberately absent from the umbrella's `aws-blocks.vendorize` map that `scripts/generate-bb-names.mjs` reads. The generator now also emits a `NON_VENDORIZED_BB_NAMES` list, adding it to `OFFICIAL_BB_NAMES` so it is reported as an official block rather than filtered as an unnamed custom one. `@aws-blocks/core` is bumped because that generated file changes; the `cdk` entry point is left alone, as telemetry is reported by the runtime class, not the synth-time construct.

  The default compute is built only at CDK synth, in a child process whose registry no telemetry path reads, so nothing constructs one where telemetry is emitted. Importing `@aws-blocks/blocks` through its default (Node) entry now declares it instead: `Scope._setDefaultBlockForTelemetry` records its name and version, and `getRegisteredBlocks()` folds that in only when telemetry actually reads the registry.

  Declaring rather than constructing keeps the import inert — a process that imports the umbrella and emits no telemetry leaves `totalCount` untouched — and the entry is appended after the blocks the app constructed, so it never displaces them in `product.buildingBlocks`. An app-constructed `LambdaCompute` takes precedence over the declaration, so it is never counted twice. `getRegisteredBlocks()` still exposes only names already on the official list, and customer-chosen block names remain counted-but-unnamed.

- e7e96e6: The AWS credential check before `npm run deploy` and `npm run sandbox` now finds the Region in your AWS profile and in `cdk.json`. Before, the check used only `AWS_REGION` and `AWS_DEFAULT_REGION`, and it did not run when the Region was set only in a profile. The secret upload to SSM now uses the same Region.
- 9ebda66: Emit the AWS Blocks version and deployment mode in CloudFormation template metadata under `AWSToolsMetrics.AWSBlocks`.
- 78f4396: CORS guidance now points at the stack's `defaults.allowedOrigins` everywhere, the stack-level setting every Blocks compute picks up. The runtime warning for a disallowed origin says to add it to `defaults.allowedOrigins` instead of setting the `CORS_ALLOWED_ORIGINS` environment variable; the core README's production example configures `defaults.allowedOrigins` instead of calling `handler.addEnvironment`, credits the sandbox preset (not the CLI) for the localhost pattern, and explains where allowed origins come from (`defaults.allowedOrigins` and, with `Hosting`, the distribution's own domain); the umbrella security checklist follows suit.
- 440ecce: When the AWS credential check before `npm run deploy` and `npm run sandbox` fails, the message now names the profile and the command that fixes its credentials. A profile without credentials gets sign-up and `aws login` guidance, with an AWS CLI install or update hint when the installed CLI does not have `aws login`. Expired `aws login` and IAM Identity Center (SSO) sessions get `aws login` or `aws sso login` for that profile. Rejected access keys, `credential_process`, web identity, a role assumed with environment keys, and environment credentials get guidance for that source. Rejected or expired credentials from outside the AWS config files, such as an instance role, get a hint to check that source instead of sign-up guidance. When AWS cannot be reached, including the SSO portal, the deploy still continues, and the warning now says that AWS could not be reached. The deploy docs and the generated app's `AGENTS.md` describe this behavior.

  `@aws-blocks/core` now requires AWS SDK for JavaScript clients 3.936.0 or later, the first version that reads credentials from `aws login` profiles.

- 1a5c18e: Production `destroy` now retries a failed teardown with backoff, emptying each
  stack's versioned S3 buckets before each retry — the same resilient path the
  sandbox destroy already uses. A single-shot `cdk destroy` previously surfaced a
  transient teardown failure (a non-empty versioned bucket whose autoDeleteObjects
  Lambda never provisioned, or an API Gateway control-plane throttle) as a hard
  failure with no recovery.

  Tradeoff: a destroy that fails for a non-transient reason now takes the full
  backoff (60s then 120s) to surface the real error instead of failing on the
  first attempt. This matches the sandbox path; `retryDelays` is injectable if a
  faster failure signal is ever wanted for a specific caller.

- 60616b1: Reuse HTTP connections from the local dev server to the frontend server, avoiding excessive socket creation during repeated page loads. Release the connection pool when the dev server shuts down.
- a50fb46: test(core): give the generate-spec-cli fixture a package.json so tsx resolves its relative import

  The fixture wrote its entry point into `os.tmpdir()`, which has no `package.json` anywhere up-tree, and tsx resolves a relative `./api.js` only when one exists. The TypeScript case therefore failed with "Cannot find module .../api.js" on a clean checkout. The fixture now writes `{ type: 'module' }` alongside the `tsconfig.json` it already wrote. Test-only; the shipped CLI is unchanged.

- 8a1a4a9: test: cover npm's `ci/<vendor>` user-agent token in the shared `isCI()` case table

  Test-only change: `isCI()` reads `ci-info` and four extra environment variables; it does not look at `npm_config_user_agent`, so an npm user agent carrying a `ci/<vendor>` token is not CI on its own. Nothing pinned that: re-adding a user-agent check left the 30-case table fully green. The table now has a case for the token and one for a `ci/` substring inside another token, so a reintroduced check fails in both `@aws-blocks/core` and `create-blocks-app`, which share the table. The table is excluded from the published package, so no runtime or public API change.

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

- 2da2fd4: Sanitize RawRoute uncaught exceptions so raw driver/SDK details no longer leak.

  A RawRoute whose handler throws an uncaught exception previously forwarded that error's raw name and message to the client, the same leak class the RPC path was already fixed for. The RawRoute catch (both the deployed `lambda-handler` and the local `dev-server` paths) now runs the caught throw through core's shared sanitizer: a Building Block or `ApiError` keeps its BB-authored name and message, and everything else — a driver/SDK exception or a bare `Error` — collapses to a generic `500` / `"Internal error"`, with the full error still logged server-side. A handler's own deliberate `ctx.response` writes are untouched; only the uncaught-exception path is sanitized.

  Two small behavior notes: a RawRoute uncaught exception that previously forwarded its raw name/message now returns a generic 500, and an `ApiError` built with the default name no longer emits `name: "ApiError"` on the wire (status is detected via `isApiErrorLike`, not a name compare).

- 32a4b73: Report `AuthOIDC` as the parent block of its session store, and assert the rendered chain on the wire.

  `AuthOIDC` built its session store with the scope it was given rather than itself, so the store's requests reported only `bb/KVStore` and no owning block. It cannot pass `this`: the store becomes the engine's session store, and the engine is an argument to `super()`. It now passes a parent carrying the block's own name, version and fully-qualified ID, built by the new `buildingBlockParent` helper, and the store's own ID is shortened to `sessions` so the session table name is unchanged.

  `core` adds two exports: `computeScopeFullId`, the rule `Scope.fullId` already applies, and `buildingBlockParent`, which wraps it for a block that must construct a child before `super()` has run. Both replace a copy of that rule inside `bb-auth-oidc`. The Cognito env var prefix moves into the package's shared `utils.ts` alongside the cookie-secret name, so the CDK writer and the runtime reader derive both names from one function.

  Two names change, in local and other non-Lambda `aws-runtime` runs only, where `BLOCKS_STACK_NAME` is unset and the app's root is a `Scope`. In that case the old helper walked one scope too far and produced a leading-dash ID, so the cookie-secret and Cognito env var names it looked up were not the ones the CDK side wrote, and session cookies were named `oidc_-my-app-auth`. Both now resolve. A deployed Lambda always has `BLOCKS_STACK_NAME` set and is unaffected. Under the default condition, which is what a scaffolded app's dev server resolves, the cookie prefix also changes to `oidc_my-app-auth`, from `oidc_my-app_auth` under a plain root and `oidc__my-app_auth` under a `Scope` root, because the dev entry now names cookies with the same expression as the AWS runtime instead of its own. Existing sessions in those two setups are signed out once.

  Nothing covered the chain inside the rendered header, so a change that stopped it reaching the wire would still have passed. `bb-kv-store`'s request-capture helper now takes a parent scope, and `bb-auth-oidc` gains a suite that runs under `--conditions=aws-runtime`, where the session store is the real AWS client, and asserts the captured `user-agent` header carries both blocks root-to-leaf. The CDK suite pins the literal env var names the synth side writes, which nothing checked before, and `core` gains tests for the new helper covering attribution, the official-name gate, and the derived ID.

- e3e5e22: fix(core): RPC dispatch only reaches API surfaces — never an exported Building Block instance or an inherited `Object.prototype` member

  The Lambda handler and the local dev server resolved `backend[apiNamespace][method]`
  straight off the backend module. Two consequences:

  - An exported **Building Block instance** (`export const todos = new DistributedTable(...)`)
    exposed its whole data plane (`todos.put` / `todos.delete` / `todos.query`) as an
    unauthenticated RPC surface, bypassing every `requireAuth` in the `ApiNamespace` layer.
  - The method-existence check walked the prototype chain, so `toString`, `constructor`,
    `hasOwnProperty` and friends passed it.

  Both dispatchers now share one guard: the namespace must be an own, non-`_`-private
  export that is not a Building Block (`Scope`) instance, and the method must be a
  callable that does not come from `Object.prototype`. These are exactly the exports
  `generate-client` already refuses to proxy, so no generated client is affected;
  `ApiNamespace` exports and plain exported functions/objects keep working.

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

- Updated dependencies [8b5ef4a]
- Updated dependencies [382dac6]
- Updated dependencies [c6d9e49]
- Updated dependencies [7c19c4f]
  - @aws-blocks/hosting@0.4.1

## 0.6.0

### Minor Changes

- 5501cb6: Fix off-region CloudFront 5xx alarm and rework alarm subscription wiring (#481).

  **Breaking change** (a minor bump pre-1.0):

  - The `monitoring.snsTopicArn` prop is **removed**. Attach notifications
    with the new `monitoring.subscriptions` list instead: `EmailSubscription`
    and `UrlSubscription` from `aws-cdk-lib/aws-sns-subscriptions` (endpoint
    subscriptions only, for now). Each subscription is applied to **both**
    hosting alarm topics, so you subscribe in one place and every alarm is
    covered regardless of region.
  - The `hosting.monitoringTopic` attribute is **removed**, replaced by
    `hosting.monitoring` = `{ alarms, alarmTopics }` (all alarms and all
    alarm topics across both regions).

  `AWS/CloudFront` metrics publish only in us-east-1 and a CloudWatch alarm
  cannot watch a metric cross-region, so off-region the CloudFront 5xx alarm
  never fired (it sat at `OK` under `treatMissingData: NOT_BREACHING`).
  Off-region deployments now **always** place the CloudFront alarm in a
  synthesized `<stackName>-CfMonitoring-<addr>` us-east-1 stack with its own
  encrypted SNS topic; `monitoring.subscriptions` are applied to that topic
  too. Off-region placement is always on; the only escape is when it is
  genuinely impossible. When the region resolves but the account is
  unresolved (a single-synth multi-account pipeline), the us-east-1 support
  stack cannot be built, so the CloudFront alarm is skipped with a loud synth
  warning and all other alarms are kept, rather than throwing. Set
  `env: { account, region }` to enable CloudFront coverage.

  Migration: replace `monitoring: { snsTopicArn }` with
  `monitoring: { subscriptions: [new subs.EmailSubscription('oncall@example.com')] }`
  (or a `UrlSubscription`). Two escape paths cover what `subscriptions` no
  longer does directly:

  - **Route alarms to an existing/central SNS topic:**
    `hosting.monitoring.alarms.forEach(a => a.addAlarmAction(new cw_actions.SnsAction(myTopic)))`.
  - **Resource-target (Lambda/SQS) subscriptions:** still valid on the
    regional topic via `hosting.monitoring.alarmTopics[].addSubscription(...)`.
    Only the automatic cross-region fan-out to the us-east-1 CloudFront topic
    drops them (that would need an unresolvable cross-region reference).

  See `docs/DECISIONS.md` D-016 for the always-on and warn-and-skip rationale.

  `@aws-blocks/core` surfaces `monitoring.subscriptions` and the
  `monitoring` attribute in place of `monitoringTopic`.

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

- a649895: Emit a machine-readable completion signal on a successful `npm run deploy` **and** `npm run sandbox`.

  `deploy()` now prints one stable last line — `BLOCKS_DEPLOYED url=<frontend> api=<backend>` (a backend-only app omits `url=`) — so a caller (a coding agent, a CI step, a script) can detect "deploy finished + where it lives" by grepping one line instead of parsing streamed CloudFormation output or polling the stack for the URL. `sandbox()` prints the same line on its success path (backend-only — `BLOCKS_DEPLOYED api=<backend>`, since the sandbox serves the frontend locally), so a programmatic caller greps the identical token after either command. The existing human-readable `✅ Deployment complete!` / `📡 API URL` / `🌐 Frontend URL` lines are unchanged; the signal is additive. The formatting is extracted into a pure `formatDeploySignal()` helper with unit coverage, shared by both entry points. The scaffolded `AGENTS.md` documents the line so agents grep it rather than poll.

  For `npm run deploy` specifically (which streams a real CloudFormation deploy), the heartbeat now also names the resource currently converging — e.g. `waiting on HostingDistribution (AWS::CloudFront::Distribution)` — and surfaces a rolling-back resource as a warning rather than silently clearing it, and the frontend URL is surfaced early (on the in-progress path) so a deploy killed at a caller timeout has still reported where the app lives.

- 5515483: fix(hosting): fail-closed SSR cache key + per-credential cache-key options

  Ensures cacheable SSR responses on compute deployments are keyed per credential, and adds the controls to include credentials in the SSR cache key.

  **BREAKING:** existing configs that set `cdn.ssrDefaultTtl > 0` now fail synth (`SsrCacheKeyCredentialsRequiredError`) until they include a credential in the SSR cache key. Enabling `ssrDefaultTtl > 0` makes SSR responses without an explicit `Cache-Control` header cacheable and shared at the CloudFront edge, keyed only on the Next.js router headers — not on `Authorization` or session cookies (CloudFront ignores `Vary`).

  Migration — pick one:
  - Add `cacheKeyCookies: ['<your session cookie>']` and/or `cacheKeyHeaders: ['authorization']` so cached responses are keyed per credential; or
  - Remove `ssrDefaultTtl` (and ensure personalized routes emit `Cache-Control: private`).

  - **Fail-closed guard on `cdn.ssrDefaultTtl`.** Synth throws unless `cacheKeyCookies` and/or `cacheKeyHeaders` is set, so credentials are in the cache key before per-credential responses can be cached. An unresolved-token TTL is treated as `> 0` (fail closed).
  - **New `cdn.cacheKeyCookies` and `cdn.cacheKeyHeaders` options.** Add your session cookie name(s) and/or credential-bearing header(s) (e.g. `'authorization'`) to the SSR cache key so authenticated responses are cached per credential. `'accept-encoding'` is rejected (handled by the brotli/gzip flags), and at most 8 caller cookies are allowed (CloudFront's 10-cookie cap, 2 reserved for Next.js preview mode). The cookie/header caps are resolved via `QuotaBudget` (`quotas.cacheKeyCookies` / `quotas.cacheKeyHeaders`) so a granted quota increase raises them.
  - **Shared-route cache key on compute deploys.** Compute deploys route every request through a single default cache behavior, so `cacheKeyCookies`/`cacheKeyHeaders` would key all routes per credential. The edge router now strips the configured cookies and `authorization` on static and image routes so shared assets keep a shared cache key, while SSR/compute routes stay keyed per credential.
  - **Cache-key JSDoc** on `ssrDefaultTtl`, `cacheKeyCookies`, and `cacheKeyHeaders` documenting how credentials enter the cache key and safe usage.
  - **`@aws-blocks/core`:** `Hosting` exposes `ssrDefaultTtl`, `cacheKeyCookies`, and `cacheKeyHeaders` as top-level props and forwards them to the CDN cache-key config.

  Note: any route that sets cookies via `Set-Cookie`, or otherwise varies per user without opting into the cache key, must emit `Cache-Control: private` so its response is not cached as a single shared entry at the edge.

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
  throw new Error("Todo not found");

  // after — status, message, and name all reach the client
  throw new ApiError("Todo not found", 404, { name: "TodoNotFoundException" });
  ```

  Building Block errors (`isBlocksError` / `blocksError`) are unaffected — their name and message continue to cross the wire.

### Patch Changes

- b58f248: fix(core): allow the client user-agent header on both CORS preflights

  The Lambda preflight allowed only `Content-Type, Authorization`, and the dev server
  only `Content-Type`. Neither is CORS-safelisted, so a browser that sets
  `x-blocks-user-agent`, or a bearer token, preflights the call, and the failing
  preflight **blocked the whole request** rather than just dropping the header. Both of
  core's preflight responders now allow the same three, derived from
  `CLIENT_USER_AGENT_HEADER`, which moves to `constants.ts` so neither repeats the
  literal. That also fixes bearer auth in local dev, which failed the preflight while
  working deployed. Origin matching and `Access-Control-Allow-Credentials` are
  unchanged.

- d4b32f2: Add `README.md` and `DESIGN.md` to `@aws-blocks/create-block` and ship them in the published package (`files`), matching the first-party package convention.

  Tidy two `extract-ts-types` test nits (test/comment only, no runtime change): replace a redundant re-assert with a direct check of the documented lingering-bare-key behavior, and link the array/tuple & nested-destructuring boundary to its tracking issue (#552).

- 27646ac: Tighten dev server singleton and retry handling for port contention follow-ups.
- 9e02b82: fix(core): spec extraction attributes array/tuple & nested-destructured factory namespaces

  `extractMethodTypes` (the generate-spec type extractor) attributed a
  factory-returned `ApiNamespace` to its namespace only for a top-level identifier
  or a shallow object binding pattern. Array/tuple patterns (`const [ns] = factory()`)
  and nested destructuring (`const { a: { b } } = factory()`) fell through to the
  bare method key — fail-soft via the #498 fallback when there was no collision, but
  a factory returning a tuple of namespaces that share a method name (e.g.
  `const [a, b] = factory()` where both expose `create`) could hit the #445
  cross-assignment class again.

  The second-pass indirect resolver now walks binding patterns recursively (object,
  array/tuple, and any nesting), attributing every leaf identifier to the namespace
  it binds via the checker's resolved type — so those shapes key qualified
  (`ns.method`) like a directly-constructed namespace. Follow-up to #522 (#552).

- 465a002: fix(telemetry): use ci-info for CI detection so Taskcluster (`TASK_ID` + `RUN_ID`), Netlify, Vercel, and 40+ other CI providers are identified; also keep the previously checked `CODEBUILD_BUILD_ID`, `JENKINS_URL`, `BITBUCKET_BUILD_NUMBER` and `TASKCLUSTER_ROOT_URL` variables, and honor `CI=false`
- Updated dependencies [773cef2]
- Updated dependencies [5501cb6]
- Updated dependencies [6b7fe4c]
- Updated dependencies [5515483]
- Updated dependencies [dae7a86]
- Updated dependencies [7b7a59f]
  - @aws-blocks/hosting@0.4.0
  - @aws-blocks/pipeline@0.2.3

## 0.5.0

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

- 6496713: Simplify VPC implementation: replace `registerVpcEndpoint` (instanceof-based) with two explicit methods (`registerVpcGatewayEndpoint` / `registerVpcInterfaceEndpoint`), simplify `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`, and strip persistent test VPC to bare minimum.

### Patch Changes

- 2806ae2: Ensure the hosting route cutover waits for the resolved client configuration deployment.
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

- 012cd89: Document the JSON-RPC error code mapping used by the ApiNamespace wire protocol.
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

- Updated dependencies [2806ae2]
- Updated dependencies [5eee114]
  - @aws-blocks/hosting@0.3.1
  - @aws-blocks/pipeline@0.2.2

## 0.4.0

### Minor Changes

- df667c5: feat(core): expose `backendModulePath`

  `BlocksStack` / `BlocksBackend` now expose `backendModulePath` (the app's `backendCDKPath`) so
  Building Blocks that co-bundle the app backend at synth time can discover it via
  `globalThis.CURRENT_BLOCKS_STACK.backendModulePath`. Used to co-bundle the backend + the agent
  `serve()` harness into the AgentCore Runtime's code asset.

  The shared execution role (`BlocksRole`) stays BB-agnostic: it is created with a
  `CompositePrincipal` so a Building Block whose compute runs **as** the shared role can add its own
  trust principal from its own CDK construct (e.g. the Agent BB adds `bedrock-agentcore`), rather than
  core trusting a specific compute by default.

- df667c5: feat(core): expose `getConfigLocation()` so co-located compute can load the app config

  `getConfigLocation(scope)` ensures the shared config bucket exists (created once per stack, memoized on
  the config registry) and returns `{ bucketName, key }`. `finalizeConfigRegistry` now uses it for the
  handler's `BLOCKS_CONFIG_BUCKET`/`BLOCKS_CONFIG_KEY` + `s3:GetObject` grant (handler behavior unchanged).
  A Building Block whose compute runs **as** the shared execution role but outside the Lambda handler
  (e.g. the Agent BB's AgentCore Runtime) can now inject the same two vars at construction so its
  `loadConfigToProcessEnv()` loads the identical app config — otherwise it would run with empty config and
  any config-backed BB a tool touches would fail. IAM is unchanged: the config-read grant is on the shared
  role, which such compute inherits.

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

### Patch Changes

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

- df667c5: fix(core): retry handler initialization on failure instead of caching the rejection

  `createLambdaHandler` memoized its init promise and, if `initialize()` threw — most often
  because `loadConfigToProcessEnv()` couldn't read `blocks-config.json` during the brief
  post-deploy window before it's readable — cached that **rejected** promise for the container's
  entire lifetime. Every subsequent request then re-awaited the same rejection and returned a 500,
  so a _transient_ config blip became a _permanent_ handler outage for that container (visible as a
  whole stack of API calls returning `undefined`, only "recovering" as Lambda cycled in fresh
  containers).

  A failed `initialize()` now resets the promise so the next invocation retries. Combined with the
  config loader no longer caching a not-found result (a 404 is treated as transient rather than
  poisoning the cache with `{}`), the handler **self-heals** as soon as config becomes readable.
  This is most likely to surface on large/slow deploys (which widen the post-deploy window), but the
  fragility was general.

  **Behavior change:** a failed handler init is now **retried per request** instead of cached. A
  transient config blip self-heals (the win), but a _genuinely_ broken deploy (bad IAM, wrong bucket,
  malformed config) now re-runs `initialize()` — an S3 GET + backend import — on **every** invocation
  until it recovers or the container cycles, rather than failing fast. Expect added per-request latency
  and repeated S3/CloudWatch activity under a broken deploy; revisit any alarms that assumed a fast,
  sticky init failure.

- 646614b: feat(core): record each API namespace on its resolved compute (internal)

  `ApiNamespace` now records its name on the namespace's resolved compute
  (`compute.namespaces`) so later request routing can map a namespace to the
  compute that hosts it. This is a CDK-synth-only internal side effect — in the
  mock/runtime bundles there is no compute and it is a silent no-op.

  The public `ApiNamespace(scope, name, handler)` signature is unchanged and the
  returned handler is byte-identical. On the default single-compute app every
  namespace is recorded on the stack's default compute. No `{ compute }` overload
  is added here (that is the later customer-facing surface).

- 46b7c89: Generate the local `aws-blocks` package's client entry point on fresh checkouts, under the correct export conditions.

  The templates declare `./client.js` as the package's `browser`/`import` entry and gitignore it as generated, so a scaffold built on any machine other than the one that scaffolded it failed to resolve the package, and `cdk synth` failed with it (the Hosting block builds the frontend during synthesis).

  `@aws-blocks/blocks` gains a `blocks-generate-client` bin (mirroring `blocks-generate-spec` and `blocks-vendorize`) that spawns the core generator worker with `--conditions=aws-runtime`, so the emitted client imports `aws-middleware` rather than `mock-middleware` regardless of how the hook is invoked. `@aws-blocks/core` exports the existing `generate-client-worker` subpath so the bin can resolve it. The templates wire `"prebuild": "blocks-generate-client"` (including `backend`, where the hook is dormant until a `build` script exists) and gitignore `.hosting/`, the Vite output written during synthesis.

- 1da58fd: `destroySandbox` (used by `npm run destroy` and per-job E2E teardown): empty versioned S3 buckets before retrying `cdk destroy`. Teardown relies on each bucket's `autoDeleteObjects` Lambda, which never provisions if the CREATE failed, so a versioned bucket blocked the delete and the stack (and its IAM roles) leaked. On a destroy failure the buckets owned by the app's stacks are now emptied (all object versions + delete markers, paginated) before the retry, alongside the existing VPC-ENI backoff.
- Updated dependencies [f2f186c]
- Updated dependencies [1da58fd]
- Updated dependencies [4b74c7f]
- Updated dependencies [5960fa4]
  - @aws-blocks/hosting@0.3.0
  - @aws-blocks/pipeline@0.2.1

## 0.3.0

### Minor Changes

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

- f00adb0: feat(core): add `allowedOrigins` to `BlocksDefaults`

  `BlocksDefaults` gains an `allowedOrigins` field — CORS origin patterns (matched
  against the request `Origin` header) the compute's API accepts. `LambdaCompute`
  now reads `this.defaults.allowedOrigins` to populate `CORS_ALLOWED_ORIGINS`
  (comma-joined, as the runtime parses it) instead of reading the `sandboxMode`
  CDK context. The `sandbox` preset allows localhost (so a local dev frontend can
  reach a deployed API); `production` allows none.

  **Breaking (direct `BlocksDefaults` literal authors only):** `allowedOrigins` is
  required. Building the object from `BlocksPresets.sandbox` / `BlocksPresets.production`
  (or a spread of one) is unaffected — the presets supply it. Only a hand-written
  `BlocksDefaults` literal must add the field.

- 08ab129: Add `pointInTimeRecovery: boolean | { retentionDays: number }` to `BlocksDefaults` (and to `BlocksPresets`: `true` in `production`, `false` in `sandbox`).

  This extends the stack-wide infrastructure-defaults posture with the continuous-backup knob, so a Building Block whose service supports it (DynamoDB Point-in-Time Recovery) can resolve its default from `scope.defaults.pointInTimeRecovery` — read independently, the same way as `removalPolicy` and `deletionProtection`. `true` enables backups with the service default window, `false` disables them, and `{ retentionDays: n }` pins the window (the block validates `n` against its service's range) — on/off and window are one field since a window only means anything when backups are on. Blocks whose service has no equivalent simply ignore it. `bb-distributed-table` is the first consumer.

  > The property **name** (`pointInTimeRecovery`) and its `{ retentionDays }` shape are a public `@aws-blocks/core/cdk` surface addition and want API-BR sign-off before release.

- 9d4ccea: Add `secret()` / `config()` support to hosting and pipeline for self-hosted deployments — externalized values that are never hardcoded in source, committed to git, or written into the CloudFormation template.

  **Two intent functions; the store is implied by which you call.**

  - **`secret('KEY')` → AWS Secrets Manager** — for sensitive values (API keys, tokens, credentials).
  - **`config('KEY')` → SSM Parameter Store** (free tier) — for non-sensitive externalized values (feature flags, a custom domain, a connection ARN).

  The developer never selects a store; it is derived from the function (`storeForKind`), so the CLI write, the IAM grant, the synth-time fetch, and the runtime read can never disagree.

  **Runtime read — two getters, one per store.** `getSecret('KEY')` reads Secrets Manager; `getConfig('KEY')` reads SSM. Each reads its own injected locator env var (`HOSTING_SECRET_PARAM_<KEY>` vs `HOSTING_CONFIG_PARAM_<KEY>`), so the store is unambiguous. Both read `process.env.KEY` first, so **local dev needs no AWS** (put the value in a `.env` file). Values are fetched + decrypted on first use, cached (per-kind `cacheTtlSeconds` for rotation without a cold start; otherwise cached for the process lifetime), and never enter the template. The getters live on the **CDK-free `@aws-blocks/hosting` entry** — the value API (`secret`/`config`/`getSecret`/`getConfig`) is the package's `.`, and its module graph pulls in no CDK, no `fast-glob`, and no `node:fs`, so importing it into an SSR/runtime bundle (including the edge runtime) is safe. Build-time tooling lives off `.` so it never enters a runtime bundle: the CDK construct + resolution engine on `@aws-blocks/hosting/constructs`, and the CLI + typegen engines on `@aws-blocks/hosting/scripts`. (`@aws-blocks/core` already exports a backend `getConfig`, so import the hosting getters from `@aws-blocks/hosting`.)

  **CDK wiring.** In `Hosting` `environment` (and `domain`) a `secret()`/`config()` marker injects only the store _locator_ and grants the compute role least-privilege read (`secretsmanager:GetSecretValue` / `ssm:GetParameter`, scoped to the exact ARN) + `kms:Decrypt` (conditioned on `kms:ViaService`). When a `stage` is set the grant covers BOTH the stage locator `<prefix>/<stage>/<key>` and the shared fallback `<prefix>/<key>` (the fallback read is what lets a stage fall back to a shared value), so treat the shared entry as readable by every stage sharing that prefix. A **synth-time** position — `domain.domainName` — accepts only `config()` (or a plain string), never `secret()`: the value is resolved via an SDK read and **inlined as a literal into the template** (a domain must be a literal before CloudFront/ACM), so a secret there would defeat its own purpose; a domain is public anyway. Synth resolution is async, so use `await Hosting.create(...)`. (Runtime `environment` markers still accept both `secret()` and `config()` — those inject only the locator and never inline.) Per-kind namespace/cache config is set via the separate `secretStore` / `configStore` props (`{ prefix, stage, cacheTtlSeconds }`), defaulting to the neutral `/hosting/secrets` and `/hosting/config` prefixes.

  **Namespacing (avoid cross-app collisions).** A **Blocks** app is scoped automatically: the `Hosting` / `Pipeline` blocks and the `npm run secret` / `config` CLIs default to `/blocks/<stackId>/secrets` and `/blocks/<stackId>/config`, where `stackId` is the app's stable id from the committed `.blocks/config.json`. Both the CLI and the CDK synth read that same file, so two Blocks apps in one account/region never collide, and the write and the read can never diverge (when the file is absent — e.g. a bare test — both sides fall back to the unscoped `/blocks/*` identically). `stackId` is stage-independent (prod and sandbox share it; use the opt-in `stage` segment for per-stage values). A **standalone** hosting/pipeline app (the framework-neutral leaf) has no `.blocks/config.json`, so its defaults (`/hosting/secrets`, `/hosting/config`) stay account-global — give each app its own `secretStore.prefix` / `configStore.prefix` (and matching CLI `--prefix`) when more than one deploys to an account. Use `--region` (or `AWS_REGION`) to write the value in the same region the app deploys to.

  **Bring-your-own (BYO).** `environment` (hosting) and `buildSecrets` (pipeline) also accept an existing CDK `ISecret` / `IParameter` handle alongside the managed markers: the construct grants read via the handle and injects its locator, so `getSecret`/`getConfig` resolve it identically — managed _provisions_, BYO _references_.

  **Pipeline.** `source.connectionArn` accepts a `config()` marker (resolved to a literal at synth; a connection ARN is a reference inlined into the template, so `secret()` is a type error there — same rule as `domain`). `buildSecrets` accepts `secret()` markers or BYO `ISecret` handles and wires them as CodeBuild `SECRETS_MANAGER` env vars fetched at build time (masked in logs, never inlined) — build-time credentials are secrets, so this surface is Secrets-Manager-only. Namespace config via `secretStore` / `configStore`.

  **CLI.** `secret set|list|remove` (Secrets Manager) and `config set|list|remove` (SSM), sharing one engine (`setValue`/`listValues`/`removeValue`/`runValueCli`). Blocks apps get `npm run secret` / `npm run config` (scoped per app to `/blocks/<stackId>/secrets` and `/blocks/<stackId>/config`); standalone/pipeline apps get the `hosting-secret` and `hosting-config` bins. A **secret** value is never read from argv/shell history — `secret set` takes it from a hidden prompt or `--value-stdin` (a positional value is a hard error); a non-sensitive **config** value may be passed positionally. `list` prints names only, never values. All commands accept `--prefix`, `--stage`, and `--region` (write to the same region the app deploys to).

  **Type-safe reads (zero code) — `getSecret` / `getConfig` autocomplete + typo errors.** The runtime getters are typed against two augmentable registries (`HostingSecretRegistry` / `HostingConfigRegistry`): empty by default they accept any `string` (unchanged, non-breaking), and once populated they narrow to your declared keys — editor autocomplete, and a typo (or reading a `config` key via `getSecret`, i.e. the wrong store) becomes a compile error. You populate them with **no code change** via the new `hosting-typegen` CLI (`npm run typegen`, `--watch` to regenerate on save, `--check` for CI): it statically scans your `secret('...')` / `config('...')` calls (TypeScript compiler API — no app execution, no AWS credentials) and generates a `.d.ts` (`.blocks/hosting-values.d.ts`) that augments the `@aws-blocks/hosting` entry (where the getters live), narrowing them to your declared keys. The generated file is derived from your `secret()`/`config()` calls, and `--check` fails CI when it's stale. Add `.blocks/**/*.d.ts` to your tsconfig `include`. In a Blocks app this is automatic: the dev server (`npm run dev`) auto-detects `secret()`/`config()` usage and runs the generate-and-watch step itself (a no-op when the app declares no secrets, and non-fatal), so keys update as you type with no second command; standalone hosting apps use `hosting-typegen --watch`.

  **Typed, parsed values via a schema.** `secret('KEY', { schema })` / `config('KEY', { schema })` accept any Standard Schema (Zod, Valibot, ArkType — typed as `StandardSchemaV1`, library-neutral). `typegen` builds a TypeScript `Program`, infers the schema's output type, and inlines it into the generated `.d.ts`, so **`getSecret`/`getConfig` return the inferred type** (e.g. `const { beta } = await getConfig('FEATURE_FLAGS')`) instead of `string` — no `JSON.parse(...)` and no `any`. At runtime the value is JSON-parsed (a per-key flag is injected at synth); the schema itself isn't shipped to the runtime, so this is parse-to-type, not a deep re-validation across the bundle boundary.

  **Templates.** `@aws-blocks/create-blocks-app` templates scaffold a `secret` script (`npm run secret`) wired to the Blocks CLI, and a `typegen` script (`npm run typegen` → `runTypegenCli` from `@aws-blocks/blocks/scripts`) with `.blocks/**/*.d.ts` added to the tsconfig `include`, so a newly-created app can manage secrets and get type-safe `getSecret`/`getConfig` out of the box.

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

- 5bfae0a: Reject oversized JSON-RPC request bodies at the shared parser. `parseRpcRequest` now caps the body at 10 MiB (`MAX_RPC_BODY_BYTES`, the same limit API Gateway enforces in production) and returns a `413` error named `PayloadTooLarge` before parsing or dispatch. In production API Gateway rejects an oversized body at the edge before the Lambda runs; enforcing the same limit at the parser means the local dev server rejects the same body instead of buffering it and wedging the local database (e.g. PGlite). Because both the Lambda handler and the dev server route through this one parser, the cap lives in a single place, and `decodeRpcResponse` surfaces it client-side as `ApiError.status === 413`.
- 0ac3879: `sandbox` / `deploy`: fail fast with an actionable message when AWS credentials are missing or expired.

  Both commands previously spent ~10 seconds synthesizing the CDK app before the first AWS call, so an unconfigured or expired credential surfaced only afterwards — as an opaque CDK/CloudFormation error that didn't name the real cause. `startSandbox` and `deploy` now run a bounded STS `GetCallerIdentity` check up front and, on a real credential error (missing/expired/invalid), exit immediately with guidance (`aws configure` / `aws sso login`, `AWS_PROFILE`, or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) instead of wasting the synth.

  The check is deliberately conservative: it only blocks on a genuine credential error (surfacing the SDK error _name_, never the raw message, which can embed an ARN/account id); a network or service error warns and lets the deploy proceed; and it skips (with a warning) when no region is set in `AWS_REGION` / `AWS_DEFAULT_REGION`, rather than guessing a region in the wrong partition (GovCloud/China). The scaffolded `sandbox` template entrypoint now `.catch`es and exits cleanly, matching `deploy`, so the guidance prints without an unhandled-rejection stack trace.

- e4dac4a: Speed up sandbox deploys with CloudFormation **Express Mode**: `npm run sandbox` now runs `cdk deploy --method direct --express`. Express Mode reports each stack operation complete as soon as the resource's configuration is applied, without waiting for full stabilization — a substantial speedup for the sandbox iteration loop.

  This is sandbox-only. The production deploy (`npm run deploy`) is unchanged — it keeps a reviewable CloudFormation change set and full stabilization with automatic rollback. Express Mode disables automatic rollback by default; we keep that default for the throwaway sandbox loop rather than forcing `--rollback`, so a failed sandbox deploy may leave the stack in a failed state until the next deploy.

  Observability trade-off: `--method direct` also drops some of the CDK CLI's per-resource progress output (it has no change set to report against), and Express Mode itself returns before resources finish stabilizing. Expect less granular deploy progress for sandbox deploys than the production path emits. Because the deploy returns before stabilization, a resource that is still propagating (e.g. a CloudFront distribution) may not be fully ready on the very first request right after `npm run sandbox` returns; this is an accepted trade for sandbox iteration speed.

  Requires an `aws-cdk` CLI new enough to expose `--express`. The CLI dev-dependency floor is bumped to `^2.1138.0`, a version that has the flag (it is not necessarily the version that introduced it).

  The sandbox deploy argv is built by the pure, unit-tested `buildSandboxDeployArgs` helper (mirroring the existing `buildCdkDeployArgs` for production).

- Updated dependencies [9d4ccea]
- Updated dependencies [947a1bd]
  - @aws-blocks/hosting@0.2.0
  - @aws-blocks/pipeline@0.2.0

## 0.2.0

### Minor Changes

- 7b4c62d: Add infrastructure `defaults` chosen once at the app entry point, replacing the per-block `sandboxMode` logic and the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin dance for removal-policy and deletion-protection.

  `@aws-blocks/core/cdk` now exports `BlocksDefaults` and the `BlocksPresets.sandbox` / `BlocksPresets.production` starting points. `BlocksStack.create` / `BlocksBackend.create` take a required `defaults` prop; start from a preset and override individual fields with a spread. `defaults` is anchored on the owning `BlocksStack`/`BlocksBackend` (resolved by walking up the construct tree, like `handler`/`executionRole`), so multiple backends in one stack each keep their own posture. Building Blocks read the resolved values via `scope.defaults`, and a per-block option always wins (`option ?? scope.defaults.field`).

  Adopted across the stateful Building Blocks: `bb-kv-store`, `bb-data`, `bb-distributed-data`, `bb-distributed-table`, and `bb-knowledge-base` now take their removal policy and deletion protection from `defaults` instead of reading the `sandboxMode` context themselves. (`bb-distributed-table` reads `defaults` directly for now; a richer per-block `protection` override lands with #282.)

  The `create-blocks-app` scaffolding templates are updated to pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production` (replacing the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin), so newly-generated apps satisfy the required prop.

  **Breaking:** `BlocksStack.create` / `BlocksBackend.create` now require a `defaults` field — pass `BlocksPresets.sandbox` or `BlocksPresets.production` (typically `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`). The previously-shipped experimental `hardening` prop and its `resolve*` helpers are removed; log-retention, API throttling, access-logging and point-in-time-recovery move into `defaults` in follow-up, per-feature changes.

### Patch Changes

- 5262062: feat(core): add the internal `Compute` abstraction

  Introduce the abstract `Compute` base behind a new internal entry point
  (`@aws-blocks/core/cdk/internal`). A compute resolves its owning
  `BlocksStack`/`BlocksBackend` on construction to derive its runtime identity
  (backend entry + stack name). It is framework/test-only — not part of the public
  API, and customers cannot instantiate a compute yet. Concrete computes live in
  their own packages (e.g. `@aws-blocks/bb-lambda-compute`).

- 3614a09: Stop `import.meta.url` from crashing the deployed Lambda. The backend handler is bundled to CommonJS, where `import.meta` is empty, so `fileURLToPath(import.meta.url)` in a handler, a Building Block's `aws-runtime` code, or a dependency became `fileURLToPath(undefined)` and threw at Lambda load (every request 502'd). esbuild only warned, so the broken bundle deployed. The handler bundling now shims `import.meta.url` / `import.meta.dirname` / `import.meta.filename` to their CommonJS equivalents (`pathToFileURL(__filename)`, `__dirname`, `__filename`) — the approach esbuild blesses and Rollup applies by default — so the bundle loads cleanly and a dependency that merely contains `import.meta` no longer trips a build failure. Exposes `blocksNodejsBundling()` from `@aws-blocks/core/cdk` (re-exported by `@aws-blocks/blocks`) so every framework `NodejsFunction` gets the same treatment. Note: inside the bundle these resolve to the bundled output location, not your source tree.
- 5262062: feat: extract `LambdaCompute` into `@aws-blocks/bb-lambda-compute`

  The abstract `Compute` base stays in core as a framework primitive; the concrete
  `LambdaCompute` (a `NodejsFunction` fronted by its own API Gateway, assuming the
  shared execution role) moves into a new package, `@aws-blocks/bb-lambda-compute`.

  The package is CDK-only and its sole export is internal — customers cannot
  instantiate a compute yet. Nothing in the default path constructs it, so this is
  additive and non-breaking.

- 5071079: fix(core): make `SandboxDisableDeletionProtection` actually disable DynamoDB deletion protection

  The mixin duck-typed only on the `deletionProtection` property name, but the
  DynamoDB L1 `CfnTable` behind an L2 `Table` spells it
  `deletionProtectionEnabled` — and the L2 `Table` never re-exposes the prop. As a
  result the mixin silently never matched DynamoDB tables: sandbox stacks synthed
  `DeletionProtectionEnabled: true` and `sandbox:destroy` failed on every
  protected table, because DynamoDB refuses `DeleteTable` while protection is on
  regardless of the CloudFormation `DeletionPolicy`.

  The mixin now matches both the `deletionProtection` and
  `deletionProtectionEnabled` spellings, so DynamoDB tables are cleared through
  their L1 and consumers no longer need a local `CfnTable` workaround loop.
  Behavior for other resource types is unchanged: only explicitly-enabled
  protection is flipped, so unprotected resources still omit the property (Aurora
  DB instances continue to synth without `DeletionProtection`).

- 8966cfb: fix(telemetry): detect Render and Taskcluster as CI

  Telemetry CI detection (`isCI()`) checked a fixed list of CI env vars but
  omitted Render and Taskcluster. Render sets `RENDER=true` on every build and
  service; Taskcluster tasks always set the namespaced `TASKCLUSTER_ROOT_URL`.
  Runs on those platforms were therefore reported as real user sessions instead
  of `ci:true`, inflating user metrics. `RENDER` and `TASKCLUSTER_ROOT_URL` are
  now included in both `isCI()` implementations (`@aws-blocks/core` and
  `@aws-blocks/create-blocks-app`). The umbrella `@aws-blocks/blocks` gets a patch
  bump because it re-exports `@aws-blocks/core`.

- b11a75b: Reject primitive and null JSON-RPC params with the standard Invalid Params error.
- Updated dependencies [940956e]
- Updated dependencies [4981137]
- Updated dependencies [5c58c53]
  - @aws-blocks/hosting@0.1.9

## 0.1.18

### Patch Changes

- cb779c8: feat(core): add a shared Blocks execution role and `Scope.executionRole` getter

  The Blocks stack/backend now provisions one explicit IAM role (with
  `AWSLambdaBasicExecutionRole` attached) that the handler assumes, and exposes it
  as `executionRole`. A new `Scope.executionRole` getter resolves the role from
  any Building Block. Additive and non-breaking: the same handler is created, now
  backed by an explicit role instead of an auto-generated one, with block grants
  sitting on the role's default policy exactly as before.

  Migration note: on an existing deployed stack, upgrading replaces the Lambda
  execution role — CloudFormation deletes the old auto-generated role and creates
  the new `BlocksRole`. This is runtime-equivalent (the same grants re-attach to
  the new role) and needs no action, but a change-set diff will show a role
  delete+create rather than a no-op.

## 0.1.17

### Patch Changes

- b48aaec: Route the 504 timeout response's CORS headers through the allowlist-validated `buildCorsHeaders` helper instead of reflecting the request `Origin` (with a `'*'` fallback) alongside `Access-Control-Allow-Credentials: true`. Disallowed origins now get no CORS grant on timeout. Also lowers `Access-Control-Max-Age` from `86400` to `7200` on OPTIONS preflights and in the dev server, since browsers cap preflight caching well below 86400.

  Adds `Vary: Origin` to every CORS response (Lambda and dev server) so shared caches key on the request origin and can't serve one origin's `Access-Control-Allow-Origin` grant to another. The `7200` value is now the single exported `CORS_MAX_AGE` constant, and the disallowed-origin warning logs once per distinct origin instead of once per request.

- ac0966a: docs: correct default local dev port to :3000/aws-blocks/api
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

- 8e96d87: Return a JSON usage hint instead of an empty body when a dev-server request doesn't match `POST /aws-blocks/api`. Opening the endpoint in a browser (a GET) or hitting a REST-style URL previously returned a bare 404 with no body; it now responds with `{ error, expected: { method: 'POST', path: '/aws-blocks/api' } }`, and says so explicitly when the path was right but the method was wrong.
- 58f77dd: Document four things people were reverse-engineering from compiled output.

  - **Runtime config resolution.** The client config is served at the dotted path `/.blocks-sandbox/config.json`; `/config.json` is not a route, so a 404 there means nothing. `{"_placeholder":true}` in the frontend build output is the Hosting construct's synth-time stub (the real `apiUrl` is still an unresolved CloudFormation token), so it is expected pre-deploy rather than a broken config. Covers the resolution order, what each environment should actually return, and what a genuine failure looks like.
  - **`RawRoute`.** Full section in the core README: constructor signature, a `GET` example that sets status, `Content-Type` and body, what you can read off `ctx.request` and write to `ctx.response`, path/parameter/wildcard syntax, and the registration rules (reserved paths, duplicate routes, register-during-load). Also added a "serve a raw HTTP endpoint" entry to the block catalog decision tree, which had no pointer to it.
  - **Server-initiated OIDC sign-in.** New section in the `bb-auth-oidc` README for `GET /aws-blocks/auth/signin/<provider>`: the redirect chain through the IdP and the callback, the pending-auth and session cookies, the JSON error shape, a runnable `curl` walkthrough, when to use it instead of the client PKCE API, and a pointer to the integration tests that assert each response. One route is mounted per configured provider, so an undeclared provider name 404s instead of reporting `ProviderNotConfiguredException`, which comes from `getSignInUrl()`.
  - **Error and RPC semantics.** `ApiError`'s constructor arguments (including `cause` staying server-side and `retriable`), how its `status` becomes the JSON-RPC error code and decodes back into an `ApiError` on the client, `hasAuthError`'s signature and when it applies instead of `isBlocksError`, how `params` is read as positional args vs a named object, that a top-level JSON array body (a batch) is rejected with `-32600`, and that `broadcastAuthChange` comes from `@aws-blocks/blocks/ui` rather than the package root.

  Docs only, plus tests locking in the documented `ApiError`, `params` and batch-rejection behaviour, and the documented `404`s on the OIDC sign-in and sign-out routes.

- 2d3dfdc: Remove the redundant `--hotswap` flag from the `cdk watch` invocation in `npm run sandbox`. `cdk watch` already performs hotswap deployments by default, so passing the flag explicitly was redundant and emitted a duplicate-option warning on some `aws-cdk` CLI versions.
- Updated dependencies [0284e5b]
  - @aws-blocks/hosting@0.1.8

## 0.1.16

### Patch Changes

- b09e568: Add a SvelteKit framework adapter. SvelteKit apps are now auto-detected (via
  `@sveltejs/kit`) and deployed through `@sveltejs/adapter-node` running on Lambda
  behind the Lambda Web Adapter (the existing `http-server` compute path), fronted
  by CloudFront + S3. Supports SSR pages, `+server.js` endpoints, form actions,
  server `load`, `hooks.server`, streaming, prerendered/SSG pages (served frozen
  from S3), custom headers, cookies, redirects, `error()`, and `paths.base`. A
  transparent build bridge wires `@sveltejs/adapter-node` when the app hasn't
  configured it, so no manual setup is required. Patch (not minor) per the
  pre-1.0 caret convention — the change is additive and backward-compatible.
- Updated dependencies [b09e568]
  - @aws-blocks/hosting@0.1.7

## 0.1.15

### Patch Changes

- 1f1287e: Never serve a stale placeholder `config.json` after a deploy. The build-time placeholder (`{"_placeholder":true}`) was uploaded with the 1-year mutable cache-control (`public, s-maxage=31536000, max-age=0, must-revalidate`), and the post-deploy CloudFront invalidation targeted `/.blocks-sandbox/*` — which never matches the real cache key, because the skew-protection viewer-request function rewrites the URI to `/builds/<buildId>/.blocks-sandbox/config.json` before the cache lookup. An edge that cached the placeholder during the deploy window could keep serving it for up to a year, making `getApiUrl()` throw and every client API call fail. The placeholder is now registered as a no-cache path (`no-cache, no-store, must-revalidate`) so edges never cache it long-term, and the config deployment now also invalidates the post-rewrite key `/builds/<buildId>/.blocks-sandbox/*`.

## 0.1.14

### Patch Changes

- fc33428: fix(telemetry): inherit worker stderr in debug mode; enable telemetry in CI for create-blocks-app

  - When `NODE_DEBUG=blocks-telemetry` is set, the telemetry worker subprocess
    inherits the parent's stderr so delivery confirmation is observable. Silent
    by default.
  - Remove CI telemetry suppression from create-blocks-app to match core behavior.
    Telemetry is now enabled in CI (same as all other CLI commands).
  - Make `console` cross-platform and headless-safe: pick the OS browser opener
    (`open`/`xdg-open`/`start`), resolve the region from the environment, and treat
    a missing opener (CI / remote shells) as best-effort success instead of failing.
  - Add an isolated E2E telemetry test suite (`test-apps/telemetry`) that verifies
    payload structure, delivery to the real endpoint, disable mechanisms, and
    per-command success/failure events.

## 0.1.13

### Patch Changes

- a7427d4: Prevent verbose local RPC logging from turning successful void handlers into error responses.

## 0.1.12

### Patch Changes

- 71eb746: Fix eleven reproducible hosting issues:

  - **Astro SSR `/_image` content-type**: the SSR bundle now ships a linux-x64 `sharp` (installed post-build into `dist/server/node_modules`, wasm fallback pruned, ~19.5 MB), so Astro's default `sharp` image service works on Lambda and `/_image` returns a real optimized image with a correct MIME (`image/png`/`image/webp`) instead of the `noop` passthrough's `content-type: image/null`. Gated on the app using the sharp service; apps that pick `noop`/custom are skipped. A dedicated image Lambda isn't feasible for Astro (it fuses `/_image` into the SSR bundle via the `astro:assets` virtual module, unlike Nuxt IPX / OpenNext).

  - **Next image optimizer on Next 15.x**: the `fetchInternalImage` arity patch was gated on an inverted version assumption (the `maximumResponseBody` parameter was added in Next 16, not 15.5). It now only applies on Next ≥ 16, so local image optimization no longer 500s on Next 15.x apps. Renamed `patchImageOptimizerForNext155` → `patchImageOptimizerForNext16`.
  - **Image optimizer on disallowed types (SVG)**: an untrusted SVG (with `dangerouslyAllowSVG` disabled) now fails closed with its real `400` status instead of a blanket `500` — OpenNext was catching Next's 400 in a generic block that discarded the status.
  - **SPA hashed assets**: the SPA adapter now marks Vite's content-hashed `assets/*` bundles `immutable` (`immutablePaths: ['assets/*']`) instead of leaving them in the revalidation-only cache tier.
  - **Missing static assets**: the OAC bucket policy now grants `s3:ListBucket` so a missing key returns a clean `404 NoSuchKey` instead of leaking `403 AccessDenied` XML to the viewer.
  - **RSC prefetch cache efficiency**: the SSR cache policy excludes Next's random `_rsc` prefetch query param from the cache key (`denyList('_rsc')`), so prefetches of the same page share one edge cache entry.
  - **Wildcard redirects**: Next `:path*` named-catch-all redirects are now lifted to the edge router (converted to `/*`), with a bare-prefix companion redirect, so they no longer leak the literal `:path*` token in `Location`.
  - **Route-table budget**: `TooManyRoutesError` now names which table (routes/redirects/headers) exceeded the budget and calls out `trailingSlash: true` as the likely driver, and the previously-hardcoded 64-chunk cap is now tunable via the `quotas.maxRouteChunks` hosting prop (default 64) for very large sites with measured edge-function headroom.
  - **Nuxt ISR/SWR on-demand pages**: when ISR/SWR is active (`manifest.cache` set), route coalescing now folds a prerendered static sibling group into a single `parent/*` **compute** wildcard (instead of a static one), so a non-prebuilt on-demand child renders at the SSR Lambda instead of hard-404ing from S3 — while the route table stays bounded (one row per parent), avoiding the CloudFront-Function compute-limit 503 a non-coalesced fan-out would cause.
  - **CloudFront S3-origin policy**: every behavior whose origin is S3 — the default behavior AND the edge-route (`runtime: 'edge'`) behavior — now uses a synthesized custom origin request policy instead of the managed `ALL_VIEWER_EXCEPT_HOST_HEADER`, which CloudFront rejects on S3 origins (`InvalidRequest` at distribution create). The sentinel behaviors keep the managed policy (their origins are the tagged server/image custom origins, not S3). A regression guard asserts no S3-origin behavior references a managed origin request policy.
  - **Nuxt IPX remote images**: the IPX image Lambda now rides the shared SSR API Gateway (via a dedicated `<baseURL>/{proxy+}` resource) instead of an OAC Function URL, so an unencoded `://` in a remote source path no longer breaks SigV4 (was `403 InvalidSignatureException`); and the IPX runtime is configured with `httpStorage` scoped to the allowlisted domains so allowlisted remote images resolve instead of `404 IPX_RESOURCE_NOT_FOUND`.

- Updated dependencies [71eb746]
- Updated dependencies [71eb746]
  - @aws-blocks/hosting@0.1.5

## 0.1.11

### Patch Changes

- 76e1e50: fix(core): robust dev server — startup port reclaim, singleton guard, and :3000 EADDRINUSE handling

  Hardens the local dev server against the port-contention failure modes that
  survived PR #80 (which fixed only single-supervisor frontend self-restart):

  - **Startup reclaim** — a fresh `server.ts` now frees a stale `:3000`/`:3100`
    listener left by a crashed or `SIGKILL`'d predecessor before it binds the
    front door / spawns the `--strictPort` frontend, instead of relying on the
    previous process's `cleanup()` finishing within tsx-watch's ~5s window.
  - **Singleton guard** — a per-port pidfile stops a second `npm run dev` from
    spawning a competing supervisor that fights the first over `:3000`/`:3100`; it
    exits cleanly with a clear message. A stable-parent (`tsx watch`) carve-out
    keeps hot reload working, and a dead-owner pidfile never blocks startup.
  - **`:3000` EADDRINUSE robustness** — the backend front door now emits a real
    console error (not only telemetry), reclaims the stale owner and retries the
    bind (bounded), and exits non-zero with a clear message on unrecoverable
    failure, so a contended `:3000` never silently fails to serve.

  Reuses the existing `waitForPortFree` / process-group-kill primitives (plus an
  `lsof`/`netstat` listener probe mirroring the `cleanup` script) — no new
  teardown mechanism. `--strictPort` is retained for local dev, made safe by the
  startup reclaim guaranteeing `:3100` is free first.

## 0.1.10

### Patch Changes

- e839301: fix: stack-scope the external-DB connection-string SSM parameter to prevent multi-app collision

  The external-database connection string was stored in an SSM parameter named only
  by stage (`/blocks/{stage}/db-connection-string`), so two Blocks apps deployed to
  the same AWS account + region + stage computed the same name and silently
  overwrote each other's credentials.

  The parameter name is now stack-scoped (`/<stackName>-db-url`), derived from a
  single new `getStackName({ sandbox, projectRoot })` helper that is also the one
  place the CDK templates compute the stack name (replacing logic duplicated across
  templates). The same `dbConnectionParameterName(stackName)` — fed the stack name
  from `getStackName({ sandbox, projectRoot })` — is used
  by the pre-deploy writer (`ensureSecrets`) and by the `db pull` generated wiring at
  synth, so the written name and the read name are derived once, from committed
  config (`.blocks/config.json`) — never from the connection string — and cannot
  diverge. The name is computable before synth (enabled by the committed stackId from
  PR #51), so no post-deploy write-back or staging-copy machinery is needed.

  The previous stage-only parameter is orphaned and self-heals on the next deploy.

## 0.1.9

### Patch Changes

- 9075b81: Fix four hosting correctness bugs:

  - **Base path is now a first-class `Hosting` prop, and Nuxt `app.baseURL` is modelled.** Added a caller-declared `basePath` option to `Hosting` (e.g. `{ basePath: '/app' }`) — the recommended, framework-agnostic source of truth that CloudFront behaviors are prefixed with (plus a root→`/<basePath>/` 308 redirect). When the prop is omitted, the Nitro adapter now detects Nuxt's `app.baseURL` from the build output and sets `manifest.basePath` (parity with Next `basePath` / Astro `base`); previously it was silently dropped, so a Nuxt app with a base path deployed broken — pages rendered but their hashed `/<base>/_nuxt/*` assets 404'd (no hydration). If a base path is detected in the prerendered output but can't be read, synth fails loud instead of shipping a broken site.
  - **Per-pattern header rules delegate to the SSR runtime instead of competing for CloudFront behavior slots.** For SSR (compute) deploys, a header rule whose pattern has no dedicated behavior is no longer wired as its own CloudFront behavior — the request falls through to the catch-all SSR Lambda, which already emits the framework's `headers()` / `routeRules` at runtime (CloudFront caches the response including those headers). This removes redundant behaviors that burned the scarce ~25-behavior budget and re-asserted a header the origin already sets, and it means SSR header rules can never trip the behavior cap. For **static-only** deploys (S3 origin, no runtime to emit the header) the cap still applies: a rule that would exceed it throws if it sets a security header (CSP, HSTS, X-Frame-Options, … — a lost CSP otherwise looks like a successful deploy) and is dropped with a warning if it's cosmetic.
  - **config.json deploy ordering is now wired correctly.** The resolved `config.json` deployment now depends on the asset deployments so the build's placeholder config can't clobber it. The previous `tryFindChild('AssetDeployment')` never matched the real child ids and the dependency was silently never created.
  - **AWS service quotas are now centrally accounted, configurable, and degrade gracefully.** A new `QuotaBudget` module centralizes the previously-scattered, hardcoded limits (CloudFront cache behaviors, Lambda@Edge associations, and the account-wide response-headers-policy quota — the last of which was previously unguarded and blew up opaquely at deploy time). Three things change:
    - **Configurable:** a new `quotas` prop on `Hosting` (`{ cacheBehaviors?, edgeFunctions?, headerPolicies? }`) lets accounts that have been granted a Service Quota increase raise the corresponding ceiling, instead of hitting a hardcoded throw at the AWS default. Each field documents that synth cannot verify the real granted quota, so an over-set value just moves the failure to deploy time.
    - **Graceful degradation (SSR):** when prerendered pages would exceed the behavior budget on a compute deploy, the lowest-priority pages are demoted to the SSR runtime (served by the catch-all Lambda) instead of failing the build — deterministically, and never touching hashed-asset prefixes, edge routes, image-opt, or non-default compute origins.
    - **Grouping (static-only):** when co-located sibling pages would exceed the budget on a static deploy (no runtime to demote to), they collapse into one `<parent>/*` behavior — lossless, since every path under the parent resolves from S3 either way.
    - **Deploy-fail guards for hard limits:** the static-asset upload Lambda (CDK's `BucketDeployment`) is now sized to 1024 MB / 1024 MiB `/tmp` (up from CDK's 128 MB / 512 MiB defaults, which large sites silently overran with an opaque CloudFormation failure), overridable via `storage.deployment`. Synth also now emits a warning as a stack approaches CloudFormation's hard 500-resource-per-stack limit, so the operator can split the stack before a deploy fails opaquely.

- Updated dependencies [9075b81]
  - @aws-blocks/hosting@0.1.4

## 0.1.8

### Patch Changes

- e9dc073: fix(telemetry): send events via detached subprocess to prevent dropped events

  Telemetry events are now sent via a detached background subprocess instead of
  an in-process https.request. This ensures events are delivered even when the
  parent CLI process exits on failure paths before the socket flushes.

## 0.1.7

### Patch Changes

- 6eb731a: fix(dev-server): auto-respawn frontend and kill the whole process group on restart

  The dev server spawns the frontend (Vite) with `shell: true`, making the real
  Vite process a **grandchild** (shell → npx → node vite). On a `tsx watch`
  restart, cleanup sent `SIGTERM` to only the shell parent, orphaning the Vite
  grandchild — it survived still bound to `:3100`. The freshly launched Vite then
  hit `--strictPort`, failed to bind, and exited; the `exit` handler only logged,
  so `/` served a permanent `502 Frontend server unavailable` with no recovery.

  Fixes:

  - **Process-group kill** — the frontend is spawned `detached` on POSIX (its own
    process group) and cleanup/restart now signal the entire group via
    `process.kill(-pid, …)`, reaping the Vite grandchild and freeing `:3100`.
    Windows (no POSIX groups) reaps the tree with `taskkill /T /F /PID <pid>`,
    which walks the child tree by PID so the Vite grandchild is killed too; it
    degrades to a direct child kill only if `taskkill` cannot be spawned.
  - **Bounded auto-respawn** — an unexpected frontend exit now respawns Vite with
    exponential backoff, capped at 5 restarts / 10s to avoid hot loops, and is
    suppressed during intentional shutdown via an `isShuttingDown` guard. The
    budget counts only _consecutive failing_ restarts: it resets only when **our
    own** freshly spawned child is the process now bound to the port. A liveness
    probe alone cannot tell our Vite from a foreign listener (a leftover Vite or a
    second dev server), and crediting a foreign one would make every
    `--strictPort`-failing respawn look successful, neutralizing the cap and
    hot-looping forever. A frontend that legitimately restarts many times (e.g.
    editor-triggered full reloads) is still never permanently left down. Before
    each relaunch the supervisor now also waits (bounded) for `:3100` to be
    released — the same port-free drain the graceful shutdown path uses — so a slow
    socket teardown can't hand the relaunched `--strictPort` Vite an `EADDRINUSE`
    and burn a restart-budget slot; that wait re-checks the `isShuttingDown` guard,
    so a shutdown arriving mid-wait still cancels the relaunch (and the budget is
    debited once, at exit time, so the wait never double-counts a restart).
  - **Robust shutdown** — cleanup is idempotent, wired to `SIGINT`/`SIGTERM`/
    `SIGHUP`, removes its own listeners, and waits (bounded) for the group to die
    **and for `:3100` to actually be released** before exiting: SIGTERM→SIGKILL
    escalation, then a port-free poll that runs on _both_ the live and the
    already-exited paths (the post-exit path previously skipped it, so a relaunch
    could race the kernel's socket teardown into `--strictPort` `EADDRINUSE`). A
    synchronous `process.on('exit')` safety net remains for paths that bypass
    cleanup — now routed through the shared tree-kill so it reaps on Windows
    (`taskkill`) too instead of early-returning and leaking the Vite tree.
  - **Consistent post-exit reaping** — the failure being fixed is the _shell
    exiting while the detached grandchild survives_, so every post-exit path
    (the respawn handler, graceful shutdown, and the `exit` safety net) now
    issues one best-effort process-group kill even after the shell has gone,
    rather than skipping it. A surviving grandchild keeps the group's id reserved
    on POSIX, so `process.kill(-pid)` still targets our own group; the kills are
    issued synchronously on observing the exit to keep the PID-reuse window
    minimal. The single rationale lives next to the supervisor as the
    "POST-EXIT GROUP-KILL POLICY" so all three sites stay in agreement.
  - **Sandbox entrypoint parity** — `sandbox.ts` (the sibling dev entrypoint) now
    spawns **both** long-running children — the dev server _and_ `cdk watch` — in
    their own process groups and `await`s a bounded group teardown for each
    (run concurrently) on `SIGINT`/`SIGTERM`, replacing the synchronous
    `cdkWatch.kill()` + single dev-server `kill()` + `process.exit(0)` that
    signalled only the npx/shell parents and exited immediately. A bare
    `cdkWatch.kill()` could orphan the real `cdk watch` node process
    (npx → cdk → node) — the same shell-only-kill leak this PR fixes for the dev
    server — so it now routes through the shared `terminateProcessTree` too. Only
    the dev-server drain (the longer 6s budget) owns the `:3100` port-free wait, via
    its own SIGTERM handler, so the next `npm run sandbox` no longer races a
    survivor on `:3100`.
  - **Single tree-kill primitive** — the POSIX group-kill, the Windows `taskkill`
    tree-kill, and the bounded SIGTERM→SIGKILL teardown now live in one shared
    `process-tree.ts` module used by every entrypoint (dev server, respawn
    handler, `exit` net, and sandbox), so the reaping behavior can no longer drift
    between hand-rolled copies. Its bounded teardown documents that its boolean
    reflects only the **direct child's** exit (not whole-group teardown or port
    release — callers needing a freed port must follow with `waitForPortFree`), and
    its post-SIGKILL grace is a named `KILL_GRACE_MS` constant kept deliberately
    shorter than the injectable SIGTERM grace (SIGKILL is uncatchable, so only a
    brief beat is needed to observe the exit).

  `--strictPort` is intentionally retained: the proxy target is hardcoded to
  `:3100`, so the port is reliably freed rather than letting Vite drift to another
  port the proxy wouldn't follow.

- a40e840: fix: bind dev server to all interfaces (0.0.0.0) for WSL2 compatibility

## 0.1.6

### Patch Changes

- f42c604: fix: generate unique stackId in .blocks/config.json, export getStackId/getSandboxId from @aws-blocks/blocks/scripts

  Stack names are now derived from a `stackId` in `.blocks/config.json`, generated at scaffold time as `<name>.slice(0,16)-<random6>`. Templates import `getStackId()` and `getSandboxId()` from `@aws-blocks/blocks/scripts` — no more inline filesystem logic in `index.cdk.ts`.

  Production: `<stackId>-prod`
  Sandbox: `<stackId>-<username(8)>-<random(6)>` (per-machine, gitignored)

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

## 0.1.5

### Patch Changes

- 162c47d: fix(hosting): stop hardcoding image-optimization Lambda reserved concurrency

  The image-optimization Lambda hardcoded `reservedConcurrency: 10`, which made `cdk deploy` fail on fresh AWS accounts (the default account-level unreserved-concurrency limit is also 10, so reserving all 10 drops the account below its required minimum and Lambda returns a 400). It now defaults to no reservation and exposes `compute.imageOptimization.reservedConcurrency` so operators with headroom can still cap it.

- Updated dependencies [162c47d]
  - @aws-blocks/hosting@0.1.3

## 0.1.4

### Patch Changes

- a306ff1: Serve `/.blocks-sandbox/config.json` from the dev server itself instead of proxying it to the framework dev server.

  The browser auth client resolves its API URL by fetching `/.blocks-sandbox/config.json`. The dev server proxied that request to the framework dev server (Next.js/Nuxt/Astro), which only serves its own static dir and returned 404 — so the client failed with "Blocks API URL not configured" in local `dev`. The dev server now answers this reserved path directly, mirroring production where CloudFront serves `/.blocks-sandbox/*` as static assets. Framework-agnostic and requires no per-app workaround.

## 0.1.3

### Patch Changes

- e98bab4: feat(pipeline): extract Pipeline construct into @aws-blocks/pipeline package, add partialBuildSpec for CodeBuild runtime control

  `@aws-blocks/core` receives a minor bump (not patch): it gains a new runtime dependency on `@aws-blocks/pipeline` and adds new public re-exports from its CDK entrypoint (`__PIPELINE_STAGE_SCOPE__`, `Pipeline`, `DeployStage`, and the pipeline configuration types). New backwards-compatible public surface is a minor change per semver.

- Updated dependencies [e98bab4]
  - @aws-blocks/pipeline@0.1.1

## 0.1.2

### Patch Changes

- 18880ff: Fix `deploy`, `sandbox`, and `destroy` failing on Windows: spawn `npm`/`npx`/`cdk` via `cross-spawn` (resolves the `.cmd` shims) and import the backend through a `file://` URL so absolute paths like `D:\...` work during CDK synth.

## 0.1.1

### Patch Changes

- 270c049: docs: scrub and port documentation from internal staging repo
- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/hosting@0.1.1

## 0.1.0

Initial version
