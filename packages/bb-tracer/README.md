# Tracer

Distributed tracing backed by AWS X-Ray.

**When to use:** You need to trace request flow across services, debug latency issues, or visualize service dependencies. Good for identifying bottlenecks, understanding call chains, and correlating failures across Building Blocks.

**When NOT to use:** If you need structured log output, use `Logging`. If you need numeric measurements over time, use `Metrics`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Installation

```bash
npm install @aws-blocks/bb-tracer
```

## Quick Usage

```typescript
import { Tracer } from '@aws-blocks/bb-tracer';

const tracer = new Tracer(scope, 'my-tracer');

// Wrap an operation in a traced segment
const user = await tracer.startSegment('fetchUser', async (segment) => {
  segment.addAnnotation('userId', 'user-123');
  const result = await db.get('user-123');
  segment.setHttpStatus(200);
  return result;
});

// Add root-level annotations (attached to the Lambda facade segment)
tracer.addAnnotation('endpoint', '/api/users');

// Get the current trace ID for log correlation
const traceId = tracer.getTraceId();
```

## API

```typescript
const tracer = new Tracer(scope, id, options?)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `startSegment(name, fn)` | `Promise<T>` | Wrap an async function in a traced subsegment. The segment is automatically closed when `fn` completes or throws. |
| `addAnnotation(key, value)` | `void` | Add a searchable annotation to the root segment. |
| `addMetadata(key, value)` | `void` | Add non-searchable metadata to the root segment. |
| `getTraceId()` | `string \| null` | Get the current trace ID for log correlation. Returns `null` when disabled. |

### Segment Methods

The `segment` object passed to `startSegment`'s callback:

| Method | Description |
|--------|-------------|
| `addAnnotation(key, value)` | Add a searchable annotation (string, number, or boolean). |
| `addMetadata(key, value)` | Add non-searchable metadata (any JSON-serializable value). |
| `addError(error)` | Record an error without re-throwing. |
| `setHttpStatus(statusCode)` | Record HTTP response status code. |

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable or disable tracing. When `false`, `startSegment` still executes the wrapped function. |
| `samplingRate` | `number` | `1.0` | Sampling rate between 0 and 1. Only affects local mock behavior. |
| `logger` | `ChildLogger` | — | Optional logger for internal operations. When omitted, a default Logger at error level is created. |

## Best Practices

- Use `startSegment` to wrap discrete units of work (DB calls, HTTP requests, business logic)
- Keep segment names short and descriptive (e.g., `'fetchUser'`, `'processPayment'`)
- Use annotations for values you want to filter/search by in the X-Ray console
- Use metadata for large or complex debugging data you don't need to search
- Keep annotation cardinality low (avoid user-specific values as annotation keys)
- Use `AsyncJob` for long-running work rather than tracing huge spans

## Local Development

Mock data persists to disk at `.bb-data/{fullId}/traces.json` across dev server restarts. Nested segments are stored as a tree (children array). Wipe with `rm -rf .bb-data`.

The mock records all traces locally with full timing, annotations, metadata, and error data — matching the shape of what X-Ray would capture in production.

## Sampling

- **Local (mock):** Controlled by the `samplingRate` option. A value of `0.1` means roughly 10% of local traces are recorded. Default is `1.0` (record everything).
- **Production (AWS):** Sampling is controlled by X-Ray sampling rules configured in the AWS console or via CDK. The `samplingRate` option is ignored in production — X-Ray's native sampling infrastructure takes precedence.

## Pricing

- **Free tier:** 100,000 traces recorded per month, 1,000,000 traces scanned/retrieved per month
- **Beyond free tier:** $5.00 per million traces recorded, $0.50 per million traces retrieved or scanned
- **Lambda daemon:** No additional charge — the X-Ray daemon is built into the Lambda runtime
- **Cost drivers:** Number of traced invocations × sampling rate
- **Cost optimization:** Configure X-Ray sampling rules to keep recorded-trace volume (and cost) low for high-throughput functions (the `samplingRate` option only affects the local mock, not production)
- **Disabled (`enabled: false`):** Zero X-Ray cost — no traces are recorded or sent



## See Also

- [Types](./src/types.ts) — Shared type definitions (`Segment`, `TracerOptions`, `AnnotationValue`)
