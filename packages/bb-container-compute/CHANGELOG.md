# @aws-blocks/bb-container-compute

## 0.3.0

### Minor Changes

- 9ebf67a: An API namespace can run on a `container` compute:

  ```ts
  const renderCompute = new Compute(scope, 'render', { type: 'container', size: { vcpu: 2, memory: 4096 } });
  export const render = new ApiNamespace(scope, 'render', (context) => ({ … }), { compute: renderCompute });
  ```

  The container's tasks serve the namespace with the same dispatch as the Lambda handler (CORS, cookies, error envelopes), so clients call it exactly as before at `/aws-blocks/api/render`.

  - The shared API gateway reaches the tasks through a VPC link to an internal Application Load Balancer that the compute provisions in the app's VPC: one load balancer and one listener per backend, with a path rule per namespace forwarding to its container's target group, health-checked on the task's readiness port. A container that only runs jobs gets no target group.
  - The tasks admit the load balancer on a security group of their own; the shared compute security group stays closed to inbound traffic.
  - The load balancer drops request headers that aren't valid HTTP before they reach a task.
  - API calls to a container keep the gateway's ~29-second cap. A stopping task finishes its in-flight requests (up to 35 s) before it shuts down.
  - A `Scope` with a container `compute` now places its `ApiNamespace`s on that container too, instead of failing synth.
  - A container that serves API namespaces needs a running task: `scaling.minInstances: 0` fails synth. Without a `scaling.strategy`, one that also runs an `AsyncJob` scales on CPU, and its queue backlog adds tasks too.
  - Moving a namespace that already serves traffic onto a container: during that deploy, its calls can get 503s for the minute or two the new tasks take to start.
  - `runContainer()` takes the backend module (`runContainer({ backend })`) and serves its API on port 8080, with readiness on port 8081; called without it, the container answers a health check on port 8080 as before. A container compute passes it only when the compute serves API traffic.
  - The container compute's dashboard section gains API request, 5xx, latency and task-health widgets.

- e5822ed: A container compute on the default image now runs as the image's unprivileged `node` user (uid/gid 1000) instead of root. It boots from `/home/node/app` and starts in `/home/node` (its working directory), both owned by that user. The API and readiness ports (8080/8081) aren't privileged, so most apps keep working unchanged. Code that relied on root no longer works on the default image: writing to `/app` (no longer created), to `/` or under `/usr/local`, or installing packages at boot. As in Lambda, write scratch files under `/tmp`; relative paths resolve under `/home/node`. A custom `image` is unaffected: it still runs as the image's own default user, in its own working directory, and boots from `/app`. If your app needs root on the stock Node image, set `image` to it explicitly.
- 3ae8592: feat(bb-container-compute): scale a container compute to zero between jobs

  A container `Compute` with `scaling: { minInstances: 0 }` now starts a task when
  a job is waiting. Before, a service at zero tasks never woke for a backlog
  smaller than `backlogPerInstance` (default 100), so its jobs were never run.

  ```ts
  const worker = new Compute(scope, "worker", {
    type: "container",
    scaling: { minInstances: 0, maxInstances: 2 },
  });
  ```

  Use `minInstances: 0` only for long-running jobs that can tolerate high latency
  before they start; most workloads should use `minInstances` of 1 or more. Waking
  usually takes a few minutes (queue metrics, the scaling alarm, and the task's
  start), and up to about 20 minutes when the job's queue has been idle for more
  than six hours. Computes with `minInstances` of 1 or more deploy the same
  autoscaling as before.

  `minInstances: 0` also requires at least one `AsyncJob` or `CronJob` on the
  compute and the default (or `queue-depth`) scaling strategy. Anything else fails
  synth: with no job nothing would ever start a task, and a `cpu` or `memory`
  strategy could scale in to zero while a job is still running.

  Instance bounds are now checked at synth: `minInstances` must be an integer of
  0 or more, `maxInstances` an integer of 1 or more, and `minInstances` must not
  exceed `maxInstances`.

### Patch Changes

