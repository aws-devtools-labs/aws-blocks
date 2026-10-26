# bb-container-compute — design

## Purpose

`ContainerCompute` is the internal Fargate-backed compute. Customers never
instantiate it directly — the public `Compute` block builds one for
`type: 'container'`. It runs the Blocks backend as a long-lived process and
self-starts the SQS pollers for the event handlers assigned to it.

## Provisioning

- **Task.** A Fargate task definition sized from `size` (`vcpu × 1024` CPU units,
  `memory` MB), on ARM64 (Graviton). The default image and any custom `image`
  must be arm64-compatible.
- **Task role.** The shared Blocks execution role, so every Building Block grant
  reaches the container exactly as it reaches the Lambda handler. The `ecs-tasks`
  trust principal is appended to that role once per stack. The task role is also
  granted read on the code asset (below) so the boot script can fetch it.
- **Image & code delivery (no local Docker).** The task runs a **stock public
  Node image** — `public.ecr.aws/docker/library/node:24-slim` by default, or the
  customer's `image` — **verbatim via `fromRegistry`**. Blocks builds **no**
  container image, so `cdk deploy` never needs a local Docker daemon. The app
  code is co-bundled with esbuild (a `main.js` parent + a `worker.js` per-job
  worker, same bundle as the Lambda handler path) and shipped as an **S3 asset**
  (`aws-s3-assets.Asset` — a zip upload, no Docker). A task **command override**
  (`node -e …`) inlines a dependency-free bootstrap (`bootstrap.mjs`) that, at
  every container start, reads the task-role credentials from the ECS container
  credentials endpoint, SigV4-fetches `main.js`/`worker.js` from the asset's S3
  location, writes them to `/app`, and execs `node /app/main.js`. This is the
  sanctioned ECS pattern of a generic image + an entrypoint/command override that
  pulls what it needs with the task role — see
  [container credentials](https://docs.aws.amazon.com/sdkref/latest/guide/feature-container-credentials.html)
  and the [entrypoint-override pattern](https://containersonaws.com/pattern/ecs-entrypoint-command-task-definition/).
  Because the fetch uses the task role (fresh creds at every start), reboots,
  autoscale-out, and crash-replacement all work with no deploy-time-only
  credential. A custom `image` therefore only has to supply the **runtime
  environment** (Node 24 on `PATH`, plus any system libraries the handlers need);
  it does **not** contain the app code.
- **VPC.** Fargate is VPC-resident, so the compute hooks into the framework's
  VPC context: in its constructor it reuses an app-provided VPC
  (`defaults.vpc.network`) when one is present, and only derives the shared lazy
  Blocks VPC when none was provided. Tasks are placed in the
  `private-with-egress` tier.

## API traffic

A container compute that hosts an `ApiNamespace` serves it over HTTP: the
container parent runs core's `serveHttp` (via `runContainer({ backend })`) —
the same transport-neutral dispatch as the Lambda handler — on port **8080**,
with readiness on port **8081** (503 while draining).

- **Provisioned on demand.** The shared API gateway calls `apiIngress()` for a
  compute only when a namespace is routed to it (after the backend import,
  before `finalize()`), and the ingress is created then. A container that only
  runs jobs gets no load balancer, listener or target group, and its image entry
  keeps a plain health check on 8080: only a compute that serves API traffic
  sets `BLOCKS_CONTAINER_SERVES_API`, which makes the entry pass the backend
  module to `runContainer`.
- **A running task.** The load balancer forwards only to running tasks and
  nothing starts one on a request, so a compute that serves API traffic with
  `scaling.minInstances: 0` fails synth.
- **One internal ALB per backend**, in the compute subnets, shared by every
  container that serves API traffic, with **one listener for all their API
  namespaces** on port 10000. Each namespace gets an exact-path rule
  (`/aws-blocks/api/{name}` → its compute's target group); any other path gets a
  404 from the load balancer. The gateway's VPC link integration targets the
  load balancer's ARN on that port.
  - A rule belongs to the shared listener and is named after its path, so moving
    a namespace to another container compute updates its target in place.
  - Its priority is derived from the path, so it is stable across deploys
    whatever namespaces come and go. Two paths that hash to the same priority
    fail synth (rename one export): shifting one to a free priority would make
    it depend on its neighbours, and break a later deploy that adds or removes one.
  - A rule's path pattern is at most 128 characters, so a longer namespace path
    fails synth. Past the default quota of 100 rules per load balancer, synth warns.
- **Only namespace paths reach a container; `RawRoute`s run on the default
  compute.** A namespace path is exact (`/aws-blocks/api/{name}`), so each one
  gets its own gateway resource and listener rule. `RawRoute` paths can be
  patterns (`/files/{id}`, `/files/*`): the gateway serves them through its
  catch-all resources, which integrate the default compute.
- **Reserved ports.** `10001–10999` is kept for listeners a single compute will
  own — e.g. one for a container's `RawRoute`s, forwarding everything to the
  compute so the container's own route matching decides. The whole
  `10000–10999` range is one security group rule per source, so adding a
  listener never adds a rule.
- **Target group** on task port 8080, health-checked on 8081. A stopping task
  is deregistered first — with a 65 s delay, past the longest call a front door
  allows (60 s), so in-flight requests finish — then gets SIGTERM and drains for
  up to 25 s within ECS's 30 s stop timeout.
- **Load balancers on the service.** The service is registered with its target
  group at the CloudFormation level, because the L2 route would open the load
  balancer to every group on the service. Its `LoadBalancers` property is always
  rendered — `[]` for a compute that serves no API — since CloudFormation keeps
  an attached target group when the property is simply absent.
- **Security groups.** The tasks get a group of their own that admits only the
  load balancer on 8080–8081 (one rule); the shared compute group (also used by
  in-VPC Lambdas and VPC endpoints) stays closed to inbound traffic. The load
  balancer admits the gateway's VPC link and, on the `cloudfront` tier,
  CloudFront's origin-facing prefix list — each on the listener port range.
- **Request URL.** A request reaches the task as the load balancer's hop — the
  integration URI's host, plain `http`, no stage — whereas the Lambda handler
  gets the client's `Host` and the stage in its API Gateway event. So the
  gateway stamps its public host and stage (`x-blocks-forwarded-host` /
  `x-blocks-forwarded-stage`, from its request context, overwriting any client
  value), and the container builds `ctx.request.url` from them: the same URL
  the Lambda handler reports. A request whose stamped headers aren't one
  well-formed value each — a client copy under another letter case, say — is
  refused with a 400.
- **CloudFront front doors.** On the `apiFrontDoor: 'cloudfront'` tier, the
  distribution that fronts the API — the managed one, or `Hosting`'s default
  CloudFront door when it claims the API — routes each container namespace's
  exact path (`/aws-blocks/api/{name}`) straight to the load balancer's shared
  listener through one CloudFront VPC origin per distribution, ahead of the
  `/aws-blocks/api/*` gateway behavior; the listener's path rule picks the
  compute. On the `apigateway` tier, and behind `Hosting`'s other doors, container
  namespaces go through the gateway like every other path.
  - CloudFront forwards the viewer's `Host` to a VPC origin with the origin port
    appended (`<domain>:10000`), so a viewer-request CloudFront Function stamps
    the bare viewer host as `x-blocks-forwarded-host` and drops
    `x-blocks-forwarded-stage`, overwriting client values: `ctx.request.url` is
    the public URL, custom domain included. (A namespace on a Lambda compute,
    which CloudFront reaches through the gateway, reports the gateway's
    `execute-api` URL instead.)
  - The load balancer admits CloudFront's origin-facing prefix list on the
    listener range in one rule — the prefix list is looked up at deploy time (a
    custom resource, created with the gateway) because its id differs per region.
    The prefix list weighs ~55 of the group's 60 rules, which is why the whole
    range is a single rule.
  - The origin's read timeout is 60 s, matching the load balancer's idle timeout:
    raising one alone doesn't lengthen a call.
  - A direct call skips the gateway, so its stage throttling and access logs
    don't apply; the distribution's web ACL does (`apiWaf` on the managed
    distribution, `Hosting`'s WAF when Hosting fronts the API). Synth warns when
    the distribution has none.
  - A VPC origin needs the VPC to have an internet gateway, and isn't available
    in a few Availability Zones (see the CloudFront VPC origins docs).
- **Moving a live namespace onto a container.** CloudFormation switches the
  namespace's route to the load balancer without waiting for the new tasks to
  become healthy (making the gateway wait on the ECS service would be a
  dependency cycle once the config the service waits for carries a CloudFront
  URL). So during that deploy, calls to the namespace can get 503s for the minute
  or two the tasks take to start and pass their health check.
- **Limits.** Through the gateway, API calls keep its ~29-second integration
  timeout; through a CloudFront VPC origin, up to 60 seconds.

## Autoscaling

`finalize()` (called once per compute by `create()` after the backend import)
wires Application Auto Scaling from `scaling`:

- `minInstances`/`maxInstances` → `autoScaleTaskCount({ minCapacity, maxCapacity })`.
- Each `ScalingSignal` → an autoscaling policy: `cpu`/`memory` as a
  **target-tracking** policy on the ECS utilization metrics; `queue-depth` as a
  **step-scaling** policy on a CloudWatch metric-math sum of
  `ApproximateNumberOfMessagesVisible` across every queue the compute drains,
  with `backlogPerInstance` as the per-step threshold. (Queue-depth can't use
  target tracking — that API rejects a metric-math expression — so it steps
  capacity up as the backlog grows and down to the floor as it drains.)
- The compute's queues are discovered via `registerOwnedQueue`, which an AsyncJob
  assigned here calls at synth. Autoscaling is wired at `finalize()` precisely so
  every owned queue is known first.
- Omitted `strategy` → inferred: queue-depth when the compute drains queues, else
  CPU. A compute that drains queues **and** serves API traffic gets both: CPU
  target tracking follows the API load and removes capacity, while the queue
  backlog only adds it (no scale-in step) — a queue-depth scale-in step would
  remove tasks the API still needs whenever the queue is empty. With I/O-bound
  jobs, CPU tracking can scale in while a backlog remains, and the queue step adds
  the task back. `maxInstances ≤ 1` wires no policy.

## Runtime (worker isolation)

The container runs each job in a fresh `worker_thread` (see core's
`container-runtime`), which is what makes the per-delivery wall-clock timeout
*enforced* — the worker is hard-terminated at the deadline, stopping even a
non-cooperative CPU loop. Per-instance concurrency is
`max(1, ceil(maxConcurrencyPerCPU × size.vcpu))`, resolved at synth and stamped
into config for the poller.
