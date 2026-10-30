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
  CPU. `maxInstances ≤ 1` wires no policy, unless `minInstances` is 0.

### Scaling to zero (`minInstances: 0`)

With `minInstances: 0` the service deploys with `DesiredCount: 0` and can scale
in to zero tasks, where nothing polls the owned queues. The queue-depth policy
can't wake it: [step adjustments](https://docs.aws.amazon.com/autoscaling/application/userguide/step-scaling-policy-overview.html)
are relative to the current task count, and a backlog under `backlogPerInstance`
falls in the `change: 0` step, so 0 tasks stay 0 tasks and the message is never
read.

So a min-0 compute that drains queues gets one more step policy,
`WakeOnWaitingMessages`: an alarm on the sum of `ApproximateNumberOfMessagesVisible`
(waiting, not in flight) across its queues adds one task when the sum is 1 or
more. While a task with free capacity is running it receives messages within
seconds, so Visible stays at 0 and the policy is idle; when every task is busy
it also adds capacity up to `maxInstances`. Scale-in is left to the queue-depth
policy, which counts in-flight messages and so never removes the last task from
under a running job. Computes with `minInstances ≥ 1` synthesize exactly the
policies they did before.

Waking takes minutes, not seconds: SQS publishes queue metrics to CloudWatch
once a minute, the alarm evaluates a one-minute period, and the new task then
starts and fetches the app code. A queue idle for more than six hours also
[stops publishing metrics](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/monitoring-using-cloudwatch.html)
until it receives a message.

## Runtime (worker isolation)

The container runs each job in a fresh `worker_thread` (see core's
`container-runtime`), which is what makes the per-delivery wall-clock timeout
*enforced* — the worker is hard-terminated at the deadline, stopping even a
non-cooperative CPU loop. Per-instance concurrency is
`max(1, ceil(maxConcurrencyPerCPU × size.vcpu))`, resolved at synth and stamped
into config for the poller.
