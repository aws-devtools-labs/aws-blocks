# Required @aws-blocks Building Blocks

All Building Blocks are imported from `@aws-blocks/blocks`. The implementation must route the task's core behavior through the real block API below — not an in-memory Map/array, a hardcoded result, or an inline stub.

- ApiNamespace — exposes the JSON-RPC methods `api.ping` / `api.info` / `api.echo`. Expect `new ApiNamespace(scope, 'api', (ctx) => ({ ... }))`.
- Metrics — emits a metric on each `ping`. Expect `metrics.emit('Ping', 1)`.
- Logger — writes a log line on every method call. Expect `log.info(...)` (or `.warn` / `.error`).
- AppSetting — supplies the app name (initial value exactly `Observability Service`), read on the server. Expect `appName.get()` — not a hard-coded string.
- Tracer — runs each method's work inside its own segment. Expect `tracer.startSegment(name, fn)`.