- 6236bf9: Add a README describing the internal container compute, its options, local-dev and AWS behavior, and synth-time errors.
- f133ff8: On the `apiFrontDoor: 'cloudfront'` tier, CloudFront now routes an API namespace on a `container` compute straight to the container's load balancer, instead of through the shared API gateway — from the backend's managed distribution, or from `Hosting`'s default CloudFront door when it fronts the API. A call can run up to 60 seconds (CloudFront's origin read timeout) instead of the gateway's ~29, and skips a hop.

  - Each container namespace path (`/aws-blocks/api/<export name>`) gets its own CloudFront behavior, ahead of the `/aws-blocks/api/*` gateway behavior, all on one VPC origin per distribution for the backend's load balancer listener (whose path rules pick the compute) — so a distribution uses one of the account's VPC origins (25 by default) however many containers serve API traffic. Namespaces on Lambda computes, auth routes and `RawRoute`s still go through the gateway.
  - A viewer-request CloudFront Function stamps the viewer's host on those requests, so `ctx.request.url` in the container is the public URL, including a custom domain.
  - The load balancer admits CloudFront's origin-facing prefix list on its listener ports; the prefix list is looked up at deploy time, so stacks stay environment-agnostic.
  - A direct call skips the gateway's throttling and access logs; the distribution's web ACL (`apiWaf`, or Hosting's WAF) covers it, and synth warns when there is none.
  - On the `apigateway` tier nothing changes: container namespaces go through the gateway, behind `Hosting` too.
  - A container namespace whose load balancer's VPC has no public subnets (an isolated VPC; a CloudFront VPC origin needs an internet gateway) stays on the gateway, and synth warns naming it.
  - `Hosting`'s `stacked` door keeps container namespaces on the gateway, through its ALB router.
  - Synth fails with a clear message when the direct behaviors take a distribution past its cache-behavior quota (CloudFront's default of 75, or `Hosting`'s `quotas.cacheBehaviors`), naming the container namespaces.
  - The CloudFront Function also drops a client-sent `X-Forwarded-Host`, so it cannot change `ctx.request.url`.

- 76fd75c: The container compute's default image, `public.ecr.aws/docker/library/node:24-slim`, is now pinned by its multi-arch index digest, as a digest-only `node@sha256:…` reference. Every task start pulls the same image, and a re-pushed tag no longer changes what runs under the stack's execution role. A custom `image` is still used exactly as written. The `image` docs now recommend pinning custom images by digest.
- 3ae8592: fix(bb-container-compute): deploys no longer reset an autoscaled container's task count

  A container `Compute` with autoscaling no longer declares a task count in its
  CloudFormation template. Before, every deploy that changed the app's code reset
  the running task count to `minInstances`, stopping tasks that were running jobs.

  Running jobs also get longer to finish when a task is stopped by a deploy or by
  scale-in: the container now waits up to 120 seconds (the AWS Fargate maximum),
  up from 25 seconds. A job still running after that is stopped and retried.

  The `bb-compute`, `bb-async-job` and `bb-cron-job` READMEs now say that a deploy
  restarts a job still running after that window, and that the restart counts as
  one of the job's attempts.

- 2b250f8: Harden the `ecs-tasks.amazonaws.com` trust that a container compute adds to the shared execution role: it is now scoped with `aws:SourceAccount` and `aws:SourceArn` (`arn:<partition>:ecs:<region>:<account>:*`), so only ECS tasks in the stack's own account and region can assume the role. The role's Lambda trust is unchanged.
- c607deb: Behind a Blocks CloudFront front door, a Lambda handler's `ctx.request.url` is now the URL the client called: the distribution's domain, or the custom domain it was called at (`https://d111.cloudfront.net/aws-blocks/api/orders`, not `https://<id>.execute-api.<region>.amazonaws.com/aws-blocks/api/orders`). Links and redirects a handler builds from it stay on the public domain, where the app's cookies are scoped. A container namespace behind the same door already reported that URL; the two compute types now agree. `getRequestBaseUrl()` is unchanged: it stays the gateway's origin and stage, for code that must reach the gateway directly.

  - Applies to the `apiFrontDoor: 'cloudfront'` distribution and to `Hosting`'s CloudFront door (on either tier). A viewer-request CloudFront Function on their API behaviors to the gateway stamps the viewer's host as `x-blocks-public-host`; each door registers its hosts under the backend's `BLOCKS_PUBLIC_HOSTS` config.
  - A handler takes the stamped host only when it is one of the backend's front-door hosts (for a wildcard alias such as `*.example.com`, a subdomain at any depth, not the apex); any other value is ignored.
  - Requests sent to the `execute-api` URL directly, and requests through `Hosting`'s other doors (ALB, API Gateway, stacked, bring-your-own), keep reporting the gateway's host.
  - The sandbox dev server's loopback `X-Forwarded-Host` still takes precedence, so redirect-based sign-in in a sandbox keeps working through the CloudFront URL. In both the Lambda handler and the container, it now contributes only its host: a query, fragment or userinfo in it no longer reaches `ctx.request.url`, and a request path starting `//` or `/\` can't change the URL's host.
  - A container namespace the gateway proxies to behind a Blocks CloudFront door (on the `apigateway` tier, or when CloudFront can't reach its VPC) also reports the public URL now, instead of the gateway's.
  - `Auth`'s same-origin relay allowance follows: when a sign-in starts, a `relayTo` on the host the client called behind a Blocks CloudFront door counts as same-origin, where the gateway's `execute-api` host did before. When the IdP calls back, the relay re-check accepts a relay to any host the backend serves over HTTPS (each CloudFront door's hosts and the gateway's), so a sign-in that started on one of a door's hosts, or on the `execute-api` URL, still finishes when the callback arrives on another.
  - Each CloudFront door adds one CloudFront Function to the account.

- 8a5726c: test: check `defaults.permissionsBoundary` coverage for Auth, Compute, ContainerCompute, CronJob and Dashboard

  Each of these blocks now has a synth test that sets `defaults.permissionsBoundary`
  and fails if any IAM role in any synthesized template, including custom-resource
  provider roles, the CronJob scheduler role and the container task execution
  role, lacks the boundary or is missing from the `<stack>.blocks-iam.json`
  report. No runtime or synth behavior changes.

- 2095f31: fix(core): `ctx.request.url.pathname` no longer includes the API Gateway stage when deployed

  On AWS, a `RawRoute` handler's `ctx.request.url` had the API Gateway stage in front of the path (`/prod/bench/me`), while `npm run dev` gave the route path (`/bench/me`). A handler that sub-routed on `url.pathname` passed every local test and returned its own 404 for every request after deploy. Behind `Hosting`, the stage wasn't part of the browser's URL either.

  `ctx.request.url.pathname` is now the route path in every environment, on Lambda and on a container compute, which took the stage from the front door's `x-blocks-forwarded-stage` header. The origin is unchanged: on AWS it is still the host the backend received, which behind a front door is the API Gateway host. An HTTP API `$default` stage is no longer prepended either, and a request path starting with `//` no longer changes the URL's host.

  This is a `minor` bump because it changes an existing value. If you build an absolute link from `ctx.request.url.pathname` or `href` while clients call the API Gateway URL directly, add the stage yourself, or build the link from your app's configured origin. The likeliest such code resolves a relative path against the request URL: `new URL('next', ctx.request.url)` used to give `/prod/…/next` and now gives `/…/next`. Building Block authors who need the externally reachable base, stage included, can use the new `getRequestBaseUrl(ctx)` from `@aws-blocks/core/bb-utils`; every transport sets it for every request it dispatches.

  `@aws-blocks/bb-auth` now takes the stage for its fallback callback URL (the direct engine's `redirect_uri` when no public origin is configured) and its stub IdP issuer from `getRequestBaseUrl()`, so those URLs are unchanged.

  The `@aws-blocks/bb-container-compute` design notes now say that the stamped stage goes to `getRequestBaseUrl()`, not to the request path.

- 58817b0: fix(core): add aws:SourceAccount/aws:SourceArn conditions to service-principal trust policies; add synth-time check

  The IAM roles AWS Blocks creates for a backend now scope every service-principal trust to the stack's account:

  - The `KnowledgeBase` Bedrock service role adds `aws:SourceArn` matching `arn:<partition>:bedrock:<region>:<account>:knowledge-base/*` beside its existing `aws:SourceAccount` condition.
  - The waiter state machine roles of the `DistributedTable` index provider and the `Database` migration provider trust `states.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:states:<region>:<account>:stateMachine:*`.
  - The `ContainerCompute` task execution role trusts `ecs-tasks.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:ecs:<region>:<account>:*`, the same scope as its task-role trust.
  - The `Auth` SMS role (created for phone sign-in or SMS MFA) trusts `cognito-idp.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:cognito-idp:<region>:<account>:userpool/*`, beside the `sts:ExternalId` it already had.
  - The `@aws-blocks/hosting` API Gateway REST door no longer creates CDK's per-API CloudWatch role and `AWS::ApiGateway::Account` setting; its stage configures no logging.

  Synth now checks the roles AWS Blocks covers for a backend for a service-principal trust with neither an `aws:SourceAccount` nor an `aws:SourceArn` condition. That is the same set of roles `defaults.permissionsBoundary` applies to: for a `BlocksStack` the whole stack, for an embedded `BlocksBackend` its subtree and the stack-level roles created on its behalf. Lambda execution roles (`lambda.amazonaws.com`, `edgelambda.amazonaws.com`) are accepted as they are, as is the `apigateway.amazonaws.com` trust of an API Gateway CloudWatch Logs role: any role an `AWS::ApiGateway::Account` in the same stack names as its `cloudWatchRoleArn`, such as `BlocksApiGatewayCloudWatchRole` (created by `@aws-blocks/core` and `@aws-blocks/hosting` when access logging is on) or the default `cloudWatchRole` of a CDK `RestApi` the app adds. That trust stays unconditioned: API Gateway does not send `aws:SourceAccount` or `aws:SourceArn` when it delivers logs with this role, so a condition stops log delivery.

  - A role AWS Blocks creates (under an AWS Blocks Building Block or a compute, or at stack scope on a block's behalf) fails synth; the error names the role's construct path and the principal.
  - A role the app creates gets a synth warning instead, and synth succeeds: one its backend module adds (on a `BlocksStack` or an embedded `BlocksBackend`, at stack scope, under a `Scope` namespace, or inside a custom block the app writes as a `Scope` subclass), one added to a `BlocksStack` after `create()`, and one a CDK construct creates inside any of these (for example the `EventsRole` of an `events.Rule` targeting a state machine).

  Ownership follows who created the role: AWS Blocks' own blocks, computes and stack-level helpers mark the constructs they create, and every other covered role is the app's.

  To resolve the warning, add both conditions to the role's trust statement. For a role a CDK construct creates with no prop for its trust, set them with `role.node.defaultChild.addPropertyOverride('AssumeRolePolicyDocument.Statement.N.Condition', { ... })`; the warning names `N`. To keep the trust as it is, acknowledge the warning with `Annotations.of(role).acknowledgeWarning('@aws-blocks/core:serviceRoleTrustWithoutSourceCondition')`, or on the stack for every role in it. See "Service-principal trust" in the `@aws-blocks/core` README.

- Updated dependencies [5f55dac]
- Updated dependencies [2eb62fa]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [6297d5a]
- Updated dependencies [b2eb306]
- Updated dependencies [a5e754b]
- Updated dependencies [f133ff8]
- Updated dependencies [9ebf67a]
- Updated dependencies [76fd75c]
- Updated dependencies [3ae8592]
- Updated dependencies [e5822ed]
- Updated dependencies [3ae8592]
- Updated dependencies [9059918]
- Updated dependencies [5f55dac]
- Updated dependencies [c1fabce]
- Updated dependencies [b2eb306]
- Updated dependencies [0cf1aa2]
- Updated dependencies [15e65b4]
- Updated dependencies [5f55dac]
- Updated dependencies [c1fabce]
- Updated dependencies [c045273]
- Updated dependencies [369b175]
- Updated dependencies [d7f62f3]
- Updated dependencies [3be61fa]
- Updated dependencies [36888a1]
- Updated dependencies [fcf087d]
- Updated dependencies [2c9005f]
- Updated dependencies [6151940]
- Updated dependencies [b7c262c]
- Updated dependencies [ebfe2ed]
- Updated dependencies [c1fabce]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [44c7377]
- Updated dependencies [2a358ff]
- Updated dependencies [1ec956f]
- Updated dependencies [c1fabce]
- Updated dependencies [072c3ff]
- Updated dependencies [5f55dac]
- Updated dependencies [afad513]
- Updated dependencies [ba80bbd]
- Updated dependencies [05a88e1]
- Updated dependencies [f32185c]
- Updated dependencies [f32185c]
- Updated dependencies [9801a5b]
- Updated dependencies [a86bccb]
- Updated dependencies [b2eb306]
- Updated dependencies [df25d97]
- Updated dependencies [201e59e]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [60360c1]
- Updated dependencies [8ece10a]
- Updated dependencies [c607deb]
- Updated dependencies [4e92168]
- Updated dependencies [bfdd06f]
- Updated dependencies [2095f31]
- Updated dependencies [80ce128]
- Updated dependencies [d354055]
- Updated dependencies [58817b0]
- Updated dependencies [e286b16]
- Updated dependencies [c00ab16]
- Updated dependencies [58980c7]
  - @aws-blocks/core@0.9.0

## 0.2.0

### Minor Changes

- 88747f5: feat: Building Block mock entries fail closed in a deployed environment

  - **Runtime guard.** `@aws-blocks/core/bb-utils` exports `assertNotMockInDeployedEnv(bbName)`, the runtime counterpart of the `--conditions=cdk` synth check. It throws when a Building Block's mock (`default` export) entry is loaded in a deployed environment, which happens when the backend was bundled without the `aws-runtime` export condition. A deployed environment is detected from `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY`, which Blocks sets on every compute it provisions (Lambda, container, AgentCore). On compute Blocks doesn't configure, the check is inert and the `aws-runtime` bundler condition is the only protection. It is a no-op in local dev and tests.
  - **Wired into every BB mock entry.** Each Building Block's mock entry calls the guard at module load, so a mis-bundled artifact throws instead of running in-memory stubs: at process start on container and AgentCore computes, and on the first invocation on Lambda (where the backend is imported lazily, so the deploy succeeds and requests then return an error).
  - **AuthOIDC mock cookie secret.** The mock runtime's cookie-signing secret is now random per project instead of a fixed string, persisted (mode 0600) under the instance's `.bb-data/` mock data dir so local sessions survive backend reloads and dev-server restarts. Local sign-in is unchanged.
  - **Bundler conditions.** The `@aws-blocks/hosting` handler bundle and the AuthOIDC IdP-registration and DistributedTable GSI-manager Lambda bundles now pin the `aws-runtime` condition. The hosting bundle uses `['aws-runtime', 'module']` so esbuild keeps preferring packages' ESM builds.
  - **Scaffold template.** `@aws-blocks/create-block`'s primitive template calls the guard in its mock entry and depends on an `@aws-blocks/core` range that exports it.
  - **Docs.** `docs/guides/extending-with-existing-aws-resources.md` documents configuring your own bundler (esbuild, webpack) or unbundled Node (`--conditions=aws-runtime`) with the `aws-runtime` condition when deploying to a compute target Blocks doesn't own, and adds the guard call to the BB-author checklist.

  Maintainer note: these are `minor` bumps because AWS Blocks is pre-1.0, where `minor` is the channel for behavior changes — mock entries that previously ran in a deployed environment now throw.

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

### Patch Changes

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

- c0f6a83: Include the Apache-2.0 `LICENSE` file in the published package.
- Updated dependencies [0765f84]
- Updated dependencies [5572341]
- Updated dependencies [88747f5]
- Updated dependencies [1076ccc]
- Updated dependencies [928c48a]
- Updated dependencies [4d5ea86]
- Updated dependencies [90c1b12]
- Updated dependencies [50b8c94]
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
- Updated dependencies [d366907]
- Updated dependencies [91ed1fc]
- Updated dependencies [48c35f6]
- Updated dependencies [d062eeb]
- Updated dependencies [c22eeee]
- Updated dependencies [1546160]
- Updated dependencies [9c96135]
- Updated dependencies [63b154f]
- Updated dependencies [8565ef7]
- Updated dependencies [ce5dfa9]
- Updated dependencies [515089c]
- Updated dependencies [dde6340]
- Updated dependencies [7477b6e]
- Updated dependencies [d79a0bd]
- Updated dependencies [d79a0bd]
- Updated dependencies [6a53068]
- Updated dependencies [dd5e807]
- Updated dependencies [db15b5e]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [72e3259]
- Updated dependencies [d79a0bd]
- Updated dependencies [48c35f6]
- Updated dependencies [8565ef7]
- Updated dependencies [48c35f6]
- Updated dependencies [0d4ede3]
- Updated dependencies [63b154f]
- Updated dependencies [b6b8ade]
- Updated dependencies [82ea78a]
- Updated dependencies [e44ac0c]
- Updated dependencies [33e8d73]
- Updated dependencies [b003705]
- Updated dependencies [48c35f6]
  - @aws-blocks/core@0.8.0
