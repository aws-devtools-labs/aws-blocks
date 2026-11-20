# @aws-cdk-blocks/bb-dashboard

Auto-generated CloudWatch Dashboard for application observability.

**When to use:** You want one URL that shows health, logs, traces and custom metrics for every compute of a deployed app, without building a CloudWatch dashboard by hand.

**When NOT to use:** You need custom visualizations or interactive data exploration: use the CloudWatch console.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Installation

```bash
npm install @aws-cdk-blocks/bb-dashboard
```

## Quick start

### Minimal

```typescript
import { Dashboard } from '@aws-cdk-blocks/bb-dashboard';

const dashboard = new Dashboard(scope, 'dashboard');
// After deploy: a CloudWatch Dashboard with a health + logs section for every
// compute in the app.
```

### With metrics + a Tracer (Recommended)

```typescript
import { Metrics } from '@aws-cdk-blocks/bb-metrics';
import { Tracer } from '@aws-cdk-blocks/bb-tracer';

new Tracer(scope, 'tracing');    // → traces section on every compute
const metrics = new Metrics(scope, 'metrics', { namespace: 'MyApp' });

const dashboard = new Dashboard(scope, 'dashboard', {
  title: 'MyApp — Production',
  // Display toggles (default true) applied to every compute section.
  logs: true,
  traces: true,
  // app-wide; pair each Metrics BB with its own metric names (per-namespace).
  // Also accepts an array of sources, one section per namespace.
  metrics: {
    metrics,
    metricConfigs: [
      { name: 'OrdersPlaced' },
      { name: 'Latency', stat: 'p99', period: 300, title: 'P99 Latency' },
      { name: 'CustomMetric', dimensions: { Service: 'API', Stage: 'prod' } },
    ],
  },
});
```

## API

```typescript
new Dashboard(scope: ScopeParent, id: string, options?: DashboardOptions)
```

**Properties:**

| Name | Type | Description |
|------|------|-------------|
| `url` | `string \| null` | CloudWatch Dashboard console URL (CfnOutput). `string` on the CDK construct; `null` in the default/mock type until deployed |
| `dashboardName` | `string` | The resolved dashboard name. In a deployed function it is `id`, not the `fullId`, when the `dashboardName` option is unset |

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `title` | `string` | `id` | Dashboard display title |
| `logs` | `boolean` | `true` | Show the logs section for each compute. `false` hides the section; logs are still captured |
| `traces` | `boolean` | `true` | Show each compute's traces section when the app has an enabled `Tracer`. Lambda computes support X-Ray; container computes do not. |
| `metrics` | `MetricsSource \| MetricsSource[]` | none | Metrics source(s); each renders one app-wide section for its namespace. See [`MetricsSource`](#metricssource) |
| `dashboardName` | `string` | the block's own `fullId` | CloudWatch Dashboard name. Characters other than ASCII letters, digits, `-`, and `_` become `-`; the result is truncated to 255 characters. |
| `defaultTimeRange` | `string` | `'-PT3H'` | Default time range (ISO 8601 duration) |
| `routePath` | `string \| false` | `'/cdk-blocks/dashboard'` | Route path for the redirect. Set to `false` to disable |

The dashboard covers every compute in the app; there is no option to select computes. It reads logs and traces from each compute, so you do not pass `Logger` or `Tracer` instances to it.

### `MetricsSource`

A `Metrics` block paired with the metrics to graph from its namespace.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `metrics` | `MetricsBBRef` | (required) | The `Metrics` block. Widgets query its `namespace` (its `namespace` option, or its own `fullId` when unset) and include its `defaultDimensions`, so they target the dimensioned stream the runtime emits to |
| `metricConfigs` | `MetricConfig[]` | `[]` | One graph widget per entry. Metric names are not discovered, so list each one. When omitted or empty, the source renders no metrics section |

```typescript
const metrics = new Metrics(scope, 'metrics', {
  namespace: 'MyApp/Orders',
  defaultDimensions: { service: 'orders', env: 'prod' },
});

const dashboard = new Dashboard(scope, 'dashboard', {
  metrics: {
    metrics,
    metricConfigs: [
      { name: 'OrdersPlaced' },  // queries with { service: 'orders', env: 'prod' }
      { name: 'Latency', dimensions: { endpoint: '/api' } },  // { service: 'orders', env: 'prod', endpoint: '/api' }
    ],
  },
});
// Dashboard uses 'MyApp/Orders' as the CloudWatch namespace
```

### `MetricConfig`

Configuration for a single pre-registered CloudWatch metric.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | (required) | CloudWatch metric name |
| `stat` | `'Sum' \| 'Average' \| 'Maximum' \| 'Minimum' \| 'p99' \| 'p95' \| 'p50'` | `'Sum'` | Aggregation statistic |
| `period` | `number` | `60` | Aggregation period in seconds (must be >= 1) |
| `title` | `string` | metric name | Widget title override |
| `dimensions` | `Record<string, string>` | undefined | Metric dimensions to narrow scope (e.g., `{ Service: 'API', Stage: 'prod' }`). Merged on top of the Metrics BB's `defaultDimensions` (per-metric wins on conflict) |

## Errors

```typescript
import { DashboardErrors } from 'aws-cdk-blocks';
```

| Constant | `error.name` | Thrown when |
|----------|--------------|-------------|
| `DashboardErrors.InvalidMetricConfig` | `InvalidMetricConfigException` | A `MetricConfig` has an empty `name` or a `period` below 1. Thrown during CDK synthesis while building widgets, not by the `Dashboard` constructor and not by the local mock |

## Auto-Generated Widgets

Grouped per compute, then an app-wide metrics section:

| Widget | Source | Condition |
|--------|--------|-----------|
| Lambda Invocations | AWS/Lambda | Per compute, always |
| Lambda Errors | AWS/Lambda | Per compute, always |
| Lambda Duration (Avg + p99) | AWS/Lambda | Per compute, always |
| Concurrent Executions | AWS/Lambda | Per compute, always |
| Traces | X-Ray on Lambda | With an enabled `Tracer`, unless `traces: false`. A container gets a placeholder widget, not X-Ray trace data. |
| Recent Errors (Log Insights) | The compute's own handler log group | Per compute, always (unless `logs: false`) |
| Log Volume | AWS/Logs | Per compute, always (unless `logs: false`) |
| Individual Metric Graph (per metric) | User namespace | App-wide, per `metrics` source + `metricConfigs` |

(Health widgets are Lambda-shaped for the default compute; other compute types report their own health metrics.)

## Dashboard Redirect Route

The Dashboard BB registers a `GET` route (default: `/cdk-blocks/dashboard`). Set `routePath: false` to disable it.

- **In AWS:** Redirects to the full CloudWatch console URL (requires AWS login).
- **In local dev:** Serves a local observability page without AWS credentials or a deployment.

```typescript
// Custom route path
const dashboard = new Dashboard(scope, 'dashboard', {
  routePath: '/ops/dashboard',
});
// GET /ops/dashboard → 302 → https://<region>.console.aws.amazon.com/cloudwatch/...
```

## Local development

Run `npm run dev` and open `/cdk-blocks/dashboard` on the dev server. The page lists configured metric names by namespace and points to the terminal for logs and metric values and `.cdk-blocks/local/data/` for saved traces. It also shows how to launch the separate, session-protected Admin UI. Live CloudWatch charts are available only on the deployed dashboard.

## Scaling and cost (AWS)

- **Free tier:** Up to 3 dashboards with 50 metrics each
- **Beyond free tier:** $3/dashboard/month
- **No runtime cost:** the dashboard makes no API calls at request time
