---
"@aws-blocks/core": patch
"@aws-blocks/bb-lambda-compute": patch
"@aws-blocks/bb-dashboard": minor
"@aws-blocks/blocks": minor
---

feat(bb-dashboard): organize the Dashboard by compute

The Dashboard now renders a compute-scoped section built from the compute's own
self-report rather than from Logger/Tracer instances passed as options.

- `Compute` gains `dashboardSection(region)` returning `{ label, health, logging?,
  tracing? }`. `health` always renders; `logging` / `tracing` render only when a
  Logger / Tracer is attached to the compute (tracked by private
  `loggerEnabled` / `tracerEnabled` flags flipped by `enableLogging` /
  `enableTracing`). The per-kind builders (`healthWidgets` / `loggingWidgets` /
  `tracingWidgets`) are `protected` abstracts, so a caller can't obtain
  log/trace widgets for a compute with none attached. `LambdaCompute` implements
  them (Lambda health metrics, its own log group, an X-Ray trace widget).

**Breaking (Dashboard):** logs / traces sections appear automatically for the
compute that has a Logger / Tracer attached — so the `logger` and `tracer`
options are **removed**. Metrics stay app-scoped and explicit, now passed as
**`MetricsSource`** objects (a Metrics BB paired with its own `metricConfigs`) —
a single source or an array, one app-wide section per namespace. The top-level
`metricConfigs` option is **removed** (metric names are namespace-specific, so
they live on their source). No compute selector is exposed — the dashboard
covers the app's single default compute (a selector arrives with the
multi-compute customer surface).

Migration:
- drop `logger` / `tracer` from `new Dashboard(...)` options; keep creating the
  `Logger` / `Tracer` Building Blocks as before;
- move `metricConfigs` inside the metrics source:
  `metrics: { metrics, metricConfigs: [...] }` (was `metrics, metricConfigs: [...]`).

`MetricsSource` is re-exported from `@aws-blocks/blocks` (and
`@aws-blocks/blocks/cdk`). `LoggerBBRef` / `TracerBBRef` are marked
`@deprecated` — the Dashboard no longer consumes them.

The Dashboard builds its widget body via a new core seam
(`registerDashboardFinalizer` / `finalizeDashboards`, run at the end of
`BlocksStack`/`BlocksBackend.create()` after every Building Block is
constructed) rather than in its constructor. This makes it order-independent: a
Dashboard created *before* its Loggers/Tracers still renders their sections,
because the body is assembled once the whole app is known.
