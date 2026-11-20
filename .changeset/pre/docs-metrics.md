---
"@aws-cdk-blocks/bb-metrics": patch
---

docs: `namespace` defaults to the block's `fullId`. `InvalidNamespace` is thrown by `new Metrics(...)` at run time and in local dev, not during synth.
