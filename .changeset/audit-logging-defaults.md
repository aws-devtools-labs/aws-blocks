---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

fix(core): warn at synth when a durable stack disables API Gateway access logging

A synth-time warning now fires on every durable (non-`DESTROY` removal policy)
stack that has API Gateway access logging disabled — this includes the default
`BlocksPresets.production` posture, where `accessLogging` is off by default. The
warning id is `blocks:apigateway:access-logging-disabled`.

Because it is a warning, ordinary `cdk synth`/`deploy` still succeed, but
`cdk synth`/`deploy --strict` treat warnings as errors and fail until you either
opt in or acknowledge it.

Opt in by setting `accessLogging: true` in the backend's `defaults` (this also
turns on S3 server access logging for any FileBucket, each getting its own log
bucket). To keep it off deliberately, acknowledge the warning on the stack or
backend returned by `create()`, after it resolves:

```ts
const backend = await BlocksBackend.create(stack, 'Blocks', { /* … */ });
Annotations.of(backend).acknowledgeWarning('blocks:apigateway:access-logging-disabled');
```

Acknowledging on the `App` before `create()` does not suppress it.
