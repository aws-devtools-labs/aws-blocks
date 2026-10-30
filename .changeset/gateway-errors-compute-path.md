---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): name the customer's `Compute` in shared-gateway synth errors

The synth errors for a compute that can't serve API namespaces, and for an
export name API Gateway can't route, named the compute by its construct id —
for a `Compute` block that is its internal `backing` child. They now give the
compute's full construct path (for example `MyStack/app/reports/backing`), which
includes the id you passed to `new Compute(...)`.
