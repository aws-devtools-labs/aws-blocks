# Metrics

Custom application metrics backed by Amazon CloudWatch (via Embedded Metric Format).

**When to use:** You need to track numeric measurements over time — request counts, error rates, latency, queue depths, business KPIs.

**When NOT to use:** If you need structured log output, use `Logger`. If you need distributed request tracing, use `Tracer`. If you need to store time-series data for querying, use `Database` or `KVStore`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick start

```typescript
import { Scope, ApiNamespace } from 'aws-cdk-blocks';
import { Metrics } from '@aws-cdk-blocks/bb-metrics';

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

All methods are synchronous: there is nothing to `await`.

### Options

| Option | Type | Description |
|--------|------|-------------|
| `namespace` | `string` | CloudWatch namespace. Defaults to the block's own `fullId` (the parent scope's `fullId`, a hyphen, then the block's `id`). |
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

## Errors

| Constant | `error.name` | Thrown when |
|----------|--------------|-------------|
| `MetricsErrors.InvalidMetricName` | `InvalidMetricNameException` | `emit` or `emitBatch`: a metric name is empty or exceeds 1024 characters. |
| `MetricsErrors.InvalidDimensions` | `InvalidDimensionsException` | `emit` or `emitBatch`: dimensions exceed 30 entries, or contain empty keys/values, or key/value exceeds 1024 chars. |
| `MetricsErrors.BatchTooLarge` | `BatchTooLargeException` | `emitBatch`: the batch contains more than 100 metrics. |
| `MetricsErrors.InvalidNamespace` | `InvalidNamespaceException` | `new Metrics(...)` at runtime and in local dev, not during CDK synthesis: the namespace is empty, exceeds 256 characters, contains a character outside `[a-zA-Z0-9._#:/ -]`, or starts with `AWS/`. |

```typescript
import { isBlocksError, MetricsErrors } from 'aws-cdk-blocks';

try {
  metrics.emit('', 1);
} catch (e: unknown) {
  if (isBlocksError(e, MetricsErrors.InvalidMetricName)) {
    // metric name is empty or exceeds 1024 characters
  }
}
```

## Examples

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

## What it provisions (AWS)

The CDK construct creates no AWS resources. The block exposes the resolved `namespace` and `defaultDimensions` as readonly properties.

EMF uses CloudWatch Logs (which Lambda already has permissions for), so no environment variable or `cloudwatch:PutMetricData` IAM grant is needed. CloudWatch namespaces are created implicitly on first metric data point arrival.

## Best practices

- Keep dimension cardinality low (avoid user IDs or request IDs as dimensions)

## Scaling and cost (AWS)

- **Ingestion:** CloudWatch accepts unlimited metrics via EMF — no API call limits
- **Standard resolution (60s):** Retained for 15 days at full resolution, then aggregated
- **High resolution (1s):** Retained for 3 hours at full resolution, then aggregated
- **Cost:** Scales with unique metric name + dimension combinations (~$0.30/metric/month)

## Local development

Locally, metrics are written as EMF JSON to stdout, the same format as on AWS. No metric data is persisted to disk.
