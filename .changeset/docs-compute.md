---
"@aws-cdk-blocks/bb-compute": patch
---

docs: `scaling.strategy` takes signal objects (`{ on: 'cpu', targetPercent }`, `{ on: 'memory', targetPercent }`, `{ on: 'queue-depth', backlogPerInstance }`), not names. The README now holds the options, defaults and scaling rules of every compute type.
