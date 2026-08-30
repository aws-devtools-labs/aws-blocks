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

- `enableLogging(retentionDays?)` — marks the compute as having a Logger
  attached (so the Dashboard shows its logs) and, when a `retentionDays` is
  given, sets the retention on **this compute's own** single log group (created
  with the stack-wide `defaults.logRetention`), so no second group is spawned.
  The compute owns whether a group already exists plus the last-wins +
  synth-conflict-warning policy, so several Loggers on one compute can't collide;
- `enableTracing()` — marks the compute as traced and turns on active X-Ray
  tracing + the role's trace-publish permission;
- `dashboardSection(region)` — returns the compute's CloudWatch Dashboard section
  (`{ label, health, logging?, tracing? }`); logs / traces are populated only
  when a Logger / Tracer is attached, so a caller can't build an empty section.

The compute owns its own state and infra: the `loggerEnabled` / `tracerEnabled`
flags are private, and the log-group-retention and X-Ray hooks are `protected`,
so a flag can't be set independently of the infra and retention always runs the
shared last-wins/conflict-warning policy. Logger just calls
`this.compute.enableLogging(options?.retention)` — its only observability seam —
and Tracer calls `this.compute.enableTracing()`. Because these target the
*resolved* compute, an observability block attached to a non-default compute
reconfigures that compute's group — not always the default one.

**Breaking (Dashboard):** the Dashboard now renders logs / traces sections
automatically for whichever compute has a Logger / Tracer attached (the compute
self-reports this), rather than taking those Building Blocks as options.
Consequently the `logger` and `tracer` options are **removed** — attaching those
Building Blocks is the signal, so they no longer need to be passed to the
Dashboard. Metrics remain app-scoped and explicit, but are now passed as
**`MetricsSource`** objects (a Metrics BB paired with its own `metricConfigs`) —
a single source or an array, one app-wide section per namespace. The top-level
`metricConfigs` option is **removed**: metric names are namespace-specific, so
they live on their source. No compute selector is exposed — the dashboard covers
the app's single default compute (a `computes` option arrives with the
multi-compute customer surface).

Migration:
- drop `logger` / `tracer` from `new Dashboard(...)` options; keep creating the
  `Logger` / `Tracer` Building Blocks as before;
- move `metricConfigs` inside the metrics source:
  `metrics: { metrics, metricConfigs: [...] }` (was `metrics, metricConfigs: [...]`).

The `MetricsSource` type is now re-exported from `@aws-blocks/blocks` (and
`@aws-blocks/blocks/cdk`) so it can be imported to annotate variables, not just
passed inline. `LoggerBBRef` / `TracerBBRef` are marked `@deprecated` — the
Dashboard no longer consumes them (attaching a Logger / Tracer to a compute is
the signal); they remain exported for backward compatibility.
