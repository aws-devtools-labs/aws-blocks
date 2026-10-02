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
```

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
- `image?` — a custom container image (ECR URI). Blocks builds one when omitted.

## Local development

Compute assignment is transparent in local dev — handlers run in-process
regardless of the assigned compute. Attributes that only matter to deployed
infrastructure (size, scaling) have no effect in the mock.

## When to use

Assign a `Compute` when a workload needs a runtime other than the app default
(serverless) — most commonly a long-running or high-memory background job that a
container can serve but a serverless function cannot. Omit `compute` and the
workload uses the app default.
