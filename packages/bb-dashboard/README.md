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

### Minimal (Lambda Health Only)

```typescript
import { Dashboard } from '@aws-blocks/bb-dashboard';

const dashboard = new Dashboard(scope, 'dashboard');
// After deploy: outputs URL to CloudWatch Dashboard with Lambda metrics
```

### With Observability BBs (Recommended)

```typescript
import { Logger } from '@aws-blocks/bb-logger';
import { Metrics } from '@aws-blocks/bb-metrics';
import { Tracer } from '@aws-blocks/bb-tracer';

const logger = new Logger(scope, 'logs');
const metrics = new Metrics(scope, 'metrics', { namespace: 'MyApp' });
const tracer = new Tracer(scope, 'tracing');

const dashboard = new Dashboard(scope, 'dashboard', {
  title: 'MyApp — Production',
  logger,
  metrics,
  tracer,
  metricConfigs: [
    { name: 'OrdersPlaced' },
    { name: 'Latency', stat: 'p99', period: 300, title: 'P99 Latency' },
    { name: 'CustomMetric', dimensions: { Service: 'API', Stage: 'prod' } },
  ],
});
```

The Dashboard extracts configuration directly from BB instances:
- **Metrics**: uses the BB's resolved `namespace` (which defaults to its scope `fullId` unless overridden) and `defaultDimensions` (automatically included in widget queries so they target the correct dimensioned metric stream)
- **Logger**: enables log widgets; log group derived from Lambda handler function name
- **Tracer**: presence implies X-Ray tracing is active

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

#### Observability BB Composition

| Option | Type | Description |
|--------|------|-------------|
| `logger` | `LoggerBBRef` | Logger BB instance — enables log query widgets |
| `metrics` | `MetricsBBRef` | Metrics BB instance — adds metric widgets (uses resolved `namespace` and `defaultDimensions`) |
| `tracer` | `TracerBBRef` | Tracer BB instance — enables X-Ray trace widgets |

#### Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `title` | `string` | `id` | Dashboard display title |
| `dashboardName` | `string` | `scope.fullId` | CloudWatch Dashboard name (max 255 characters, auto-truncated) |
| `metricConfigs` | `MetricConfig[]` | `[]` | Pre-registered metrics with optional custom stat/period/title |
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

| Widget | Source | Condition |
|--------|--------|-----------|
| Lambda Invocations | AWS/Lambda | Always |
| Lambda Errors | AWS/Lambda | Always |
| Lambda Duration (Avg + p99) | AWS/Lambda | Always |
| Concurrent Executions | AWS/Lambda | Always |
| Individual Metric Graph (per metric) | User namespace | `metrics` BB + `metricConfigs` |
| X-Ray Trace Table | X-Ray | `tracer` BB provided |
| Recent Errors (Log Insights) | Log group | `logger` BB provided |
| Log Volume | AWS/Logs | `logger` BB provided |

Rows collapse upward when their condition is not met.

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

When a `logger` BB instance is provided, the Dashboard derives the log group
name from the Lambda function name using the standard pattern:

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
  metrics,
  metricConfigs: [
    { name: 'OrdersPlaced' },  // queries with { service: 'orders', env: 'prod' }
    { name: 'Latency', dimensions: { endpoint: '/api' } },  // { service: 'orders', env: 'prod', endpoint: '/api' }
  ],
});
```
