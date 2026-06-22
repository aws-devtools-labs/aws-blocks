# Metrics

Custom application metrics backed by Amazon CloudWatch (via Embedded Metric Format).

**When to use:** You need to track numeric measurements over time — request counts, error rates, latency, queue depths, business KPIs. Good for dashboards, alarms, and operational visibility.

> **Recommended:** Prefer `OtelMetrics` (`@aws-blocks/bb-otel-metrics`) for new applications — it is vendor-neutral OpenTelemetry, exports OTLP to CloudWatch (or any backend), and offers typed instruments (counters, histograms, gauges). Use this AWS-native EMF `Metrics` block when you specifically want CloudWatch Embedded Metric Format and classic namespace/dimension metrics.

**When NOT to use:** If you need structured log output, use `Logging`. If you need distributed request tracing, use `Tracing`. If you need to store time-series data for querying, use `Database` or `DistributedTable`. For vendor-neutral OpenTelemetry metrics (the recommended default), use `OtelMetrics`.

## API

```typescript
const metrics = new Metrics(scope, id, options?)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `emit(name, value, options?)` | `void` | Record a single metric data point via EMF. |
| `emitBatch(metrics)` | `void` | Record multiple metric data points in one EMF document (max 100). |
| `flush()` | `void` | No-op (EMF writes are immediate). Provided for interface compatibility. |
| `child(dimensions)` | `MetricsEmitter` | Create a child emitter with inherited namespace and merged dimensions. |
| `Metrics.fromExisting(namespace)` | `ExternalMetricsRef` | Wrap a pre-existing CloudWatch namespace. |

### Options

| Option | Type | Description |
|--------|------|-------------|
| `namespace` | `string` | CloudWatch namespace. Defaults to `scope.fullId`. |
| `defaultDimensions` | `Record<string, string>` | Dimensions applied to every emit. Per-emit dimensions merge on top (per-emit wins on conflict). |
| `metrics` | `ExternalMetricsRef` | Wrap an existing CloudWatch namespace instead of creating one. When set, `namespace` is ignored. |
| `logger` | `ChildLogger` | Optional logger for internal operations. When omitted, a default Logger at error level is created. |

### EmitOptions

| Option | Type | Description |
|--------|------|-------------|
| `unit` | `MetricUnit` | Unit of the metric value. Defaults to `'None'`. |
| `dimensions` | `Record<string, string>` | Dimensions for this data point (max 30 total including defaults). |
| `timestamp` | `Date` | Timestamp for the data point. Defaults to now. |
| `resolution` | `MetricResolution` | `'standard'` (60s, default) or `'high'` (1s, higher cost). |

### MetricUnit

```typescript
type MetricUnit =
  | 'Count' | 'Seconds' | 'Milliseconds' | 'Microseconds'
  | 'Bytes' | 'Kilobytes' | 'Megabytes' | 'Gigabytes'
  | 'Percent' | 'Bits/Second' | 'None';
```

### Error Handling

```typescript
import { isBlocksError } from '@aws-blocks/core';
import { MetricsErrors } from '@aws-blocks/bb-metrics';

try {
  metrics.emit('', 1);
} catch (e: unknown) {
  if (isBlocksError(e, MetricsErrors.InvalidMetricName)) {
    // metric name is empty or exceeds 1024 characters
  }
}
```

| Error | Condition |
|-------|-----------|
| `MetricsErrors.InvalidMetricName` | Metric name is empty or exceeds 1024 characters. |
| `MetricsErrors.InvalidDimensions` | Dimensions exceed 30 entries, or contain empty keys/values, or key/value exceeds 1024 chars. |
| `MetricsErrors.BatchTooLarge` | Batch contains more than 100 metrics. |
| `MetricsErrors.InvalidNamespace` | Namespace is empty, too long, contains invalid characters, or uses reserved `AWS/` prefix. |

## Examples

### Basic Usage

```typescript
import { Scope, ApiNamespace } from '@aws-blocks/blocks';
import { Metrics } from '@aws-blocks/bb-metrics';

