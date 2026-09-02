---
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/bb-lambda-compute": patch
"@aws-blocks/bb-agent": patch
"@aws-blocks/blocks": patch
---

refactor: route event-block resources to their resolved compute

AsyncJob, CronJob, and Realtime now attach their compute-bound resources to the
compute resolved via `this.compute` instead of the stack's shared handler:

- AsyncJob attaches its SQS event source to the compute's function;
- CronJob points its EventBridge Scheduler target at the compute's function;
- Realtime wires its shared WebSocket API integrations to the compute's function.

All three require a `LambdaCompute` today and fail at synth with a clear error
on any other compute type — AsyncJob now guards this the same way CronJob and
Realtime do, instead of silently skipping its event source (which would have
left submitted jobs with nothing to consume them).

On the default single-Lambda setup `this.compute` resolves to the stack's default
compute, whose function is the shared handler — so this is non-breaking with no
change to synthesized infrastructure. AsyncJob also grants SQS send to the shared
execution role rather than the handler directly.

`@aws-blocks/bb-lambda-compute` adds a `./cdk` subpath that exposes the CDK-typed
`LambdaCompute`, letting framework blocks reference its `fn` at synth time.

`@aws-blocks/bb-agent` builds AsyncJob and Realtime internally, so its CDK test
is moved onto the `BlocksStack.create` harness (which initializes the default
compute the blocks now resolve) instead of a handler-only stub. Test-only
change — no runtime behavior change to the Agent.
