# @aws-blocks/bb-dashboard

Auto-generated CloudWatch Dashboard for application observability.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## When to Use

- You've deployed your app and want a single URL to view application health
- You want pre-configured widgets without manually creating CloudWatch dashboards
- You need a team dashboard for deployment validation and operational awareness

## When NOT to Use

- You need custom visualizations or interactive data exploration → use CloudWatch console

## Installation

```bash
npm install @aws-blocks/bb-dashboard
```

## Quick Start

### Minimal (default compute)

```typescript
import { Dashboard } from '@aws-blocks/bb-dashboard';

const dashboard = new Dashboard(scope, 'dashboard');
// After deploy: a CloudWatch Dashboard with a health section for the default compute.
```

### With Observability BBs (Recommended)

The dashboard is organized **by compute**. It renders a group per compute passed
via `computes` (defaulting to the app's default compute when omitted). Logs and
traces appear automatically for any compute that has a `Logger` / `Tracer`
attached — you do **not** pass those to the dashboard. **Metrics** are app-scoped
(a namespace isn't tied to a compute), so they're passed explicitly, one section
per namespace.

```typescript
import { Logger } from '@aws-blocks/bb-logger';
import { Metrics } from '@aws-blocks/bb-metrics';
import { Tracer } from '@aws-blocks/bb-tracer';

new Logger(scope, 'logs');       // → this compute's logs section
new Tracer(scope, 'tracing');    // → this compute's traces section
const metrics = new Metrics(scope, 'metrics', { namespace: 'MyApp' });

const dashboard = new Dashboard(scope, 'dashboard', {
  title: 'MyApp — Production',
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

How the dashboard resolves each section:
- **Health** — one section per compute, always shown.
- **Logs** — shown for a compute when a `Logger` is attached to it (the compute self-reports via `loggerEnabled`); log group derived from that compute's function name.
- **Traces** — shown for a compute when a `Tracer` is attached to it (`tracerEnabled`).
- **Metrics** — app-wide, from the `metrics` option: uses each BB's resolved `namespace` (defaults to its scope `fullId`) and `defaultDimensions` (included in widget queries so they target the correct dimensioned stream).

## API Reference

### `new Dashboard(scope, id, options?)`

Creates a CloudWatch Dashboard with auto-generated widgets.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `scope` | `ScopeParent` | Yes | Parent scope (Scope instance or BlocksStack) |
| `id` | `string` | Yes | Unique identifier |
| `options` | `DashboardOptions` | No | Configuration |

**Properties:**

| Name | Type | Description |
|------|------|-------------|
| `url` | `string \| null` | CloudWatch Dashboard console URL (CfnOutput). `string` on the CDK construct; `null` in the default/mock type until deployed |
| `dashboardName` | `string` | The resolved dashboard name |

### `DashboardOptions`

#### Observability composition

Logs and traces are **not** options — they appear automatically for any compute
with a `Logger` / `Tracer` attached. You pass the computes to show and the
metrics (app-scoped) here.

| Option | Type | Description |
|--------|------|-------------|
| `computes` | `Compute \| Compute[]` | Compute(s) to render, one group each. Defaults to the app's default compute when omitted |
| `metrics` | `MetricsSource \| MetricsSource[]` | Metrics source(s) — each pairs a Metrics BB with its own `metricConfigs`; one app-wide section per namespace |

#### Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `title` | `string` | `id` | Dashboard display title |
| `dashboardName` | `string` | `scope.fullId` | CloudWatch Dashboard name (max 255 characters, auto-truncated) |
| `defaultTimeRange` | `string` | `'-PT3H'` | Default time range (ISO 8601 duration) |
| `routePath` | `string \| false` | `'/aws-blocks/dashboard'` | Route path for the redirect. Set to `false` to disable |

### `MetricConfig`

Configuration for a single pre-registered CloudWatch metric.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | (required) | CloudWatch metric name |
| `stat` | `'Sum' \| 'Average' \| 'Maximum' \| 'Minimum' \| 'p99' \| 'p95' \| 'p50'` | `'Sum'` | Aggregation statistic |
| `period` | `number` | `60` | Aggregation period in seconds (must be >= 1) |
| `title` | `string` | metric name | Widget title override |
| `dimensions` | `Record<string, string>` | undefined | Metric dimensions to narrow scope (e.g., `{ Service: 'API', Stage: 'prod' }`) |

## Error Constants

```typescript
import { DashboardErrors } from '@aws-blocks/bb-dashboard';

DashboardErrors.InvalidMetricConfig // 'InvalidMetricConfigException'
```

- `InvalidMetricConfig`: Thrown when a metric configuration is invalid (e.g., empty name or invalid period).

> Note: `InvalidMetricConfig` is thrown during CDK synthesis while building widgets, not by the mock/runtime `Dashboard` constructor.

## Auto-Generated Widgets

The following widgets are always included:

Grouped per compute, then an app-wide metrics section:

| Widget | Source | Condition |
|--------|--------|-----------|
| Lambda Invocations | AWS/Lambda | Per compute, always |
| Lambda Errors | AWS/Lambda | Per compute, always |
| Lambda Duration (Avg + p99) | AWS/Lambda | Per compute, always |
| Concurrent Executions | AWS/Lambda | Per compute, always |
| X-Ray Trace Table | X-Ray | Per compute, when a `Tracer` is attached to it |
| Recent Errors (Log Insights) | Log group | Per compute, when a `Logger` is attached to it |
| Log Volume | AWS/Logs | Per compute, when a `Logger` is attached to it |
| Individual Metric Graph (per metric) | User namespace | App-wide, per `metrics` source + `metricConfigs` |

(Health widgets are Lambda-shaped for the default compute; other compute types report their own health metrics.)

## Dashboard Redirect Route

The Dashboard BB registers a `GET` route (default: `/aws-blocks/dashboard`) that 302-redirects
to the CloudWatch Dashboard console URL. This provides a convenient, discoverable
entry point for developers. Set `routePath: false` to disable.

- **In AWS:** Redirects to the full CloudWatch console URL (requires AWS login).
- **In local dev:** Returns 503 with a message to deploy first.

```typescript
// Custom route path
const dashboard = new Dashboard(scope, 'dashboard', {
  routePath: '/ops/dashboard',
});
// GET /ops/dashboard → 302 → https://<region>.console.aws.amazon.com/cloudwatch/...
```

## Auto-Derived Log Group Name

When a `Logger` is attached to a compute, that compute's log section derives the
log group name from its Lambda function name using the standard pattern:

```
/aws/lambda/{functionName}
```

This means log widgets appear automatically when a Logger BB is connected.

## Local Development

In local dev mode, the mock registers the redirect route but returns 503
(since no CloudWatch Dashboard exists locally):

```
[Dashboard] Dashboard BB: no-op in local mode (CloudWatch Dashboard is a cloud-only resource).
Will create CloudWatch Dashboard 'My App' on deploy. Run 'npx cdk deploy' to view.

📍 Local observability data:
   • Logs: Check your terminal output - Logger BB writes structured JSON to stdout
   • Metrics: Metrics BB writes EMF-formatted JSON to stdout (visible in terminal)
   • Traces: Tracer stores mock traces to .bb-data/ and logs them to stdout
```

## Scaling & Cost

- **Free tier:** Up to 3 dashboards with 50 metrics each
- **Beyond free tier:** $3/dashboard/month
- **No runtime cost:** Dashboards are static read-only views
- **No API calls at request time**

## Namespace Resolution

The metrics namespace is read from the Metrics BB's `namespace` property.
The Metrics BB resolves this internally from its options (explicit `namespace` or fallback to scope `fullId`).

```typescript
const metrics = new Metrics(scope, 'metrics', { namespace: 'MyApp/Orders' });
const dashboard = new Dashboard(scope, 'dashboard', { metrics });
// Dashboard uses 'MyApp/Orders' as the CloudWatch namespace
```

## Default Dimensions

When a Metrics BB has `defaultDimensions` configured, the Dashboard automatically includes
those dimensions in widget queries. This ensures widgets target the same dimensioned metric
stream that the runtime emits to. Per-metric dimensions in `MetricConfig` are merged on top
(per-metric wins on conflict).

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
```
