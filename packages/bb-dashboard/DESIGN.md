# Dashboard — Design

Design document for Dashboard. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-dashboard`
**Type:** Primitive (creates new infrastructure)
**AWS Service:** Amazon CloudWatch Dashboards

## API Surface

```typescript
/**
 * Auto-generated CloudWatch Dashboard composing Metrics, Logger, and Tracer BBs.
 *
 * **When to use:** You want operational visibility into your deployed application
 * without manually creating CloudWatch dashboards. Good for monitoring request
 * rates, error counts, latency, and Lambda health.
 *
 * **When NOT to use:** If you need fully custom dashboards with specific widget
 * layouts, use the CloudWatch console directly. If you need an admin UI for
 * data inspection, use `AdminSite`.
 *
 * **Best practices:**
 * - Connect all three observability BBs (Metrics, Logger, Tracer) for full visibility
 * - Use `title` to distinguish dashboards in multi-stage deployments
 * - Keep the default widget set for standard apps; use `widgets` only for custom additions
 *
 * **Scaling:** CloudWatch Dashboards are free for up to 3 dashboards (50 metrics
 * each). Beyond that, $3/dashboard/month. No runtime cost — dashboards are
 * read-only views over existing CloudWatch data.
 */
class Dashboard extends Scope {
	/**
	 * CloudWatch Dashboard console URL (contains CDK tokens until deployment).
	 *
	 * During CDK synthesis this is an unresolved token (e.g., `https://${AWS::Region}...`).
	 * The actual URL is resolved at deployment time and exported as a CfnOutput.
	 * Use the CfnOutput value (visible in `cdk deploy` output or CloudFormation console)
	 * rather than reading this property at synthesis time.
	 */
	readonly url: string;

	/**
	 * The resolved CloudWatch Dashboard name.
	 * Derived from the `dashboardName` option or falling back to the construct ID.
	 */
	readonly dashboardName: string;

	/**
	 * Create an auto-generated observability dashboard.
	 *
	 * @param scope - Parent scope.
	 * @param id - Unique identifier within the parent scope.
	 * @param options - Dashboard configuration.
	 *
	 * @example
	 * ```typescript
	 * // Minimal: auto-generates Lambda health widgets
	 * const dashboard = new Dashboard(scope, 'dashboard');
	 * ```
	 *
	 * @example
	 * ```typescript
	 * // Compose with observability BBs
	 * const logger = new Logger(scope, 'logs');
	 * const metrics = new Metrics(scope, 'metrics', { namespace: 'MyApp' });
	 * const tracer = new Tracer(scope, 'tracing');
	 *
	 * const dashboard = new Dashboard(scope, 'dashboard', {
	 *   logger,
	 *   metrics,
	 *   tracer,
	 * });
	 * ```
	 */
	constructor(scope: ScopeParent, id: string, options?: DashboardOptions);
}

interface DashboardOptions {
	/**
	 * Dashboard display title. Shown in CloudWatch console and as the page heading.
	 * @default Derived from scope fullId (e.g., 'myapp-dashboard')
	 */
	title?: string;

	// ── Observability BB composition ──────────────────────────────────────────
	// Pass real BB instances for type-safe integration.
	// Uses structural typing — any object with `fullId` satisfies the interface.

	/**
	 * Logger Building Block instance.
	 * Enables log query widgets. Log group derived from Lambda handler function name.
	 */
	logger?: LoggerBBRef;

	/**
	 * Metrics Building Block instance.
	 * Adds metric widgets using the BB's resolved CloudWatch `namespace`.
	 */
	metrics?: MetricsBBRef;

	/**
	 * Tracer Building Block instance.
	 * Presence implies X-Ray tracing is active; enables trace widgets.
	 */
	tracer?: TracerBBRef;

	// ── Configuration ──────────────────────────────────────────────

	/**
	 * Pre-registered metrics to create widgets for on first deploy.
	 *
	 * CloudWatch cannot list metrics that haven't been emitted yet. Without this,
	 * custom metric widgets only appear after the app has emitted data. Providing
	 * metrics here creates widgets immediately, showing "Insufficient data"
	 * until the first emission.
	 *
	 * Each metric can be configured with custom stat/period or use defaults (Sum, 60s).
	 * Dimensions can be used to narrow the metric scope to specific resources.
	 * Used when `metrics` BB is provided.
	 *
	 * @example
	 * ```typescript
	 * metricConfigs: [
	 *   { name: 'RequestCount' },
	 *   { name: 'Latency', stat: 'p99', period: 300 },
	 *   { name: 'CustomMetric', dimensions: { Service: 'API', Stage: 'prod' } },
	 * ]
	 * ```
	 */
	metricConfigs?: MetricConfig[];

