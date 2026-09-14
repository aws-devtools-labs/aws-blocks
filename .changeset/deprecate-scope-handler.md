---
"@aws-blocks/core": minor
---

Deprecate the stack-level `handler` accessor (`BlocksStack.handler`, `BlocksBackend.handler`, and `Scope.handler`) ahead of the multi-compute model, and point IAM wiring at the shared execution role instead.

An app can run on more than one compute, so a single stack-level Lambda is no longer a reliable handle. `executionRole` — the one IAM role every compute assumes — is the durable replacement for permissions: a grant made on it applies no matter which compute ends up running the code.

- For grants and policies, use `executionRole`: `queue.grantSendMessages(blocksStack.executionRole)` and `blocksStack.executionRole.addToPrincipalPolicy(...)` replace the `handler` equivalents.
- Env vars still go through `handler.addEnvironment(...)`; a public per-compute configuration surface arrives with the compute-configuration work, and `handler` is removed only once that lands.

No runtime or infrastructure behavior changes — `handler` keeps working exactly as before, so this is documentation and guidance only. The `extending-with-existing-aws-resources` guide, its companion test apps, and core's README now demonstrate `executionRole` for IAM.
