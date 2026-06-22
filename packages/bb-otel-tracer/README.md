# OTel Tracer

Distributed tracing via OpenTelemetry, exported to AWS X-Ray through CloudWatch's OTLP
traces endpoint (in-process OTel SDK + standalone OpenTelemetry Collector Lambda layer).
Part of the OTel building-block family alongside `@aws-blocks/bb-otel-metrics` and
`@aws-blocks/bb-otel-logger`.

> **Recommended for new applications.** This is the preferred tracing block — it's
> vendor-neutral (OTLP to CloudWatch/X-Ray or any backend) with full OTel span semantics.

**When to use:** the default for distributed tracing. You get span kind/links/events and W3C
context propagation, exported to CloudWatch/X-Ray or any third-party OTLP backend. Choose the
AWS-native `Tracer` block only if you specifically want the X-Ray SDK.

## API

```typescript
const tracer = new OtelTracer(scope, id, options?)

const user = await tracer.startSegment('fetch-user', async (segment) => {
  segment.addAnnotation('user.id', 'u1');   // searchable attribute (lowercase, dot-separated)
  segment.setHttpStatus(200);
  return db.get('u1');
}, { kind: SpanKind.CLIENT });

tracer.inject(outboundHeaders);             // W3C propagation
const traceId = tracer.getTraceId();        // log correlation
```

| Method | Description |
|--------|-------------|
| `startSegment(name, fn, options?)` | Wrap an async fn in an active span (auto-closed; errors recorded + re-thrown). |
| `addAnnotation/addMetadata/addEvent(...)` | Mutate the currently-active span. |
| `getTraceId()` | Current trace ID, or `null`. |
| `inject(carrier)` / `extract(carrier)` | Manual W3C context propagation. |
| `rawTracer` | The underlying OTel `Tracer` — escape hatch. |

The `segment` passed to the callback offers `addAnnotation` (searchable),
`addMetadata` (namespaced `metadata.*` attribute), `addEvent`, `addError`, and
`setHttpStatus`. X-Ray indexing of attributes is governed by X-Ray **indexing rules**,
not by the annotation/metadata distinction.

### Options

- `enabled` — disable tracing (`startSegment` still runs the wrapped fn). Default `true`.
- `serviceName` / `serviceNamespace` / `serviceVersion` — OTel `service.*` resource
  attributes (semconv), set once per process. `serviceName` defaults to the Lambda function
  name (`AWS_LAMBDA_FUNCTION_NAME`), then `BLOCKS_STACK_NAME`, then the block's scope `fullId`
  (local dev).

Spans carry the SDK's **resource attributes** — your `service.*` identity plus auto-detected
AWS Lambda attributes (`faas.*`, `cloud.*`). The raw `Tracer`/provider escape hatch is
available via `rawTracer` and `getOtelTracerProvider()` (from `@aws-blocks/otel-common`).

## Prerequisite & local dev

CloudWatch **Transaction Search** must be enabled (account/region) for OTLP spans to be
queryable — they land in the `aws/spans` log group. Locally, spans persist to
`.bb-data/<fullId>/traces.json` (no collector locally).
