---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/bb-logger": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/bb-distributed-data": patch
---

Extend stack-wide `BlocksDefaults` (introduced in the Infrastructure Options work) with three additive fields, and adopt them across the Blocks-managed infrastructure. Each field is read independently via `option ?? scope.defaults.field` — a per-block option always wins, and no field is derived from another.

`@aws-blocks/core/cdk` now adds to `BlocksDefaults` (and both `BlocksPresets`):

- `logRetention: RetentionDays` — how long Blocks-managed CloudWatch log groups keep events. Preset sandbox `ONE_WEEK`, production `ONE_YEAR`.
- `throttling: { rateLimit, burstLimit }` — request-rate limits applied to every Blocks API Gateway stage. `200 / 400` in both presets.
- `accessLogging: boolean` — structured JSON access logs on every Blocks API Gateway stage. Preset sandbox `false`, production `true`.

Also newly exported from `@aws-blocks/core/cdk`: the `BlocksThrottling` type and `ensureApiGatewayAccount()` (provisions the account-level API Gateway CloudWatch Logs role once per stack). `Scope` gains a `handlerLogGroup` getter for the shared handler log group.

**Log retention** — Blocks-managed log groups now follow `defaults.logRetention` instead of AWS's infinite default: the shared handler Lambda (now owned by `BlocksStack`/`BlocksBackend` as `scope.handlerLogGroup`), the `bb-distributed-table` GSI-manager Lambdas, and the `bb-distributed-data` DSQL migration Lambda. `bb-logger` reconfigures the shared handler group's retention (`retention ?? defaults.logRetention`) rather than creating its own `/aws/lambda/<fn>` group.

**Throttling** — applied to the core REST API stage and the `bb-realtime` WebSocket stage. On a WebSocket stage the throttle unit is messages/second across the connection.

**Access logging** — when enabled, each stage writes structured JSON access logs to a dedicated CloudWatch log group (retention = `defaults.logRetention`, `RemovalPolicy.DESTROY`). The account-level API Gateway CloudWatch Logs role is provisioned once per stack and shared across stages.

Hosting adoption of these defaults (SSR REST API + compute log groups) ships in a separate change.
