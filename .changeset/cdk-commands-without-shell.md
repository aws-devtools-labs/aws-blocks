---
"@aws-cdk-blocks/core": patch
"@aws-cdk-blocks/create-block": patch
---

Run the CDK commands of the sandbox, deploy and destroy scripts without a shell

The `cdk` children the lifecycle scripts start (`synth`, `deploy`, `watch`,
`destroy`) now always get their arguments as separate argv entries, never
through a shell. Only the sandbox's local dev-server command, which is a
configurable command line, still runs under a shell. `create-block` trims
trailing whitespace with `String.prototype.trimEnd()` when it wires a new
block's exports, with the same result.
