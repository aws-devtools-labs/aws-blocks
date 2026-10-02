---
"@aws-blocks/bb-compute": minor
"@aws-blocks/bb-container-compute": minor
"@aws-blocks/bb-lambda-compute": minor
"@aws-blocks/bb-async-job": minor
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
  `min/maxInstances` + `cpu`/`memory`/`queue-depth` target-tracking policies;
  queue-depth sums the messages across the queues the compute drains), and a
  custom `image`.

**`AsyncJob({ compute })`.** A job runs on the app default (serverless) unless
given a `Compute`. On a container, delivery is an owner-matched SQS poller the
container self-starts, and each delivery runs in its own worker thread so the
job's `timeoutSeconds` is hard-enforced (the worker is terminated at the
deadline). `maxConcurrencyPerCPU` sets in-flight deliveries per vCPU — the
per-instance count is `max(1, ceil(maxConcurrencyPerCPU × vcpu))`. Both are
properties of the work and live on the job; `size`/`scaling` live on the compute.
In local dev, compute assignment is transparent.

A container compute reuses an app-provided VPC (`defaults.vpc.network`) when one
is present, and only derives the shared Blocks VPC when none was provided — so
bring-your-own-VPC covers the Fargate tasks too.