const scope = new Scope('my-app');
const metrics = new Metrics(scope, 'appMetrics', {
  namespace: 'MyApp/Orders',
  defaultDimensions: { service: 'orders' },
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async handleRequest() {
    metrics.emit('RequestCount', 1, { unit: 'Count' });
    metrics.emit('Latency', 42, { unit: 'Milliseconds' });
    return { ok: true };
  },
}));
```

### Emit with Dimensions

```typescript
metrics.emit('RequestCount', 1, {
  unit: 'Count',
  dimensions: { endpoint: '/api/users', method: 'GET' },
});
```

### Batch Emit

```typescript
metrics.emitBatch([
  { name: 'RequestCount', value: 1, unit: 'Count' },
  { name: 'Latency', value: 42, unit: 'Milliseconds' },
  { name: 'ErrorCount', value: 0, unit: 'Count' },
]);
```

### Child Emitters (Scoped Dimensions)

```typescript
const requestMetrics = metrics.child({ endpoint: '/api/users', method: 'GET' });
requestMetrics.emit('RequestCount', 1);
requestMetrics.emit('Latency', 35, { unit: 'Milliseconds' });
```

Children inherit the parent's namespace and default dimensions, merging their own on top. Children can be nested arbitrarily.

### Wrapping an Existing Namespace

```typescript
const legacy = new Metrics(scope, 'legacy', {
  metrics: Metrics.fromExisting('MyOrg/SharedMetrics'),
});
legacy.emit('MigrationCount', 1);
```

### High-Resolution Metrics

```typescript
metrics.emit('CPUSpike', 95.2, {
  unit: 'Percent',
  resolution: 'high', // 1-second aggregation
});
```

## CDK Configuration

The CDK construct creates no AWS resources. It only resolves and exposes the `namespace` and `defaultDimensions` as readonly properties for CDK-time consumers.

EMF uses CloudWatch Logs (which Lambda already has permissions for), so no environment variable or `cloudwatch:PutMetricData` IAM grant is needed. CloudWatch namespaces are created implicitly on first metric data point arrival.

## Synchronous API Rationale

All metric methods return `void`, not `Promise<void>`. This is intentional:

- **EMF writes to stdout** — `process.stdout.write()` is a synchronous, non-blocking call on Linux. The kernel buffers the write and Lambda's logging agent captures it asynchronously.
- **No network I/O** — Unlike `PutMetricData` (which makes an HTTP call to CloudWatch), EMF piggybacks on CloudWatch Logs, which Lambda already streams. There is nothing to `await`.
- **Zero overhead** — Returning a Promise would add microtask scheduling overhead for zero benefit. Metrics should be as cheap as a `console.log`.
- **Fire-and-forget semantics** — Metrics are observability data, not business-critical writes. If a metric fails to emit (e.g., stdout is closed), it should not crash the request.

This design means you can emit metrics anywhere — in hot loops, synchronous callbacks, or error handlers — without worrying about async context or unhandled promise rejections.

## Best Practices

- Keep dimension cardinality low (avoid user IDs or request IDs as dimensions)
- Use consistent metric names across your application
- Use `defaultDimensions` for shared context (service name, environment)
- Prefer `emitBatch` when recording multiple metrics in a single request
- Use units to enable automatic conversions in CloudWatch dashboards
- Use `child()` to avoid repeating dimensions across related metrics

## Scaling & Cost (AWS)

- **Ingestion:** CloudWatch accepts unlimited metrics via EMF — no API call limits
- **Standard resolution (60s):** Retained for 15 days at full resolution, then aggregated
- **High resolution (1s):** Retained for 3 hours at full resolution, then aggregated
- **Cost:** Scales with unique metric name + dimension combinations (~$0.30/metric/month)
- **Latency:** EMF adds zero latency to the request (stdout write is non-blocking)

## Local Development

Metrics are written as EMF JSON to stdout — the same format as AWS. In local dev, you can see metric emissions in the terminal output. No disk persistence — metrics are ephemeral locally (unlike KVStore or DistributedTable which persist to `.bb-data/`).

Delete nothing to reset — there's no local state to clear.



