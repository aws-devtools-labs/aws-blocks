# @aws-blocks/bb-compute

The `Compute` Building Block is the single surface for choosing where a workload runs.
State the compute `type` and its options; Blocks maps the type to the AWS
service that backs it. The service name never appears in your code.

```ts
import { Compute } from '@aws-blocks/blocks';

// Serverless (Lambda today): pay-as-you-go, per-request.
const api = new Compute(scope, 'api', { type: 'serverless', memory: 512 });

// Container (Fargate today): a long-running process.
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
```

| Workload | Option | Compute types |
| --- | --- | --- |
| `AsyncJob` | `compute` | `serverless`, `container` |
| `ApiNamespace` | `compute` (4th argument) | `serverless`, `container` |

## Compute types

| Type | Model | Backed by |
| --- | --- | --- |
| `serverless` | Pay-as-you-go, per-request, short-lived | Lambda |
| `container` | Long-running / long-lived process | Fargate |

> Type names are provisional; `vm` and `kubernetes` are planned. See
> `docs/design/compute-selection-api.md`.

## Options

Options are scoped to the type — an attribute that doesn't apply to the chosen
type is a compile error.

### `serverless`

- `memory?` — function memory (MB); CPU scales with it.
- `maxTimeoutSeconds?` — the function's inherent runtime ceiling (≤ 900). A job's
  own `timeoutSeconds` must fit under it.

### `container`

- `size?` — a valid `{ vcpu, memory }` combination. Each vCPU permits only a
  fixed set of memory values (an invalid pair won't type-check).
- `scaling?` — `{ minInstances, maxInstances, strategy? }`. Wires real
  Application Auto Scaling. `strategy` is one or more of `cpu`/`memory`/`queue-depth`
  signals; omit it and Blocks infers one (queue-depth for a job worker, CPU
  otherwise).
- `image?` — the container image to run (public or ECR URI), used **verbatim**
  (pulled by ECS at task start). Blocks builds **no** image and deploying needs
  **no local Docker**: your application code is shipped separately as an S3 asset
  and fetched at boot. So a custom image only supplies the runtime environment —
  it must provide a **Node 24** runtime on `PATH`, plus any system libraries your
  handlers need (e.g. media tooling). Defaults to
  `public.ecr.aws/docker/library/node:24-slim` (arm64-compatible). See
  [DESIGN.md](../bb-container-compute/DESIGN.md) for the boot mechanism.

## API namespaces

Every `ApiNamespace` runs on the app's default compute unless you pass one:

```ts
const reportsCompute = new Compute(scope, 'reports', { type: 'serverless', memory: 4096 });

export const reports = new ApiNamespace(scope, 'reports', (context) => ({
  async build(month: string) {
    // …
  },
}), { compute: reportsCompute });
```

- **Clients don't change.** `reports.build('2026-10')` still calls
  `POST /aws-blocks/api/reports` — from the TypeScript client and from the
  Swift, Kotlin and Dart clients alike — and the stack's shared API gateway
  routes that path to the namespace's compute. It works the same on every
  `apiFrontDoor` tier and behind `Hosting`, so the API keeps one domain. A call
  to the bare `/aws-blocks/api` endpoint — a raw HTTP call, or one from a native
  client released before per-namespace paths — still runs on the default
  compute.
- **The gateway's limits still apply.** An API call is capped at ~29 seconds
  whatever the compute's `maxTimeoutSeconds` (except a container namespace that
  CloudFront reaches directly, below); run longer work in an `AsyncJob`.
- **It's placement, not isolation.** Every compute runs the same backend bundle
  under the app's one execution role, so a separate compute is not a security
  boundary.
- **Routing follows the export name** — the name your frontend imports
  (`export const reports = …` → `reports`), not the second `ApiNamespace`
  argument.
- **Share a compute** across namespaces and `AsyncJob`s by passing the same
  `Compute` to each; they then run in the same function (or the same
  container tasks).
- **A `container` compute serves its namespaces from its long-running tasks** —
  no cold starts, CPU and memory sized for the workload:

  ```ts
  const renderCompute = new Compute(scope, 'render', { type: 'container', size: { vcpu: 2, memory: 4096 } });
  export const render = new ApiNamespace(scope, 'render', (context) => ({ /* methods */ }), { compute: renderCompute });
  ```

  The gateway reaches the tasks through an internal Application Load Balancer
  the compute provisions in the app's VPC (with a VPC link), so the same
  ~29-second cap applies. On the `apiFrontDoor: 'cloudfront'` tier, the
  CloudFront distribution that fronts the API (the managed one, or `Hosting`'s
  default CloudFront door) routes the namespace's path straight to that load
  balancer instead (a VPC origin), so a call can run up to 60 seconds. One load
  balancer (and one listener) is shared by every container in the backend that
  hosts a namespace.

  - It needs at least one running task: `scaling.minInstances: 0` fails synth.
  - Without a `scaling.strategy`, a container that also runs an `AsyncJob`
    scales on CPU (the API load), and its queue backlog adds tasks too.
  - Moving a namespace that already serves traffic onto a container: during
    that deploy, its calls can get 503s for the minute or two the new tasks take
    to start, because the route switches before they're healthy.
  - The load balancer allows 100 namespaces by default (synth warns past that;
    the quota can be raised), and an export name can be at most 112 characters.

  Through CloudFront, `ctx.request.url` in a container namespace is the
  CloudFront (or custom-domain) URL, while a namespace on a Lambda compute
  reports the gateway's `execute-api` URL, since CloudFront reaches it through
  the gateway.
- **Everything else stays on the default compute:** namespaces without a
  `compute`, `RawRoute`s, and the auth routes.

## Local development

Compute assignment is transparent in local dev — handlers run in-process
regardless of the assigned compute. Attributes that only matter to deployed
infrastructure (size, scaling) have no effect in the mock.

## When to use

Assign a `Compute` when a workload needs a runtime other than the app default
(serverless) — most commonly a long-running or high-memory background job that a
container can serve but a serverless function cannot, or an API namespace that
needs more memory (and CPU) or its own scaling separate from the rest of the API.
Omit `compute` and the workload uses the app default.