	/**
	 * Time range for the dashboard view.
	 * @default '-PT3H' (last 3 hours)
	 */
	defaultTimeRange?: string;

	/**
	 * Route path for the dashboard redirect endpoint.
	 * When set to a string, registers a RawRoute at this path that 302-redirects
	 * to the CloudWatch Dashboard console URL.
	 * Set to `false` to disable the route entirely (URL is still available via CfnOutput).
	 *
	 * The redirect requires AWS Console login to view the dashboard —
	 * exposing the URL alone grants no data access.
	 *
	 * @default '/aws-blocks/dashboard'
	 */
	routePath?: string | false;
}
```

## Error Constants

```typescript
export const DashboardErrors = {
  InvalidMetricConfig: 'InvalidMetricConfigException',
} as const;
```

One error constant is exported:
- **InvalidMetricConfig** — Thrown when a metric configuration is invalid (empty name, invalid period, etc.)

## Design Decisions

### D-DB-1: Structural typing for observability BB composition

**Decision:** `options.logger`, `options.metrics`, and `options.tracer` use structural typing. The Dashboard BB accepts any object with `fullId` or `namespace` properties, not specific BB class instances.

**Rationale:**
- **Loose coupling** — Dashboard doesn't depend on Logger, Metrics, or Tracer BB class definitions
- **Testing** — Tests can pass simple mock objects without constructing full CDK trees
- **Duck typing** — If another BB implements the same interface, it works automatically
- **Type safety at call sites** — Real BB instances satisfy the interface; TypeScript ensures correct usage

### D-DB-2: Explicit composition over auto-discovery

**Decision:** Dashboard requires explicit BB references in constructor options, not automatic scope-tree walking.

**Rationale:**
- **Predictability** — Developers know exactly what's on the dashboard
- **Flexibility** — Multiple dashboards can show different subsets of BBs; multiple Metrics/Logging instances can be used selectively
- **Simplicity** — No scope-walking magic; easier to understand, test, and debug
- **Determinism** — Dashboard construction doesn't depend on stack structure or initialization order

### D-DB-3: CloudWatch Dashboard over custom UI

**Decision:** Use CloudWatch's native Dashboard resource via CDK, not a custom React/UI layer.

**Rationale:**
- **Zero maintenance** — AWS-owned service; we don't maintain the visualization layer
- **Native AWS integration** — Dashboard displays real-time metrics, logs, and traces from CloudWatch natively
- **Zero runtime cost** — Dashboards are read-only CDK resources; no Lambda or backend required
- **Immediate ROI** — Works on day one without building a full admin portal
- **Trade-off** — Limited layout customization compared to a custom UI; mitigated by CloudWatch's rich widget library

### D-DB-4: Redirect route vs direct URL embedding

**Decision:** Dashboard registers a `GET /aws-blocks/dashboard` RawRoute that 302-redirects to the CloudWatch console URL, rather than embedding or serving the dashboard directly.

**Rationale:**
- **API compatibility** — Lets HTTP clients discover the dashboard URL programmatically
- **Shareable URLs** — Backend can surface the route in tooling/documentation
- **Security** — URL alone grants no access; AWS Console login is enforced by CloudWatch
- **Simplicity** — No need to manage authentication or serve private content from the Lambda

### D-DB-5: Pre-registered metric names

**Decision:** `metricConfigs` option creates metric widgets with placeholder "Insufficient data" until the first metric emission.

**Rationale:**
- **CloudWatch limitation** — CloudWatch cannot query metrics that haven't been emitted yet
- **Developer expectation** — Customers expect the dashboard to show all metrics immediately after deploy, not wait for first data point
- **UX improvement** — Showing "Insufficient data" is better than widgets missing entirely until first emission
- **Opt-in** — Customers who don't use custom metrics leave this empty

### D-DB-6: Auto-derived log group name

**Decision:** When a `logger` BB is provided, Dashboard automatically derives the log group name from the Lambda function name using `/aws/lambda/${functionName}`.

**Rationale:**
- **Standard pattern** — AWS Lambda always creates logs in `/aws/lambda/{FunctionName}` by default
- **Zero configuration** — No need to pass `logGroupName` explicitly if a Logger BB is connected
- **Consistency** — If Logger BB exists, its logs are automatically queried
- **Fallback** — If no Logger BB is provided, no log widgets appear (expected behavior)

## Infrastructure (CDK)

Creates a single CloudWatch Dashboard resource:

- **Dashboard name:** Derived from `scope.fullId` (e.g., `myapp-dashboard`)
- **Dashboard body:** JSON-serialized widget array (built from observability BB inputs)
- **CfnOutput:** Dashboard console URL exported as `{id}Url`
- **Removal policy:** DESTROY (matches sandbox behavior of other BBs)

### Auto-Generated Widgets (when observability BBs are connected)

**Always included (Lambda health):**
1. **Lambda Invocations** — `AWS/Lambda` → Invocations (Sum, 60s)
2. **Lambda Errors** — `AWS/Lambda` → Errors (Sum, 60s)
3. **Lambda Duration** — `AWS/Lambda` → Duration (Average + p99, 60s)
4. **Lambda Concurrent Executions** — `AWS/Lambda` → ConcurrentExecutions (Max, 60s)

**When `metrics` is provided:**
5. **Individual Metric Graphs** — One dedicated GraphWidget per MetricConfig entry. Each widget displays the metric with the configured stat and period (defaults: Sum, 60s), titled with metric name or custom title. Dimensions, when specified, narrow the metric scope to specific resources.

**When `logger` is provided:**
6. **Recent Errors** — Log Insights query: `fields @timestamp, @message | filter @message like /ERROR/ or level = "error" | sort @timestamp desc | limit 20`
7. **Log Volume** — `AWS/Logs` → IncomingLogEvents (Sum, 300s)

**When `tracer` is provided:**
8. **Traces** — X-Ray trace widget showing a list of recent traces

### Widget Layout

CloudWatch Dashboards use a 24-column grid. The auto-generated layout stacks sections vertically:

```
Row 0 (y=0):  [Lambda Invocations (12w, 6h)] [Lambda Errors (12w, 6h)]
Row 1 (y=6):  [Lambda Duration (12w, 6h)]     [Concurrent Executions (12w, 6h)]
Row 2+:       [Metric pairs (12w, 6h each)]   ← two metrics per row when `metrics` provided
Row M:        [Traces (24w, 9h)]               ← only if `tracer` provided (X-Ray trace map)
Row N:        [Recent Errors (24w, 6h)]        ← only if `logger` provided
Row N+1:      [Log Volume (24w, 6h)]           ← only if `logger` provided
```

Rows collapse upward when their condition is not met. For example, if only `logger` is provided (no metrics or tracing):

```
Row 0 (y=0):  [Lambda Invocations (12w, 6h)] [Lambda Errors (12w, 6h)]
Row 1 (y=6):  [Lambda Duration (12w, 6h)]     [Concurrent Executions (12w, 6h)]
Row 2 (y=12): [Recent Errors (24w, 6h)]
Row 3 (y=18): [Log Volume (24w, 6h)]
```

### Route Implementation

The Dashboard always registers a `GET` RawRoute that 302-redirects to the CloudWatch Dashboard URL:

1. **CDK layer:** Sets a `BB_DASHBOARD_URL` environment variable on the Lambda handler containing the dashboard console URL token. Registers the RawRoute for route validation.
2. **Runtime layer:** Registers a `RawRoute` with a handler that reads the env var and redirects:
   ```typescript
   // Internally equivalent to:
   new RawRoute(scope, 'dashboard-redirect', {
     path: options.routePath ?? '/aws-blocks/dashboard',
     method: 'GET',
     handler: async (ctx) => {
       const url = process.env.BB_DASHBOARD_URL;
       ctx.response.status = 302;
       ctx.response.headers.set('Location', url);
       ctx.response.send('');
     },
   });
   ```
3. **Mock layer:** Returns 503 with `{ message, hint, localObservability: { logs, metrics, traces } }` directing the user to run `npx cdk deploy` and pointing at local observability output
4. **Security:** Route is public — the URL alone grants no data access (AWS Console login required)

### IAM Permissions

The Dashboard CDK construct does **not** require additional IAM permissions beyond what the stack already has for `cdk deploy`. CloudWatch Dashboards are read-only views — they display data from metrics/logs/traces that already exist.

No runtime IAM permissions are needed because the Dashboard BB has no runtime component (it's infrastructure-only during synthesis).

## Mock Implementation

- **Local dev:** The mock registers the redirect route (which returns a 503 with helpful guidance), and logs a console message on instantiation.
- **Dev server route:** Returns 503 with JSON explaining CloudWatch Dashboards are cloud-only and directing users to run `cdk deploy`
- **Console output:** On instantiation, the mock logs:
  ```
  [Dashboard] Dashboard BB: no-op in local mode (CloudWatch Dashboard is a cloud-only resource).
  Will create CloudWatch Dashboard '{title}' on deploy. Run 'npx cdk deploy' to view.

  📍 Local observability data:
     • Logs: Check your terminal output - Logger BB writes structured JSON to stdout
     • Metrics: Metrics BB writes EMF-formatted JSON to stdout (visible in terminal)
     • Traces: Tracer stores mock traces to .bb-data/ and logs them to stdout
  ```

### Dashboard Body JSON Format

Dashboard body is serialized as CloudWatch Dashboard JSON format during CDK synthesis:

```json
{
  "widgets": [
    {
      "type": "metric",
      "x": 0, "y": 0, "width": 12, "height": 6,
      "properties": {
        "metrics": [["AWS/Lambda", "Invocations", "FunctionName", "${functionName}"]],
        "period": 60,
        "stat": "Sum",
        "title": "Lambda Invocations"
      }
    }
  ]
}
```

### Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| No dashboard visualization locally | Cannot preview dashboard layout in local dev | No mitigation — CloudWatch Dashboards are a console feature. Use `npx cdk deploy` to a sandbox |
| No metric data locally | Widgets would be empty even if rendered | No mitigation — metrics are ephemeral in local dev (EMF to stdout) |
| Route returns 503 in local mode | Cannot redirect to dashboard URL locally | Route provides helpful guidance and links to local observability data (terminal output) |

## Integration with Observability BBs

### Composition Pattern

Dashboard accepts observability BB instances as constructor parameters. This is **explicit composition** (not auto-discovery) because:

1. **Predictability** — Developers know exactly what's on the dashboard
2. **Type safety** — TypeScript enforces valid BB references
3. **Flexibility** — Multiple dashboards can show different subsets of BBs
4. **Simplicity** — No scope-walking magic; easy to understand and debug

### BB Integration via Structural Typing

Dashboard parameters use structural typing. `metrics` accepts any object with a `namespace` property (the resolved CloudWatch namespace) and an optional `defaultDimensions` property; `logger` and `tracer` accept any object with `fullId`. This means the real BB instances satisfy the interfaces via duck typing without importing their exact types, keeping the Dashboard BB decoupled.

**Metrics namespace and dimensions resolution:**
1. `metrics.namespace` → used if metrics BB provided
2. `metrics.defaultDimensions` → merged into widget queries so they target the correct dimensioned metric stream (per-metric dimensions from `MetricConfig` take precedence on conflict)
3. No metrics BB → no custom metrics widgets

**Example (full BB composition):**
```typescript
const dashboard = new Dashboard(scope, 'dashboard', {
  logger,   // Logger BB — enables log widgets
  metrics,  // Metrics BB — uses resolved namespace
  tracer,   // Tracer BB — enables trace widgets
  metricConfigs: [{ name: 'OrdersPlaced' }, { name: 'Latency' }, { name: 'ErrorRate' }],
});
```

### Data Flow

```
┌──────────────┐     BB instance (namespace)       ┌──────────────┐
│   Metrics    │ ──────────────────────────────► │              │
│  (namespace) │                                  │              │
└──────────────┘                                  │              │
                                                 │              │
