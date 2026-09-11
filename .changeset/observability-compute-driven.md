---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/bb-lambda-compute": minor
"@aws-blocks/bb-dashboard": minor
"@aws-blocks/bb-logger": minor
"@aws-blocks/bb-tracer": minor
---

Make observability **compute-driven** so it composes correctly once an app has more than one compute. Logging, tracing, and the dashboard now key off compute state rather than off the Logger / Tracer / Dashboard blocks poking a single implicit compute.

**Logging is always on; retention is a compute-level setting.** Every compute captures stdout to its own log group unconditionally — there is no "enable logging" step. The retention of that group is set per compute via a new `logRetention` prop on `LambdaCompute` (`@aws-blocks/bb-lambda-compute`), falling back to `defaults.logRetention`. Log **level** is purely per-instance runtime behavior: set it via a `Logger`'s `level` option (default `'info'`). There is no app-wide log-level default and no `LOG_LEVEL` env var.

**Tracing is presence-gated.** Creating any `Tracer` in the app now enables X-Ray on **every** compute (X-Ray provisions real, costed infrastructure, so it stays off until the app opts in by constructing a Tracer). This replaces the previous model where a Tracer turned on tracing for one implicit compute. `@aws-blocks/core/cdk` adds `registerTracer()` (records Tracer presence) and `finalizeTracing()` (enables tracing on all computes at finalize); `create()` runs it before finalizing dashboards. `Compute.enableTracing()` is now idempotent.

**The dashboard is organized by compute, with display toggles.** `DashboardOptions` gains `logs?: boolean` (default `true`) and `traces?: boolean` (default `true`) — app-wide display toggles applied uniformly to every compute section. `logs:false` hides the (always-captured) logs section; `traces:false` hides traces even when tracing is enabled.

The dashboard covers **every** compute in the app (resolved at finalize, so construction order never matters). Each compute renders a health section always, a logs section (unless `logs:false`), and a traces section only when tracing is enabled on it (unless `traces:false`). Metrics remain app-scoped and are passed explicitly. No `computes` selector is exposed yet — it would leak the internal `Compute` type before customers can construct a compute; it arrives with the multi-compute surface.

**⚠️ Behavior / API changes:**

- **`Logger` no longer reconfigures log retention.** The CDK `Logger` is now a no-op placeholder (logging is always on and retention moved to the compute). The `retention` option was removed from `LoggingOptions`; set `logRetention` on the compute instead.
- **A `Tracer` now enables X-Ray on all computes, not one.** Any Tracer in the app turns on tracing fleet-wide.
- **`Logger` no longer reads the `LOG_LEVEL` environment variable.** Log level is set solely via the per-`Logger` `level` option (default `'info'`); the previously supported `LOG_LEVEL` env-var override has been removed, and Blocks stamps no app-wide log-level config. `BlocksDefaults` has no `logLevel` field.
- **Removed the deprecated `LoggerBBRef` / `TracerBBRef` dashboard types.** They were no longer consumed — the dashboard reads compute state directly. Loggers and Tracers were never passed to the Dashboard in this model.
