# Dashboard — Design

Design document for Dashboard. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-dashboard`
**Type:** Primitive (creates new infrastructure)
**AWS Service:** Amazon CloudWatch Dashboards

## Design Decisions

### D-DB-1: Structural typing for observability BB composition

**Decision:** `options.metrics` uses structural typing (`MetricsBBRef`: any object with `namespace` and optional `defaultDimensions`), not the Metrics BB class. (Logger/Tracer are no longer dashboard inputs — they attach to a compute, and the compute self-reports; see D-DB-8.)

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

### D-DB-6: Compute-derived log group name

**Decision:** The compute derives its own log group name (`/aws/lambda/${functionName}` for `LambdaCompute`) inside its `loggingWidgets` builder; the Dashboard never computes a log group name.

**Rationale:**
- **Standard pattern** — AWS Lambda always creates logs in `/aws/lambda/{FunctionName}` by default; a container compute would derive its own stream instead
- **Zero configuration** — No `logGroupName` to pass anywhere; attaching a Logger to the compute is the only signal
- **Right owner** — The log group belongs to the compute's physical resources, so only the compute can name it correctly (see D-DB-8)
- **Fallback** — A compute with no Logger attached reports no `logging` section, so no log widgets appear (expected behavior)

### D-DB-7: Scope, composition guidance, and cost model

**Decision:** Dashboard targets standard operational visibility (request rates, error counts, latency, Lambda health) and is intentionally scoped narrower than a fully custom visualization layer or an admin UI.

**Rationale:**
- **When it fits** — Teams that want operational visibility into a deployed application without hand-building CloudWatch dashboards.
- **When it does not** — Fully custom widget layouts are better served by the CloudWatch console directly; data-inspection admin UIs belong in `AdminSite`, not here. (complements D-DB-3, which covers why we lean on CloudWatch's native dashboard over a custom UI)
- **Composition guidance** — Health + logs render for every compute automatically; add a `Tracer` anywhere in the app for the traces sections, and pass Metrics source(s) to the dashboard. Use the `logs` / `traces` toggles to hide sections and `computes` to restrict which computes appear; use `title` to distinguish dashboards across multi-stage deployments.
- **Cost model** — CloudWatch Dashboards are free for up to 3 dashboards (50 metrics each); beyond that they cost $3/dashboard/month. There is no runtime cost — dashboards are read-only views over existing CloudWatch data. This is the concrete pricing behind D-DB-3's "zero runtime cost" claim.

## Multi-Compute Dashboard (Implemented)

> **Status:** implemented. The dashboard is organized **by compute** — it renders
> each compute as a group (health always; logs always; traces only when the app
> contains a `Tracer`) and app-wide metrics sections after them, one per
> `MetricsSource`. It exposes a `computes?: Compute[]` selector that **defaults
> to every compute in the app** (resolved at finalize), plus `logs` / `traces`
> display toggles. `Compute` is still `@internal`, so the selector is a
> forward-looking surface — the default-to-all path needs no compute reference
> (see D-DB-10). There are no `logger` / `tracer` options — the dashboard reads
> compute state directly.

### The two axes: compute-scoped vs app-scoped observability

The four sections split cleanly by what they derive from:

| Section | Scope | Derives from | On the dashboard |
|---|---|---|---|
| Health (Invocations/Errors/Duration, or CPU/Memory for containers) | **compute** | the compute's own service/function metrics | grouped under its compute |
| Logs | **compute** | the compute's log group (`/aws/lambda/{fn}`, or the container's stream) | grouped under its compute |
| Traces | **compute** | X-Ray filtered to the compute's function/service | grouped under its compute |
| Metrics | **app** | a CloudWatch namespace (EMF; defaults to the Metrics BB's `fullId`) | one app-wide section, **not** per compute |

Health/logs/traces are defined by a compute's *physical resources*, so they belong grouped under their compute. Metrics are a semantic, app-level namespace that any compute can emit into — containers change only the *emission wiring* (a container needs the CloudWatch agent / FireLens to auto-extract EMF, vs Lambda's turnkey stdout path) and optionally invite a per-compute *dimension*; neither binds a namespace to a compute. So metrics stays app-wide.

### Target layout

One dashboard, grouped by compute, with metrics as a trailing app-wide section:

```
# <app> dashboard
## Compute — api (Lambda)
   health   (always)
   logs     (only if a Logger targets this compute)
   traces   (only if a Tracer targets this compute)