┌──────────────┐     BB instance (fullId)         │  Dashboard   │──► CloudWatch Dashboard (CDK)
│   Logger     │ ──────────────────────────────► │  (CDK only)  │──► CfnOutput (URL)
│  (fullId)    │                                  │              │──► Optional API route
└──────────────┘                                  │              │
                                                 │              │
┌──────────────┐     BB instance (fullId)         │              │
│   Tracer     │ ──────────────────────────────► │              │
│  (fullId)    │                                  │              │
└──────────────┘                                  └──────────────┘
```

### What Dashboard Reads from Each BB

| BB | Information Extracted | Used For |
|----|----------------------|----------|
| **Metrics** | `namespace` (resolved CloudWatch namespace), `defaultDimensions` (optional) | Querying custom metrics in the namespace with correct dimension filtering |
| **Logger** | `fullId` (presence → derives log group) | Log Insights query widget |
| **Tracer** | `fullId` (presence → implies X-Ray active) | X-Ray trace list widget |
| **(always)** | Lambda function name (from Scope) | Lambda built-in metrics (Invocations, Errors, Duration) |

### Why Not Auto-Discovery?

Dashboard intentionally does **not** walk the scope tree to auto-discover BBs because:

- Dashboard is a static CDK resource (not a runtime component that adapts)
- Dashboard widgets need specific CloudWatch queries — auto-discovery would produce a generic, less useful dashboard
- Explicit params make the dashboard deterministic and testable
- Developers may have multiple Metrics/Logging instances and want only some on the dashboard

## Security Considerations

- **Zero additional security surface** — Dashboard is a CloudWatch Console page protected by AWS IAM
- **Access requires:** AWS Console login with `cloudwatch:GetDashboard` permission
- **No data exposure:** Dashboard displays data the viewer already has access to via IAM
- **Redirect route:** The `/aws-blocks/dashboard` route exposes only the console link (no data); AWS Console login is still required

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Unauthorized dashboard access | IAM-protected; requires AWS Console login with CloudWatch read permissions |
| URL leakage from redirect route | URL alone grants no access without AWS login |
| Dashboard manipulation | CloudWatch Dashboards are read-only views; source of truth is CDK (re-deploy overwrites manual changes) |

## Package Structure

```
packages/bb-dashboard/
├── package.json          # Conditional exports
├── tsconfig.json
├── README.md             # Usage documentation
├── DESIGN.md             # This file
└── src/
    ├── types.ts          # DashboardOptions, MetricConfig, DashboardErrors
    ├── errors.ts         # Error constants
    ├── routes.ts         # RawRoute registration (302 redirect to CloudWatch URL)
    ├── widgets.ts        # Widget builder utilities (Lambda, Metrics, Logger, Tracer)
    ├── index.cdk.ts      # CDK construct (creates CloudWatch Dashboard + env var)
    ├── index.mock.ts     # Mock with route (returns 503 in local mode)
    ├── index.aws.ts      # AWS runtime (reads URL from BB_DASHBOARD_URL env var)
    ├── index.browser.ts  # No-op browser stub
    └── index.test.ts     # Unit tests
