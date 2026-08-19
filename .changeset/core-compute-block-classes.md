---
"@aws-blocks/core": patch
---

feat(core): add the internal `Compute` abstraction

Introduce the abstract `Compute` base behind a new internal entry point
(`@aws-blocks/core/cdk/internal`). A compute resolves its owning
`BlocksStack`/`BlocksBackend` on construction to derive its runtime identity
(backend entry + stack name). It is framework/test-only — not part of the public
API, and customers cannot instantiate a compute yet. Concrete computes live in
their own packages (e.g. `@aws-blocks/bb-lambda-compute`).