## Compute — worker (Container)
   health
   logs
## Metrics (app-wide)
   namespace "orders": OrdersPlaced, Latency p99 …
   namespace "billing": …
```

### D-DB-8: Compute is the grouping unit; the compute self-reports its section

**Decision:** For compute-scoped sections, the dashboard takes the computes to
render and asks each to self-report through a **single public entry**,
`compute.dashboardSection(region): ComputeDashboardSection` (core), returning
`{ label, health, logging?, tracing? }`. `health` and `logging` are **always**
present (logs are always captured for a compute); `tracing` is present only when
tracing is enabled on the compute. The `tracerEnabled` flag is **private** on
`Compute` — flipped only by `enableTracing()` (which the framework calls on
every compute when the app contains a `Tracer`), never settable from outside —
and the per-kind builders (`healthWidgets` / `loggingWidgets` / `tracingWidgets`)
are `protected`, so a caller cannot obtain trace widgets for an untraced compute.
The dashboard's `logs` / `traces` options are a **display** choice layered on top
(hide an otherwise-present section); they never fabricate one.

**Rationale:**
- Log group and trace target belong to the compute, not to the Logger/Tracer BB — so the compute is the only thing that can build the right widgets for a given compute.
- Keeps the dashboard a **pure aggregator** (it never computes a query itself), consistent with D-DB-3 and the "thin block" principle.
- Logging is unconditional (every compute captures stdout), so its section is always available; only tracing — which provisions costed X-Ray infra — is gated, and it is gated on compute state, not on a Dashboard parameter.
- Encapsulation: the traces section can't be fabricated or bypassed — the flag and the infra move together through `enableTracing()` (template-method pattern), and the gating lives in one place.

### D-DB-9: Metrics stays an explicit, app-wide input

**Decision:** Metrics is **not** part of the per-compute grouping and is **not** auto-discovered. It is an explicit option `metrics?: MetricsSource | MetricsSource[]`, where each `MetricsSource` pairs a Metrics BB with **its own** `metricConfigs` (metric names are namespace-specific, so configs are per-source, not dashboard-wide). Each source renders once as an app-wide section, one per namespace, after the compute groups.

**Rationale:**
- A namespace is app-level and receives from any compute; auto-including it per compute would duplicate it across every compute group.
- Nothing about a Metrics BB registers against a compute (unlike Logger/Tracer), so the compute has no signal to self-report metrics.
- Pairing configs with their source prevents cross-namespace ambiguity: `OrdersPlaced` belongs to the orders namespace, not billing.
- Per-compute disambiguation, when wanted, is a `defaultDimensions` choice on the Metrics BB — not a namespace-to-compute binding.

### D-DB-10: `computes` selector, defaulting to all computes at finalize

**Decision:** The dashboard exposes an optional `computes?: Compute[]` option and
defaults to **every** compute in the app when it is omitted. The default is
resolved at the finalize pass (see D-DB-11) by enumerating `getComputes()`, so
there is no construction-order dependency. `Compute` is imported from
`@aws-blocks/core/cdk/internal`.

**Rationale:**
- **Default-to-all is the batteries-included DX.** The common case — "show me my whole app" — needs no argument, and resolving it at finalize means a compute constructed after the Dashboard is still included.
- **The explicit list stays available** for restricting the dashboard to a subset, and is order-safe (the caller names exactly what appears).
- **Internal-type exposure is acceptable here.** `Compute` is still `@internal`, so `computes` is an advanced/forward-looking surface; the default-to-all path needs no compute reference at all, which is what almost every app uses today. When the multi-compute customer surface lands and `Compute` goes public, this option becomes fully first-class with no shape change.
- Logs/traces are **not** part of this selector — they are per-section display toggles (`logs` / `traces`), applied uniformly to whichever computes are rendered (see D-DB-8).

### D-DB-11: Build the widget body at finalize, not in the constructor

**Decision:** The Dashboard does **not** assemble its widgets in its constructor. It registers a deferred body-build (`registerDashboardFinalizer` from core) that resolves the compute list (`options.computes ?? getComputes(this)`), calls `compute.dashboardSection(region)` on each, and creates the `CwDashboard`; that runs via `finalizeDashboards()` at the end of `BlocksStack`/`BlocksBackend.create()`, after the backend module has fully imported. Only the body is deferred; `dashboardName`, `url`, the redirect route, and the config registration stay in the constructor (they need nothing from other blocks).

**Rationale:**
- **Order-independence.** `dashboardSection` gates the traces section on each compute's `tracerEnabled`, which the framework flips at `finalizeTracing()` (when the app contains a `Tracer`) — and the default compute list is `getComputes()`. Building in the Dashboard constructor would miss any compute or Tracer constructed after it, and would run before tracing is finalized. Deferring to finalize means the Dashboard observes the complete app, so `new Dashboard(...)` can appear anywhere in the backend module. (`finalizeTracing` runs before `finalizeDashboards`, so trace flags are set when the dashboard reads them.)
- **Reuses the house pattern.** `finalizeConfigRegistry` already runs at the same `create()` join point; the compute registry's own doc names "dashboards" as an intended finalize consumer. `registerDashboardFinalizer`/`finalizeDashboards` follows it (core owns the seam; the Dashboard supplies a callback, so core keeps no dependency on `bb-dashboard`). It is deliberately Dashboard-specific — the only deferred-build case today — and can be generalized into a finalizer registry if a second use case appears.
- **Enables default-to-all.** With the body built at finalize, the no-arg "cover every compute" default enumerates `getComputes()` with no construction-order gap (see D-DB-10).
- **Cost:** a Dashboard constructed outside `create()` (e.g. directly in a unit test) must call `finalizeDashboards(stack)` before synth — exactly how `config-registry.test.ts` drives `finalizeConfigRegistry`.

### Layout (as implemented, `widgets.ts`)

Per compute (in the order given): `## 🔧 {label}` header (label = the compute's
scope `id`), health rows always, then `### 🔍 Traces` and `### 📋 Logs` only when
present in the section. Then one `## 📊 Metrics — {namespace}` section per
`MetricsSource`. Single-compute apps render one group — the pre-multi-compute
dashboard plus a header row.

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

