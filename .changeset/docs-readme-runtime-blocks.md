---
"@aws-cdk-blocks/bb-compute": patch
"@aws-cdk-blocks/bb-container-compute": patch
"@aws-cdk-blocks/bb-lambda-compute": patch
"@aws-cdk-blocks/bb-email-client": patch
"@aws-cdk-blocks/bb-async-job": patch
"@aws-cdk-blocks/bb-cron-job": patch
"@aws-cdk-blocks/bb-realtime": patch
"@aws-cdk-blocks/bb-dashboard": patch
"@aws-cdk-blocks/bb-logger": patch
"@aws-cdk-blocks/bb-metrics": patch
"@aws-cdk-blocks/bb-tracer": patch
"aws-cdk-blocks": patch
---

docs(compute, async, observability): the READMEs of 11 blocks correct wrong statements, list every error in one section, and the `bb-compute` README holds the `Compute` options, defaults, scaling rules and synth errors.

Corrections:

- `bb-cron-job`: no longer says a job with `enabled: false` can be triggered by hand. The schedule is deployed in the `DISABLED` state and does not fire, on AWS or locally. `InvalidSchedule` and `InvalidTimezone` are thrown at construction locally and at synth time on deploy. The local mock does not retry a failed handler and ignores the year field of a cron expression.
- `bb-compute`: `scaling.strategy` is one signal object or an array of them (`{ on: 'cpu', targetPercent }`, `{ on: 'memory', targetPercent }`, `{ on: 'queue-depth', backlogPerInstance }`), not a list of names. One table gives the default strategy for a compute that runs only jobs, no jobs, or jobs and an `ApiNamespace`.
- `bb-tracer`: `enabled: false` does not remove X-Ray cost while another `Tracer` in the app is enabled. The local mock samples by `samplingRate`; it does not record every trace.
- `bb-dashboard`: the `metrics` option takes `{ metrics, metricConfigs? }`, not a `Metrics` block. `dashboardName` defaults to the block's own `fullId`. The traces section exists only when the app has an enabled `Tracer`. Local development names `npm run sandbox` and `npm run deploy` instead of `npx cdk deploy`.
- `bb-metrics`: `namespace` defaults to the block's own `fullId`. `InvalidNamespace` is thrown by `new Metrics(...)` at runtime and in local dev, not during CDK synthesis.
- `bb-logger`: the retention example is a valid statement that keeps the sandbox preset for sandbox stacks. The level is set only through the `level` option.
- `bb-logger`, `bb-metrics`, `bb-tracer`: cross-references name the `Logger` and `Tracer` classes instead of `Logging` and `Tracing`.
- `bb-async-job`: the dead-letter queue is named `{fullId}-dlq`. Locally a failed delivery is retried immediately and an exhausted job is logged, not queued. On AWS the retry wait is `900 + maxBatchingWindowSeconds` seconds on a Lambda compute and about 2 minutes on a container compute.
- `bb-realtime`: `PublishFailed` is thrown when the callback URL or the connections table is unavailable, not when a delivery to one connection fails. `onDisconnect('error')` fires once per failed reconnect attempt (up to 5) and once more when the client gives up; a `refresh` times out after 15 seconds. `revokeAccess` is listed among the runtime-only methods. The reference to an `npm run test:e2e:sandbox` script is removed.
- `bb-email-client`: the "Package Export Conditions" section, which did not match the package manifest, is removed.
- `bb-lambda-compute`: the link to the `Compute` README is relative instead of pointing at the `main` branch.

Added:

- `bb-compute`: an options table per compute type with defaults (including `logRetention`), and `## Errors`, `## Scaling` and `## Container image` sections.
- Errors tables (constant, `error.name`, thrown when) in `bb-async-job` (with `InvalidOption`), `bb-cron-job` (with `ScheduleNotSupported`), `bb-realtime`, `bb-dashboard`, `bb-email-client` and `bb-metrics`.
- Options tables with defaults in `bb-realtime`, `bb-logger` and `bb-dashboard`; a `MetricsSource` table in `bb-dashboard`; a `waitUntilComplete()` options table in `bb-async-job`; a "Delivery and retries" table in `bb-cron-job`; a "Delivery guarantees" section in `bb-realtime`.

Moved:

- The option defaults, scaling rules, container image rules and error list of `bb-container-compute` and `bb-lambda-compute` are in the `bb-compute` README; the two READMEs link to it and keep what is specific to each package.
- `bb-email-client`: the API reference comes before the security section, which keeps its rules. `bb-realtime`: channel names, access rules and rate limits follow the API.

Removed:

- Sections that repeated facts stated elsewhere in the same README: "Quick Reference", "Compute Compatibility" and "Best Practices" in `bb-cron-job`; "Compute Compatibility" and "Other options" in `bb-async-job`; "Limits" in `bb-email-client`; "Log Level Precedence" and "Error Object Handling" in `bb-logger`; "Synchronous API Rationale" in `bb-metrics`; "Sampling" in `bb-tracer`.
- `bb-compute`: the note that type names are provisional. `bb-realtime`: the per-subscriber cost and latency tables (the formula stays) and the recommended channel-name limits (the enforced 1024-byte limit stays).
