---
"@aws-blocks/bb-compute": minor
"@aws-blocks/bb-container-compute": minor
"@aws-blocks/bb-lambda-compute": minor
"@aws-blocks/bb-async-job": minor
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

feat(compute): the `Compute` block and container-backed AsyncJobs

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
*replacement* — destroying the database. A Database with no customer VPC keeps
building its own, exactly as before. (Moving a Database into a shared VPC remains
a deliberate, out-of-band migration.)