**Always (logs are always captured), unless `logs: false`:**
6. **Recent Errors** — Log Insights query: `fields @timestamp, @message | filter @message like /ERROR/ or level = "error" | sort @timestamp desc | limit 20`
7. **Log Volume** — `AWS/Logs` → IncomingLogEvents (Sum, 300s)

**When tracing is enabled on the compute (the app has a `Tracer`), unless `traces: false`:**
8. **Traces** — X-Ray trace widget showing a list of recent traces

### Widget Layout

CloudWatch Dashboards use a 24-column grid. The auto-generated layout stacks sections vertically:

```
Row 0 (y=0):  [Lambda Invocations (12w, 6h)] [Lambda Errors (12w, 6h)]
Row 1 (y=6):  [Lambda Duration (12w, 6h)]     [Concurrent Executions (12w, 6h)]
Row T:        [Traces (24w, 9h)]               ← only if the app has a Tracer (unless traces:false)
Row N:        [Recent Errors (24w, 6h)]        ← always (unless logs:false)
Row N+1:      [Log Volume (24w, 6h)]           ← always (unless logs:false)
Row M+:       [Metric pairs (12w, 6h each)]   ← two metrics per row, per MetricsSource, after the compute groups
```

(Section-header text widgets separate the groups; within a compute group the order is health → traces → logs, and app-wide metrics sections follow all compute groups.)

Rows collapse upward when their condition is not met. For example, with no Tracer and no metrics (logs always render):

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

The dashboard is **compute-driven**: it reads observability state off each
compute rather than accepting Logger / Tracer instances. Only **Metrics** is an
explicit BB input (it is app-scoped, not compute-scoped). This keeps the
dashboard deterministic and decoupled from the observability BB classes:

