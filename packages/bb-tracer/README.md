# Tracer

Distributed tracing backed by AWS X-Ray.

> An enabled `Tracer` turns on X-Ray Active tracing for every Lambda compute in the app.
> Setting `enabled: false` opts out only that instance. Container computes do not provision
> an X-Ray collector. X-Ray is billed per trace recorded or retrieved.

**When to use:** You need to trace request flow across services, debug latency issues, or visualize service dependencies.

**When NOT to use:** If you need structured log output, use `Logger`. If you need numeric measurements over time, use `Metrics`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Installation

```bash
npm install @aws-cdk-blocks/bb-tracer
```

## Quick start

```typescript
import { Tracer } from '@aws-cdk-blocks/bb-tracer';

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
| `enabled` | `boolean` | `true` | When `false`, `startSegment` still executes the wrapped function, but records nothing, and `getTraceId()` returns `null`. Other enabled Tracers are unaffected. |
| `samplingRate` | `number` | `1.0` | Fraction of traces the local mock records, between 0 and 1 (`0.1` records roughly 10%); the mock throws `RangeError` for a value outside that range. Ignored on AWS, where X-Ray sampling rules (configured in the AWS console or via CDK) decide. |
| `logger` | `ChildLogger` | — | Optional logger for internal operations. When omitted, a default Logger at error level is created. |

## Best practices

- Keep annotation cardinality low (avoid user-specific values as annotation keys)

## Local development

Mock data persists to disk at `.cdk-blocks/local/data/{fullId}/traces.json` across dev server restarts. Nested segments are stored as a tree (children array). Wipe with `rm -rf .cdk-blocks/local/data .bb-data`.

## Scaling and cost (AWS)

- **Free tier:** 100,000 traces recorded per month, 1,000,000 traces scanned/retrieved per month
- **Beyond free tier:** $5.00 per million traces recorded, $0.50 per million traces retrieved or scanned
- **Lambda daemon:** No additional charge — the X-Ray daemon is built into the Lambda runtime
- **Cost drivers:** Number of traced invocations × sampling rate
- **Cost optimization:** Configure X-Ray sampling rules to keep recorded-trace volume (and cost) low for high-throughput functions
- With no enabled `Tracer`, Blocks does not turn on Lambda Active tracing.

## See also

- Exact types (`Segment`, `TracerOptions`, `AnnotationValue`): `npm run docs:api Tracer`
