# OTel Metrics

Custom application metrics via OpenTelemetry, exported to Amazon CloudWatch's native
OTLP endpoint (PromQL-queryable) through an in-process OTel SDK and a standalone
OpenTelemetry Collector Lambda layer. Part of the OTel building-block family alongside
`@aws-blocks/bb-otel-logger` and `@aws-blocks/bb-otel-tracer`.

> **Recommended for new applications.** This is the preferred metrics block — it's
> vendor-neutral (OTLP to CloudWatch or any backend) and offers typed OTel instruments.

**When to use:** the default for application metrics. You get OTel instrument semantics
(monotonic counters, histograms, async gauges) and can point telemetry at CloudWatch or any
third-party OTLP backend. Choose the AWS-native `Metrics` block only if you specifically need
CloudWatch Embedded Metric Format (EMF) / classic namespace+dimension metrics.

## API

```typescript
const metrics = new OtelMetrics(scope, id, options?)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `emit(name, value, options?)` | `void` | Record an additive data point (mapped onto an OTel Counter). |
| `flush()` | `void` | No-op; the SDK is force-flushed by the runtime before the handler returns. |
| `child(attributes)` | `OtelMetricsEmitter` | Child emitter with merged default attributes. |
| `counter/histogram/upDownCounter/observableGauge(name, …)` | instrument | Typed OTel instruments. |
| `rawMeter` | `Meter` | The underlying OTel `Meter` — full escape hatch. |

> There is **no `emitBatch`** — OpenTelemetry batches at *export* time (the SDK's periodic
> reader), so calling `emit` repeatedly is the idiom; there's no per-call batch API.

### Options

| Option | Type | Description |
|--------|------|-------------|
| `serviceName` | `string` | `service.name` resource attribute (semconv). Process-wide. Defaults to the Lambda function name (`AWS_LAMBDA_FUNCTION_NAME`), then `BLOCKS_STACK_NAME`, then `scope.fullId` (local dev). |
| `serviceNamespace` | `string` | `service.namespace` resource attribute — a grouping for related services. |
| `serviceVersion` | `string` | `service.version` resource attribute. |
| `meterName` | `string` | Instrumentation scope (OTel Meter name; `@instrumentation.@name` in PromQL). Defaults to `scope.fullId`. |
| `defaultAttributes` | `Record<string,string>` | Attributes applied to every metric (per-emit wins). |
| `logger` | `ChildLogger` | Optional internal logger (defaults to error level). |

**Units are [UCUM](https://ucum.org/)** (OTel requirement): `'1'` (count/dimensionless),
`'s'`, `'ms'`, `'us'`, `'By'` (bytes), `'%'` — passed straight to the instrument's `unit`.
There is no "namespace" — service identity lives in the resource attributes above
(per the [OTel service semantic conventions](https://opentelemetry.io/docs/specs/semconv/resource/service/)).

## Resource attributes & automatic Lambda enrichment

Telemetry is tagged with semconv **resource attributes**: your `service.*` identity plus
AWS Lambda attributes detected automatically by the in-process SDK
(`@opentelemetry/resource-detector-aws`) — `cloud.provider`, `cloud.platform`,
`cloud.region`, `faas.name`, `faas.version`, `faas.max_memory`, `faas.instance`,
`aws.log.group.names`. No extra IAM and no collector processor required (the lambda
collector layer doesn't ship `resourcedetection` — see OTel contrib #17584). In CloudWatch
these are queryable as `@resource.<attr>` PromQL labels (e.g. `@resource.faas.name`,
`@resource.service.name`).

## CloudWatch & the Dashboard

OTLP metrics are **PromQL-queryable**, not classic namespace/dimension metrics — they
do not appear in `cloudwatch:ListMetrics`. The `Dashboard` block renders PromQL `chart`
widgets for `OtelMetrics` instances (selecting by metric name + optional `@resource.*`
filters). Requires no extra setup beyond `cloudwatch:PutMetricData`, granted automatically.

## Interop: using an OTel-compatible library

To feed a third-party OTel library into the same pipeline, hand it the provider:

```typescript
import { getOtelMeterProvider } from '@aws-blocks/otel-common';

someLib.init({ meterProvider: getOtelMeterProvider() });
// the library names its own meter: meterProvider.getMeter('their-lib', '1.0')
```

Libraries that use `@opentelemetry/api`'s **global** `metrics.getMeter()` work with no
wiring at all — the block registers the global provider on init.

## Local development

Metrics are exported to stdout via the OTel `ConsoleMetricExporter` (no collector
locally). The real `@opentelemetry/api` Meter call path and `rawMeter` escape hatch
behave identically to production.