1. **Predictability** — Health + logs always render per compute; traces render when the app has a `Tracer`. Nothing to wire up.
2. **Type safety** — TypeScript enforces valid Metrics references and the `computes` selector's `Compute[]` type.
3. **Flexibility** — `logs` / `traces` toggles and the `computes` selector let one app show different subsets across multiple dashboards.
4. **Simplicity** — No scope-walking magic for logs/traces; the compute self-reports.

### BB Integration via Structural Typing

The metrics input uses structural typing. Each `MetricsSource.metrics` accepts any object with a `namespace` property (the resolved CloudWatch namespace) and an optional `defaultDimensions` property. Logs and traces are **not** dashboard inputs — the dashboard reads each compute's self-reported `dashboardSection` (logs always present; traces present when the compute is traced). This keeps the Dashboard BB decoupled from the Logger/Tracer classes.

**Metrics namespace and dimensions resolution:**
1. `metrics.namespace` → used if a metrics source is provided
2. `metrics.defaultDimensions` → merged into widget queries so they target the correct dimensioned metric stream (per-metric dimensions from `MetricConfig` take precedence on conflict)
3. No metrics source → no custom metrics widgets

**Example (full observability):**
```typescript
new Tracer(scope, 'tracer');   // presence-gated → every compute gets a traces section
const metrics = new Metrics(scope, 'metrics');

const dashboard = new Dashboard(scope, 'dashboard', {
  // computes omitted → every compute in the app; logs/traces default on
  metrics: {
    metrics,
    metricConfigs: [{ name: 'OrdersPlaced' }, { name: 'Latency' }, { name: 'ErrorRate' }],
  },
});
```

### Data Flow

```
                     enableTracing() at finalize (if app has a Tracer)
┌──────────────┐    ┌──────────────┐
│   Tracer     │ ─► │              │
└──────────────┘    │   Compute    │  dashboardSection(region)
                    │  (per unit)  │ ──────────────────────────┐
  logs always on ─► │              │   { label, health,        │
                    └──────────────┘     logging?, tracing? }   ▼
                                                       ┌──────────────┐
                                                       │  Dashboard   │──► CloudWatch Dashboard (CDK)
┌──────────────┐   MetricsSource (namespace+configs)   │  (CDK only)  │──► CfnOutput (URL)
│   Metrics    │ ─────────────────────────────────────►│              │──► Optional API route
└──────────────┘                                       └──────────────┘
```

The Tracer never talks to the Dashboard: it records presence, the framework
enables tracing on every compute at finalize, and the Dashboard asks each
compute for its self-reported section (applying its `logs` / `traces` toggles).

### What Dashboard Reads from Each Input

| Input | Information Extracted | Used For |
|----|----------------------|----------|
| **Compute** (per `computes` entry, default all) | `dashboardSection(region)` → `{ label, health, logging?, tracing? }` | The compute's group: header, health widgets, logs widgets (always), plus traces widgets when the compute is traced — subject to the `logs` / `traces` toggles |
| **Metrics** (per `MetricsSource`) | `namespace` (resolved CloudWatch namespace), `defaultDimensions` (optional), per-source `metricConfigs` | Querying custom metrics in the namespace with correct dimension filtering |

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
- Health widgets are always generated for every compute section
- Metrics widgets only appear when the `metrics` option is provided (one section per `MetricsSource`)
- Logging/trace widgets only appear when the compute's section reports them (Logger/Tracer attached)
- Per-source `metricConfigs` create pre-configured metric widgets
- Widget layout collapses rows correctly when conditions are not met
- Mock logs expected console message and route returns null URL

### E2E Tests (`test-apps/comprehensive/`)

1. **Minimal Dashboard** — Create dashboard with no observability BBs, verify Lambda widgets only in synthesized template
2. **Full Observability Stack** — Create with Logger + Metrics + Tracer, verify all widget types present in dashboard body
3. **Route** — Verify redirect route returns 302 to correct URL structure after deploy
4. **CfnOutput** — Verify dashboard URL is exported as CloudFormation output with expected format
5. **MetricNames** — Provide `metricConfigs`, verify metric widgets exist even before metrics are emitted
