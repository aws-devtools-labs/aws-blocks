---
"@aws-blocks/core": patch
---

feat(core): add internal `ComputeBlock` + `LambdaCompute` abstraction

Introduce the compute-block types (`ComputeBlock` base + `LambdaCompute`) behind
a new internal entry point (`@aws-blocks/core/cdk/internal`). Each compute
resolves its owning `BlocksStack`/`BlocksBackend` on construction to derive its
runtime identity (backend entry + stack name). These are framework/test-only and
are not part of the public API — customers cannot instantiate a compute yet.
Pure additive dead code: nothing in the default path constructs a
`LambdaCompute`, so app behavior is unchanged.
