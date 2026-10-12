---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/bb-lambda-compute": patch
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/create-block": patch
---

BREAKING: remove `BlocksStack.handler`, `BlocksBackend.handler`, and `Scope.handler`.

These returned the default compute's Lambda function, so anything wired through them reached only that one function — not every compute an app runs on. Use the stack-wide equivalents instead, which reach every compute:

| Before | After |
|---|---|
| `blocksStack.handler.addEnvironment('KEY', value)` | `registerConfig(blocksStack, 'KEY', value)` — loaded into `process.env` on every compute at cold start, before the backend module is imported |
| `resource.grantRead(blocksStack.handler)` | `resource.grantRead(blocksStack.executionRole)` |
| `blocksStack.handler.addToRolePolicy(statement)` | `blocksStack.executionRole.addToPrincipalPolicy(statement)` |
| `this.handler` inside a custom Building Block | `this.executionRole` / `registerConfig(this, …)` |
| `handler.addEnvironment('CORS_ALLOWED_ORIGINS', …)` | `defaults: { ...BlocksPresets.production, allowedOrigins: [...] }` |

`registerConfig` and `executionRole` are exported from `@aws-blocks/blocks/cdk` (and `@aws-blocks/core/cdk`). `registerConfig` now also works when called from app code after `BlocksStack.create()` / `BlocksBackend.create()` resolves, even if no Building Block registered config of its own: the config is deployed and wired then instead of the entry being dropped.
