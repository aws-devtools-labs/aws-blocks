---
"@aws-blocks/bb-metrics": patch
---

fix: `Metrics.fromExisting()` works during `cdk synth`

`Metrics.fromExisting()` was missing under `cdk`, so the documented
`new Metrics(scope, 'legacy', { metrics: Metrics.fromExisting('MyOrg/SharedMetrics') })` crashed `cdk synth`. It is
now available there too. Calling `metrics.child()` at the top level of a backend module now throws the actionable
synth-time error, like `emit()`, instead of `x is not a function`.
