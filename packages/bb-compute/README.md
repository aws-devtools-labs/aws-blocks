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

new CronJob(scope, 'nightly', { compute: api, schedule: 'cron(0 2 * * ? *)', handler: async () => { /* … */ } });
```

| Workload | Option | Compute types |
| --- | --- | --- |
| `AsyncJob` | `compute` | `serverless`, `container` |
| `ApiNamespace` | `compute` (4th argument) | `serverless` |
| `CronJob` | `compute` | `serverless` |
| `Scope` (everything under it) | `compute` | `serverless`, `container` (see below) |

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
- **A container scope** places its `AsyncJob`s and `CronJob`s on the container.
  An `ApiNamespace` under it fails synth with an error naming the compute,
  because it runs only on a `serverless` compute for now: give it its own
  serverless `compute`, or create it outside that scope. Setting an
  `AsyncJob`'s `maxConcurrencyPerCPU` still needs the container passed as the
  job's own `compute`, so the option is typed for it.
- **`Realtime` and `RawRoute` stay on the default compute**, inside such a scope
  too. `Realtime`'s `publish()` works from any compute.

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
  otherwise). Set `minInstances: 0` to scale to zero tasks between jobs; a
  waiting job or CronJob tick then starts a task, which takes a few minutes. See
  [DESIGN.md](../bb-container-compute/DESIGN.md#scaling-to-zero-mininstances-0).
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
  whatever the compute's `maxTimeoutSeconds`; run longer work in an `AsyncJob`.
- **It's placement, not isolation.** Every compute runs the same backend bundle
  under the app's one execution role, so a separate compute is not a security
  boundary.
- **Routing follows the export name** — the name your frontend imports
  (`export const reports = …` → `reports`), not the second `ApiNamespace`
  argument.
- **Share a compute** across namespaces and `AsyncJob`s by passing the same
  `Compute` to each; they then run in the same function.
- **Only `serverless` computes serve API namespaces** today; passing a
  `container` compute is a type error.
- **Everything else stays on the default compute:** namespaces with no
  `compute` of their own or from their scope, `RawRoute`s, and the auth HTTP
  routes (`/aws-blocks/auth/*`).

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
