# @aws-blocks/bb-compute

## 0.2.0

### Minor Changes

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

- Updated dependencies [1076ccc]
- Updated dependencies [50b8c94]
- Updated dependencies [ce5dfa9]
- Updated dependencies [9a32674]
- Updated dependencies [8c73a24]
- Updated dependencies [4553866]
- Updated dependencies [d366907]
- Updated dependencies [d062eeb]
- Updated dependencies [63b154f]
- Updated dependencies [ce5dfa9]
- Updated dependencies [7477b6e]
- Updated dependencies [6a53068]
- Updated dependencies [72e3259]
- Updated dependencies [0d4ede3]
- Updated dependencies [63b154f]
- Updated dependencies [b6b8ade]
- Updated dependencies [82ea78a]
- Updated dependencies [e44ac0c]
- Updated dependencies [33e8d73]
  - @aws-blocks/core@0.8.0
  - @aws-blocks/bb-container-compute@0.2.0
  - @aws-blocks/bb-lambda-compute@0.7.0
