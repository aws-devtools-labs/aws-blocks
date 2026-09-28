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

### Minimal

```typescript
import { Dashboard } from '@aws-blocks/bb-dashboard';

const dashboard = new Dashboard(scope, 'dashboard');
// After deploy: a CloudWatch Dashboard with a health + logs section for every
// compute in the app.
```

### With metrics + a Tracer (Recommended)

The dashboard is organized **by compute** — each compute in the app is a group.
Every group shows a **health** section and a **logs** section (logs are always
captured). A **traces** section appears when the app contains a `Tracer` (tracing
is presence-gated: any Tracer turns on X-Ray for every compute). You do **not**
pass Logger / Tracer instances to the dashboard. **Metrics** are app-scoped (a
namespace isn't tied to a compute), so they're passed explicitly, one section
per namespace.

```typescript
import { Metrics } from '@aws-blocks/bb-metrics';
import { Tracer } from '@aws-blocks/bb-tracer';

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

How the dashboard resolves each section:
- **Health** — the compute's health section, always shown.
- **Logs** — shown for every compute (logs are always captured); log group is the compute's own handler log group. Suppress with `logs: false`.
- **Traces** — shown for a compute when tracing is enabled on it (the app contains a `Tracer`). Suppress with `traces: false`.
- **Metrics** — app-wide, from the `metrics` option: uses each BB's resolved `namespace` (defaults to its scope `fullId`) and `defaultDimensions` (included in widget queries so they target the correct dimensioned stream).
- **Compute coverage** — always **every** compute in the app (one today). No compute selector is exposed yet.

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

#### Display toggles

Logs and traces are section **display toggles**, not composition inputs — the
dashboard reads each compute's state directly. Logs are always captured (so
`logs` only hides the section); traces exist only when the app has a `Tracer`
(so `traces` only hides an otherwise-present section).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `logs` | `boolean` | `true` | Show the logs section for each compute |
| `traces` | `boolean` | `true` | Show the traces section for each compute (only ever present when the app has a `Tracer`) |

The dashboard always covers **every** compute in the app. There is no compute
selector yet — one arrives with the multi-compute customer surface (it would
otherwise leak an internal type before customers can construct a compute).

#### Metrics composition

| Option | Type | Description |
|--------|------|-------------|
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
| X-Ray Trace Table | X-Ray | Per compute, when the app has a `Tracer` (unless `traces: false`) |
| Recent Errors (Log Insights) | Log group | Per compute, always (unless `logs: false`) |
| Log Volume | AWS/Logs | Per compute, always (unless `logs: false`) |
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

## Log Group

Each compute's log section queries that compute's own handler log group (the
framework-owned group the compute provisions). Logs are always captured, so the
log widgets appear for every compute unless you set `logs: false`.

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
