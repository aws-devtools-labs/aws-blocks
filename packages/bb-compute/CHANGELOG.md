# @aws-blocks/bb-compute

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
- Updated dependencies [6a53068]
- Updated dependencies [dd5e807]
- Updated dependencies [db15b5e]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [72e3259]
- Updated dependencies [48c35f6]
- Updated dependencies [8565ef7]
- Updated dependencies [48c35f6]
- Updated dependencies [0d4ede3]
- Updated dependencies [63b154f]
- Updated dependencies [c0f6a83]
- Updated dependencies [b6b8ade]
- Updated dependencies [82ea78a]
- Updated dependencies [e44ac0c]
- Updated dependencies [33e8d73]
- Updated dependencies [b003705]
- Updated dependencies [48c35f6]
  - @aws-blocks/core@0.8.0
  - @aws-blocks/bb-container-compute@0.2.0
  - @aws-blocks/bb-lambda-compute@0.7.0
