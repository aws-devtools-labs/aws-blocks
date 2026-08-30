---
"@aws-blocks/core": patch
"@aws-blocks/bb-lambda-compute": patch
"@aws-blocks/bb-logger": patch
"@aws-blocks/bb-tracer": patch
"@aws-blocks/bb-dashboard": minor
"@aws-blocks/blocks": minor
---

feat: compute-scoped observability and a per-compute Dashboard

The `Compute` abstraction gains observability so observability Building Blocks
target the resolved compute instead of poking a specific function:

- `enableLogging(retention?)` — marks the compute as having a Logger attached
  (so the Dashboard shows its logs) and, when a retention is given, provisions
  the compute's CloudWatch log group with it (DESTROY removal);
- `enableTracing()` — marks the compute as traced and turns on active X-Ray
  tracing + the role's trace-publish permission;
- `dashboardSection(region)` — returns the compute's CloudWatch Dashboard section
  (`{ label, health, logging?, tracing? }`); logs / traces are populated only
  when a Logger / Tracer is attached, so a caller can't build an empty section.

The compute owns its own state: the `loggerEnabled` / `tracerEnabled` flags are
private and the log-group / X-Ray infra hooks are `protected`, so the flag can't
be set independently of the infra. Logger just calls
`this.compute.enableLogging(options?.retention)`; Tracer calls
`this.compute.enableTracing()`.

**Breaking (Dashboard):** the Dashboard is now organized **by compute**. It
renders a group per compute passed via the new `computes` option — a single
compute or an array — defaulting to the app's default compute when omitted, so a
single-compute app needs no argument. Each group shows a health section plus
logs / traces sections automatically when a Logger / Tracer is attached to that
compute. Consequently the `logger` and `tracer` options are **removed** —
attaching those Building Blocks to a compute is the signal, so they no longer
need to be passed to the Dashboard. Metrics remain app-scoped and explicit, but
are now passed as **`MetricsSource`** objects (a Metrics BB paired with its own
`metricConfigs`) — a single source or an array, one app-wide section per
namespace. The top-level `metricConfigs` option is **removed**: metric names are
namespace-specific, so they live on their source.

Migration:
- drop `logger` / `tracer` from `new Dashboard(...)` options; keep creating the
  `Logger` / `Tracer` Building Blocks as before;
- move `metricConfigs` inside the metrics source:
  `metrics: { metrics, metricConfigs: [...] }` (was `metrics, metricConfigs: [...]`);
- optionally pass `computes` to curate which computes appear.
