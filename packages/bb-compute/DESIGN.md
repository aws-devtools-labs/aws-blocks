# bb-compute — design

## Purpose

`Compute` is the one customer-facing compute surface. It is a thin **selector**:
the customer states `type`, and `Compute` owns the concrete, `Scope`-backed
backing compute for that type, exposing it via a `compute` getter. There is no
capability inference.

## The selector

`new Compute(scope, id, { type, ... })` constructs and owns:

- `type: 'serverless'` → a `LambdaCompute` (from `@aws-blocks/bb-lambda-compute`)
- `type: 'container'` → a `ContainerCompute` (from `@aws-blocks/bb-container-compute`)

`Compute` is a **composition**: it `extends BuildingBlockScope`, constructs the
backing as a child, and holds it in a private `#backing` exposed through a
`get compute()` getter. It satisfies the `ComputeProvider` contract
(`{ compute: ComputeBase }`), so a workload handed a `Compute` reads `.compute`
to get the real, branded backing the framework's delivery logic (`AsyncJob`) and
finalize steps recognize. A raw backing (`LambdaCompute`/`ContainerCompute`) also
satisfies `ComputeProvider` by providing itself (`get compute()` returns `this`),
so the public block and a raw backing are interchangeable wherever a
`ComputeProvider` is accepted.

Only the backing registers as a compute on the stack — the `Compute` wrapper is
an ordinary `BuildingBlockScope` node, so the compute registry/finalize census
sees exactly one compute per `Compute`, not two.

## Why the concrete computes extend `ComputeBase`

Both backing computes extend the core `ComputeBase`, which extends `Scope`. So
the backing instance has a `fullId`, a position in the construct tree, and a
place in the per-stack compute registry — the same machinery every Building
Block relies on. This is what lets finalize steps enumerate computes (config,
tracing, autoscaling) and lets a compute be injected and resolved like any other
construct.

## Per-type options, no inference

The type is stated, never derived. `ComputeOptions` (in core) is a discriminated
union on `type`, so each type exposes only its own options and an inapplicable
attribute is a compile error. The alternative — inferring the type from opaque
attributes like a timeout or memory ceiling — was rejected (see
`docs/design/compute-selection-api.md`, Appendix B): it hides the kind of compute
a customer is getting, which contradicts the Cloud-not-AWS goal.

## Conditional entries

Standard four-entry conditional export. The CDK entry provisions; the
`aws-runtime`/`mock`/`browser` entries own an inert backing and expose it via the
same `compute` getter, so a `{ compute }` reference resolves in every phase and
`import`-time construction of the backend succeeds.
