---
"@aws-blocks/otel-common": minor
"@aws-blocks/bb-otel-metrics": minor
"@aws-blocks/bb-otel-logger": minor
"@aws-blocks/bb-otel-tracer": minor
"@aws-blocks/bb-dashboard": minor
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

Add an OpenTelemetry observability block family: `OtelMetrics`, `OtelLogger`, and
`OtelTracer`. These export vendor-neutral OpenTelemetry telemetry to Amazon CloudWatch's
native OTLP endpoints (or any OTLP backend) via an in-process OTel SDK and a standalone
OpenTelemetry Collector Lambda layer, with a per-invocation force-flush. They keep the
ergonomic API of the existing `Metrics`/`Logger`/`Tracer` blocks and additionally expose
OTel's typed instruments, span links/events, context propagation, and the raw
`Meter`/`Tracer`/`Logger` handles.

- New `@aws-blocks/otel-common` support package (in-process SDK bootstrap + flush,
  collector-config renderer, and the idempotent CDK infra helper).
- Telemetry follows OpenTelemetry semantic conventions: service identity is configured
  via `serviceName`/`serviceNamespace`/`serviceVersion` resource attributes (no
  "namespace"), and AWS Lambda resource attributes (`faas.*`, `cloud.*`,
  `aws.log.group.names`) are auto-detected in-process and queryable as `@resource.*`
  PromQL labels. `service.name` defaults to the Lambda function name, then
  `BLOCKS_STACK_NAME`, then the block's scope `fullId` (local dev).
- `OtelMetrics` exposes `emit` + typed OTel instruments; metric `unit` values are UCUM.
  (There is no `emitBatch`/`MetricDatum` — OTel batches at export, not at the API.)
- Provider escape hatch for OTel-compatible libraries: `getOtelMeterProvider()`,
  `getOtelTracerProvider()`, `getOtelLoggerProvider()` (plus the registered global providers).
- `@aws-blocks/bb-dashboard` gains PromQL `chart` widgets so OTLP metrics (which are
  PromQL-queryable, with no namespace) render correctly; classic `Metrics` dashboards are
  unaffected. `MetricsBBRef.namespace` is now optional.
- `@aws-blocks/core` flushes in-process OpenTelemetry telemetry after each invocation
  (no-op unless an OTel block is in use).
