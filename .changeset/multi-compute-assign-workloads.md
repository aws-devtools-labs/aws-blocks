---
'@aws-blocks/core': minor
'@aws-blocks/bb-async-job': minor
'@aws-blocks/bb-cron-job': minor
'@aws-blocks/bb-dashboard': minor
'@aws-blocks/blocks': patch
---

Assign a workload to its own compute. Declare a compute by what a workload needs
with `ComputeProvider.provide()`, then hand it to the workload — the piece that
should run with a bigger timeout or more memory moves off the app's default
compute, while everything else stays on it.

- `ApiNamespace` takes a `{ compute }` option (4th argument): the API front door
  routes that namespace's subtree to the assigned compute's origin.
- `AsyncJob` and `CronJob` take a `compute` option: the job's SQS event source /
  EventBridge schedule targets the assigned compute's Lambda (which must be a Lambda
  compute — a worker-only compute with no HTTP ingress is a valid target here). Each
  `CronJob` grants its EventBridge Scheduler role invoke on its own compute's Lambda,
  so two cron jobs on two computes both fire (rather than the second failing at runtime
  with AccessDenied).
- `Dashboard` takes a `computes` option to focus the dashboard on a specific set of
  computes; omitted, it keeps covering every compute in the app.
- A `RawRoute` inherits the compute of the scope it is created under, and now fails
  synth if that compute has no HTTP endpoint rather than silently answering from the
  default compute.

Assignment shapes deployed routing only; local dev and the mock still run the whole
app in one process, so behavior there is unchanged. Apps that never call
`ComputeProvider.provide()` are unaffected — every workload runs on the default compute.
