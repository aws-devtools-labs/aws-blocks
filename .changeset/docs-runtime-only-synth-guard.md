---
'@aws-blocks/bb-realtime': patch
'@aws-blocks/bb-kv-store': patch
'@aws-blocks/bb-distributed-table': patch
---

Docs: correct the README "Runtime only" note — a data method called during CDK synth throws an explicit `<Class>.<method>() cannot be called during CDK synth` error, not `<x>.<method> is not a function`.