```

### Conditional Exports (package.json)

```json
{
  "name": "@aws-blocks/bb-dashboard",
  "exports": {
    ".": {
      "browser": "./dist/index.browser.js",
      "cdk": {
        "types": "./dist/index.cdk.d.ts",
        "default": "./dist/index.cdk.js"
      },
      "aws-runtime": "./dist/index.aws.js",
      "types": "./dist/index.mock.d.ts",
      "default": "./dist/index.mock.js"
    }
  }
}
```

## Trade-offs

| Decision | Trade-off |
|----------|-----------|
| Explicit BB params over auto-discovery | More typing for the developer, but predictable and type-safe |
| CDK-only (no runtime) | Cannot dynamically update dashboard, but zero runtime cost |
| CloudWatch Dashboard over custom UI | Limited layout flexibility, but zero maintenance and native AWS integration |
| No metric auto-registration | Dashboard doesn't know metric names until deploy; mitigated by `metricConfigs` option; custom metrics appear after the namespace has data |
| Console URL requires AWS login | Not embeddable without sharing; but zero security risk |
| Browser export exists despite no browser use case | Maintains pattern consistency across all BBs; exports only type definitions with no runtime code |

## Testing Strategy

### Unit Tests (`packages/bb-dashboard/src/index.test.ts`)

- Widget builder functions produce correct CloudWatch Dashboard JSON format
- Lambda health widgets are always generated regardless of options
- Metrics widgets only appear when `metrics` option is provided
- Logging widgets only appear when `logger` option is provided
- Trace widgets only appear when `tracer` option is provided
- `metricConfigs` option creates pre-configured metric widgets
- Widget layout collapses rows correctly when conditions are not met
- Mock logs expected console message and route returns null URL

### E2E Tests (`test-apps/comprehensive/`)

1. **Minimal Dashboard** — Create dashboard with no observability BBs, verify Lambda widgets only in synthesized template
2. **Full Observability Stack** — Create with Logger + Metrics + Tracer, verify all widget types present in dashboard body
3. **Route** — Verify redirect route returns 302 to correct URL structure after deploy
4. **CfnOutput** — Verify dashboard URL is exported as CloudFormation output with expected format
5. **MetricNames** — Provide `metricConfigs`, verify metric widgets exist even before metrics are emitted
