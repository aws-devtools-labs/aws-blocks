# @aws-cdk-blocks/bb-compute

The `Compute` Building Block selects where a workload runs: `type: 'serverless'` (AWS Lambda) or `type: 'container'` (AWS Fargate).

**When to use:** A workload needs a runtime other than the app's default compute
(serverless): a background job that runs longer than 15 minutes, needs more
memory or needs system libraries in the image, or an `ApiNamespace` that needs
more memory (and CPU), always-warm tasks or its own scaling.

**When NOT to use:**

- The default compute fits: omit `compute` and the workload uses it.
- Short request/response work with spiky traffic: keep it on `serverless`,
  which has no idle cost.
- As a security boundary: every compute runs the same backend bundle under the
  app's one execution role.
- API calls that run longer than the [time limits](#time-limits): run that work
  in an `AsyncJob`.

## Quick start

```ts
import { Compute } from 'aws-cdk-blocks';

const api = new Compute(scope, 'api', { type: 'serverless', memory: 512 });

const worker = new Compute(scope, 'worker', {
  type: 'container',
  size: { vcpu: 1, memory: 2048 },
  scaling: { minInstances: 1, maxInstances: 10 },
});
```

Hand a `Compute` to a workload that supports it:

```ts
new AsyncJob(scope, 'reports', { compute: worker, timeoutSeconds: 1800, handler });

export const reports = new ApiNamespace(scope, 'reports', (context) => ({ /* methods */ }), { compute: api });

new CronJob(scope, 'nightly', { compute: api, schedule: 'cron(0 2 * * ? *)', handler: async () => { /* … */ } });
```

| Workload | Option | Compute types |
| --- | --- | --- |
| `AsyncJob` | `compute` | `serverless`, `container` |
| `ApiNamespace` | `compute` (4th argument) | `serverless`, `container` |
| `CronJob` | `compute` | `serverless`, `container` |
| `Scope` (everything under it) | `compute` | `serverless`, `container` (see [Placing a whole scope](#placing-a-whole-scope)) |

## API

`new Compute(scope, id, options)`. `options.type` is required:

| Type | Model | Backed by |
| --- | --- | --- |
| `serverless` | Pay-as-you-go, per-request, short-lived | Lambda |
| `container` | Long-running / long-lived process | Fargate |

### Options

Options are scoped to the type: an option that doesn't apply to the chosen
type is a compile error.

#### `serverless`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `memory` | `number` | `2048` | Function memory in MB. CPU scales with it. |
| `maxTimeoutSeconds` | `number` | `900` | Function timeout in seconds (1–900). A job's `timeoutSeconds` must fit within it. A short function timeout also shortens [API calls](#time-limits); increasing it does not extend the gateway timeout. |
| `logRetention` | `RetentionDays` | the stack's `defaults.logRetention` | How long the compute's log group keeps logs. |

#### `container`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `size` | `ContainerSize` | `{ vcpu: 0.5, memory: 1024 }` | A valid Fargate `{ vcpu, memory }` pair, memory in MB. Each vCPU value permits only a fixed set of memory values; an invalid pair doesn't type-check. |
| `scaling` | `ContainerScaling` | one task, no autoscaling | `{ minInstances, maxInstances, strategy? }`. See [Scaling](#scaling). |
| `image` | `string` | `public.ecr.aws/docker/library/node:24-slim`, pinned by digest | Public or ECR image URI, used verbatim. See [Container image](#container-image). |
| `logRetention` | `RetentionDays` | the stack's `defaults.logRetention` | How long the container's log group keeps logs. |

The tasks run in the app's VPC (the one you provide via `defaults.vpc.network`,
or the shared AWS CDK Blocks VPC), in the private-with-egress subnets by default (or
the `defaults.vpc.subnets` you choose).

## Errors

The following conditions throw an error at synth (`cdk synth` / deploy):

- `scaling.minInstances` is not an integer of 0 or more, `scaling.maxInstances`
  is not an integer of 1 or more, or `minInstances` exceeds `maxInstances`.
- `scaling.minInstances: 0` on a compute with no `AsyncJob` or `CronJob`, or
  with a `cpu`/`memory` strategy.
- `scaling.minInstances: 0` on a compute that serves an `ApiNamespace`.
- A placed namespace's export name does not match `[A-Za-z0-9:._$-]+`.
  Rename it so API Gateway can use it as a path segment.
- With `strictNamespacePlacement: true`, the JSON placement map exceeds 2048
  UTF-8 bytes. Place fewer namespaces or shorten export names or compute IDs.
- A namespace path longer than 128 characters (an export name over 112
  characters), or two namespace paths that map to the same load balancer rule
  priority. Rename the export.

Synth warnings:

- `@aws-cdk-blocks/bb-container-compute:api-rule-quota`: more than 100 container
  API namespaces share one load balancer, its default listener-rule quota.
  Request a quota increase before deploying. Once the quota is sufficient,
  acknowledge the listener warning on the stack returned by `BlocksStack.create()`:
  `Annotations.of(stack).acknowledgeWarning('@aws-cdk-blocks/bb-container-compute:api-rule-quota')`.
  If using `BlocksBackend.create()`, pass the returned backend instead; the
  shared listener is a descendant of that backend, not of an individual compute.
- `blocks:apigateway:bare-endpoint-serves-placed-namespaces`: see
  [`strictNamespacePlacement`](#strictnamespaceplacement).
- `blocks:apigateway:namespace-compute-not-owned`: a namespace explicitly uses
  a compute from another backend and runs on this backend's default compute instead.
- `blocks:api:direct-routes-without-public-subnets`: the load balancer's VPC
  has no public subnets, so CloudFront uses the gateway (see [Time limits](#time-limits)).
- `blocks:api:direct-routes-without-waf`: CloudFront routes directly to a
  container load balancer but the distribution has no web ACL. Gateway
  throttling and access logs do not apply to those routes.

## Scaling

`scaling` on a `container` compute wires Application Auto Scaling between
`minInstances` and `maxInstances`.

`strategy` is one signal or an array of them:

| Signal | Scales on |
| --- | --- |
| `{ on: 'cpu', targetPercent }` | Average CPU utilization |
| `{ on: 'memory', targetPercent }` | Average memory utilization |
| `{ on: 'queue-depth', backlogPerInstance }` | Messages waiting or in flight on the compute's job queues |

Without `scaling.strategy`, CDK Blocks picks one by what the compute runs:

| The compute runs | Default strategy |
| --- | --- |
| `AsyncJob`s or `CronJob`s only | `queue-depth`, `backlogPerInstance: 100` |
| No jobs | `cpu`, `targetPercent: 65` |
| Jobs and an `ApiNamespace` | Both. CPU (the API load) scales it in; the queue backlog only adds tasks. |

`minInstances`:

- `1` or more, for most workloads: a running task starts a job or CronJob tick
  within seconds. Those tasks are billed around the clock, even when no job is
  running.
- `0`, only for long-running jobs that can tolerate high latency before they
  start: the compute scales to zero tasks between jobs, and each job has to
  start a task first. That usually takes a few minutes, and up to about 20
  minutes when the job's queue has been idle for more than six hours.
  `minInstances: 0` needs at least one `AsyncJob` or `CronJob` on the compute
  and the default (or `queue-depth`) strategy, and can't be used on a compute
  that serves an `ApiNamespace`: nothing starts a task for an incoming request.

## Container image

CDK Blocks builds no image and deploying needs no local Docker. Your application
code is shipped separately as an S3 asset and fetched at every task start, so
`image` only supplies the runtime environment.

The default image is ECR Public's mirror of the Docker official `node:24-slim`
image, pinned by digest. The digest changes only with a CDK Blocks release.

- It runs as the unprivileged `node` user (uid/gid 1000), not root.
- The process starts in `/home/node`, which that user owns, so a relative write
  such as `writeFile('report.csv')` lands there.
- As in Lambda, write scratch files under `/tmp`.

A custom `image`:

- must be arm64-compatible and provide a Node 24 runtime on `PATH`, plus any
  system libraries your handlers need (e.g. media tooling);
- is used exactly as written: CDK Blocks doesn't add a digest to it or change its
  user. It runs as the image's own default user and starts in its own `WORKDIR`;
- is pulled by ECS at every task start, and the container runs with the stack's
  shared execution role. A tag such as `my-image:24` can point at different
  bytes on each start, so pin the image by digest. Use the
  `repository@sha256:<digest>` form (ECS documents `:tag` or `@digest`, not both)
  and keep the tag in a comment:

```ts
new Compute(scope, 'worker', {
  type: 'container',
  image: 'public.ecr.aws/my-registry/my-image@sha256:<64-hex digest>', // my-image:24
});
```

Get the digest of a multi-arch image with
`docker buildx imagetools inspect <image>:<tag>` (the `Digest:` line) or
`crane digest <image>:<tag>`.

If your app needs root, for example to install packages at boot, set `image`
explicitly: passing the stock Node image
(`public.ecr.aws/docker/library/node@sha256:<64-hex digest>`) runs it as root.

## Deploys restart running jobs

A deploy that changes your code replaces a `container` compute's tasks. A
stopping task stops taking new jobs and gives running ones up to about 2
minutes to finish (the AWS Fargate maximum). A job still running after that is
stopped and runs again from the start, and the restart counts as one of its
attempts.

## Placing a whole scope

Set `compute` on a `Scope` to place everything created under it, including in
its child scopes, without passing `compute` to each block:

```ts
const reportsCompute = new Compute(scope, 'reports-compute', { type: 'serverless', memory: 4096 });
const reports = new Scope('reports', { parent: scope, compute: reportsCompute });

export const reportsApi = new ApiNamespace(reports, 'reports', (context) => ({ /* methods */ }));
new AsyncJob(reports, 'rebuild', { handler: async () => { /* … */ } });
new CronJob(reports, 'nightly', { schedule: 'cron(0 2 * * ? *)', handler: async () => { /* … */ } });
```

- **Give the `Compute` and the `Scope` different ids** when they share a parent:
  both are child constructs of it.
- **Nearest wins.** A block's own `compute` option, then the nearest scope that
  sets `compute`, then the app's default compute.
- **A container scope** places its `AsyncJob`s, `CronJob`s and `ApiNamespace`s
  on the container. Its namespaces are served through the container's load
  balancer (see [Container namespaces](#container-namespaces)), so the
  container needs at least one running task. Setting an `AsyncJob`'s
  `maxConcurrencyPerCPU` requires the container passed as the job's own
  `compute`; a scope-inherited container does not type-check.
- **`Realtime` and `RawRoute` stay on the default compute**, inside such a scope
  too. `Realtime`'s `publish()` works from any compute.

## API namespaces

An `ApiNamespace` runs on the app's default compute unless it gets a compute
from its own `compute` option or from its scope. `RawRoute`s and the auth HTTP
routes (`/cdk-blocks/auth/*`) always run on the default compute.

- **Routing follows the export name** — the name your frontend imports
  (`export const reports = …` → `reports`), not the second `ApiNamespace`
  argument.
- **Share a compute** across namespaces and `AsyncJob`s by passing the same
  `Compute` to each; they then run in the same function (or the same
  container tasks).
- **Clients don't change.** `reports.build('2026-10')` calls
  `POST /cdk-blocks/api/reports` from the TypeScript client and from the
  Swift, Kotlin and Dart clients alike, and the stack's shared API gateway
  routes that path to the namespace's compute. It works the same on every
  `apiFrontDoor` tier and behind `Hosting`, so the API keeps one domain.

### `strictNamespacePlacement`

By default, placing a namespace on its own compute is a routing preference,
not a boundary:

- The bare `POST /cdk-blocks/api` endpoint, served by the default compute, runs
  any namespace named in the request body. Anyone who can call your API can run
  a placed namespace on the default compute instead: with the default compute's
  memory and timeout, outside the container you placed it on, and outside the
  app's VPC unless you set `defaults.vpc` (only then does the default compute
  join it).
- Your per-method `requireAuth` and `requireRole` checks run either way.
- Synth warns (`blocks:apigateway:bare-endpoint-serves-placed-namespaces`).

Set `strictNamespacePlacement: true` in the stack's `defaults`, next to the
preset you already spread there, to refuse such calls. It is `false` in both
presets.

- Each compute then serves only the namespaces placed on it. A call to a
  namespace placed elsewhere gets the same "method not found" error as an
  unknown namespace.
- The typed clients call each namespace at its own path, so they keep working.
  A raw HTTP caller, or a native client released before per-namespace paths,
  posts to the bare endpoint and is refused: point it at the namespace's own
  path before turning the option on.
- The option applies only to deployed computes. The local dev server serves
  every namespace on every path, so a raw bare-endpoint call that works under
  `npm run dev` returns "method not found" once deployed.
- It doesn't split IAM: every compute runs the same backend bundle under the
  app's one execution role.

If raw callers still need the bare endpoint, leave the option off and
acknowledge the warning with
`Annotations.of(stack).acknowledgeWarning('blocks:apigateway:bare-endpoint-serves-placed-namespaces')`
on the stack or backend returned by `create()`.

### Time limits

- API Gateway allows about 29 seconds. On Lambda, the handler returns a timeout after 28 seconds or one second before the function deadline, whichever comes first. Run longer work in an `AsyncJob`.
- A call to a `container` namespace on the `apiFrontDoor: 'cloudfront'` tier
  can run up to 60 seconds if the load balancer's VPC has public subnets:
  the managed distribution or `Hosting`'s default CloudFront door routes the
  namespace's path straight to the load balancer. Without public subnets,
  synth warns `blocks:api:direct-routes-without-public-subnets` and the call
  stays on API Gateway's roughly 29-second limit.

### Container namespaces

A `container` compute serves its namespaces from its long-running tasks, with
no cold starts and with CPU and memory sized for the workload.

- The gateway reaches the tasks through an internal Application Load Balancer
  in the app's VPC. One load balancer is shared by every container in the
  backend that hosts a namespace.
- The compute needs at least one running task, and the load balancer limits
  the number and name length of namespaces (see [Errors](#errors)).
- Moving a namespace that already serves traffic onto a container: during
  that deploy, its calls can get 503s for the minute or two the new tasks take
  to start, because the route switches before they're healthy.
- Through a CDK Blocks CloudFront front door, `ctx.request.url` is the CloudFront
  (or custom-domain) URL in a container namespace and in a namespace on a
  Lambda compute alike. Called at the gateway's `execute-api` URL directly,
  both report the gateway's host.

## Local development

Handlers run in-process regardless of the assigned compute. Options that only
matter to deployed infrastructure (`size`, `scaling`, `image`) have no effect
in the mock.
