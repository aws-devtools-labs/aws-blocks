---
"@aws-blocks/core": minor
"@aws-blocks/bb-async-job": minor
"@aws-blocks/bb-cron-job": minor
"@aws-blocks/bb-realtime": minor
"@aws-blocks/bb-lambda-compute": minor
"@aws-blocks/bb-agent": patch
"@aws-blocks/blocks": minor
---

feat: route event-block resources to their resolved compute

AsyncJob, CronJob, and Realtime now attach their compute-bound resources to a
compute resolved at synth rather than the stack's shared handler:

- AsyncJob attaches its SQS event source to the resolved compute's function;
- CronJob points its EventBridge Scheduler target at the resolved compute's function;
- Realtime binds its shared WebSocket API integrations to the stack's **default**
  compute (its routes are a stack-level singleton) and grants `postToConnection`
  to the shared execution role, so `publish()` works from any compute.

Each block requires a Lambda compute today and fails at synth with a typed
`UnsupportedCompute` error (assertable via `isBlocksError`) on any other type.
The check uses a duplicate-copy-safe brand (`LambdaCompute.isLambdaCompute`,
backed by a `Symbol.for` marker) instead of `instanceof`, so it does not misfire
when two copies of `bb-lambda-compute` resolve in one dependency tree.

On the default single-Lambda setup the resolved/default compute is the stack's
default, whose function is the shared handler — so this is non-breaking with no
change to synthesized infrastructure. AsyncJob also grants SQS send to the shared
execution role rather than the handler directly.

New public surface (hence `minor`):

- `@aws-blocks/core` exports `blocksError(name, message)` (the producer half of
  the `isBlocksError` contract) and `sanitizeConfigKey(id)` from `./bb-utils`
  (the single env-var-key sanitizer both config writers and runtime readers use).
- `@aws-blocks/bb-lambda-compute` adds a `./cdk` subpath exposing the CDK-typed
  `LambdaCompute` and its `LambdaCompute.isLambdaCompute` guard.
- `bb-async-job` / `bb-cron-job` / `bb-realtime` add an `UnsupportedCompute`
  error member.

`@aws-blocks/bb-agent` builds AsyncJob and Realtime internally, so its CDK test
moves onto the `BlocksStack.create` harness instead of a handler-only stub.
Test-only change — no runtime behavior change to the Agent.
