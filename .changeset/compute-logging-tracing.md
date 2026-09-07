---
"@aws-blocks/core": patch
"@aws-blocks/bb-lambda-compute": patch
"@aws-blocks/bb-logger": patch
"@aws-blocks/bb-tracer": patch
---

feat: route logging retention and tracing through the compute

The `Compute` abstraction gains the observability seam so the Logger and Tracer
Building Blocks target the resolved compute instead of poking a specific
function:

- `enableLogging(retentionDays?)` — when a `retentionDays` is given, sets it on
  the compute's single log group (created with the stack-wide
  `defaults.logRetention`); the compute owns the last-wins + synth
  conflict-warning policy across multiple Loggers. A bare call leaves retention
  untouched.
- `enableTracing()` — turns on the compute's active X-Ray tracing and grants the
  shared execution role trace-publish permission.

The infra hooks (`applyLogRetention` / `applyTracing`) are `protected` abstracts
implemented by the concrete compute, so the shared policy always runs. `bb-logger`
now calls `this.compute.enableLogging(options?.retention)` and `bb-tracer` calls
`this.compute.enableTracing()` — neither reaches into the shared handler's
resources directly anymore.
