# bb-compute — design

## Purpose

`Compute` is the one customer-facing compute surface. It is a thin **selector**:
the customer states `type`, and `Compute`'s constructor returns the concrete,
`Scope`-backed backing compute for that type. There is no wrapper layer and no
capability inference.

## The selector

`new Compute(scope, id, { type, ... })` returns:

- `type: 'serverless'` → a `LambdaCompute` (from `@aws-blocks/bb-lambda-compute`)
- `type: 'container'` → a `ContainerCompute` (from `@aws-blocks/bb-container-compute`)

A JS constructor may return an object, which becomes the result of `new`. We use
that so the value a customer holds is the real, branded concrete compute — the
instance the framework's delivery logic (`AsyncJob`) and finalize steps
recognize — rather than a forwarding shell. The static return type is the opaque
`ComputeHandle` so customer code doesn't depend on which class backs it.

## Why the concrete computes extend `Scope`

Both backing computes extend the core `Compute` base, which extends `Scope`. So
the returned instance has a `fullId`, a position in the construct tree, and a
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
`aws-runtime`/`mock`/`browser` entries return the inert concrete handle so a
`{ compute }` reference resolves in every phase and `import`-time construction of
the backend succeeds.
