---
'@aws-blocks/core': minor
---

Multi-compute assignment mechanism (internal). Wire up the plumbing that lets an
API namespace or worker run on a compute other than the stack default, driven off
an internal `ScopeOptions.compute` hook — the public option that forwards into it
lands in a later release.

- `ScopeOptions.compute` sets a scope-level compute, inherited by everything built
  inside that scope; the CDK `Scope` resolves the nearest assigned compute (else the
  default) via its existing `compute` getter, and the namespace's routing entry now
  carries that compute's `endpoint`, so the front door fans the namespace out to its
  origin with no change to the front-door assembly.
- Routability guard: a namespace assigned to a compute with no HTTP ingress now fails
  synth with an actionable message naming the path, instead of silently falling back
  to the default origin.

No breaking public API surface changes (the additions — `ScopeOptions.compute` and the
exported `AssignedCompute` type — are optional and additive) and no behavior change for
single-compute apps (the only kind today): every route still resolves to the default
compute.
