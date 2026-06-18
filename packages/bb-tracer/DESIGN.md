# Tracer — Design

Design document for Tracer. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-tracer`
**Type:** Composite (no new infrastructure)
**AWS Service:** AWS X-Ray (via Lambda's built-in X-Ray integration)

## API Surface

```typescript
class Tracer extends Scope {
	constructor(scope: ScopeParent, id: string, options?: TracerOptions);
	startSegment<T>(name: string, fn: (segment: Segment) => Promise<T>): Promise<T>;
	addAnnotation(key: string, value: AnnotationValue): void;
	addMetadata(key: string, value: unknown): void;
	getTraceId(): string | null;
}

interface Segment {
	addAnnotation(key: string, value: AnnotationValue): void;
	addMetadata(key: string, value: unknown): void;
	addError(error: Error): void;
	setHttpStatus(statusCode: number): void;
}

type AnnotationValue = string | number | boolean;

interface TracerOptions {
	/** Enable or disable tracing. Default: `true`. */
	enabled?: boolean;
	/**
	 * Sampling rate between 0 and 1. Default: `1.0`.
	 * Only affects local mock behavior — production uses X-Ray sampling rules.
	 */
	samplingRate?: number;
	/** Optional logger for internal BB diagnostics. Defaults to error-level logging. */
	logger?: ChildLogger;
}
```

### Synchronous Annotation Methods

`addAnnotation`, `addMetadata`, `addError`, and `setHttpStatus` are **synchronous** — an intentional deviation from the "Async by Default" guideline. These methods attach data to the current in-memory segment with no I/O. Returning a Promise would add overhead for zero benefit. Only `startSegment` is async because it wraps an async function and manages segment lifecycle.

### Why No Error Constants

Tracer should never throw or affect application behavior. If X-Ray is unavailable or tracing is disabled, all operations are silent no-ops. Errors within `startSegment` are recorded on the segment and re-thrown to the caller — the tracing layer does not swallow application errors. The only constructor validation (`RangeError` for `samplingRate` out of bounds) is a programming error, not a runtime condition worth an error constant.

### Why Segment Is an Interface (Not a Class)

`Segment` is an interface because the implementation differs across environments:
- **Mock:** `MockSegment` class with in-memory state for local persistence.
- **AWS runtime:** `XRaySegment` class wrapping `AWSXRay.Subsegment`.
- **Browser:** Inline no-op object literal.
- **Disabled/unsampled:** Singleton `NO_OP_SEGMENT` object.

Exposing a class would couple consumers to one implementation. The interface allows the no-op segment pattern to avoid unnecessary allocations.

### `setHttpStatus` and `addError`

Beyond `addAnnotation` and `addMetadata`, `Segment` exposes two additional methods:

- **`addError(error: Error)`** — Records an error on the segment without re-throwing. Needed for cases where errors are caught and handled but should still be visible in traces. Maps to `subsegment.addError()` in X-Ray.
- **`setHttpStatus(statusCode: number)`** — Records the HTTP response status code. Helps X-Ray categorize responses (2xx/4xx/5xx) and sets fault/error flags automatically. Uses X-Ray's native `http.response.status` field rather than an annotation.

## Infrastructure (CDK)

Tracer is a **composite Building Block** — it creates no new AWS resources. It configures tracing on the parent scope's Lambda function:

- **Tracing mode:** Sets `TracingConfig.Mode = 'Active'` on the Lambda `CfnFunction` (L1 construct).
- **IAM permissions:** Adds `xray:PutTraceSegments` and `xray:PutTelemetryRecords` on resource `'*'` to the Lambda execution role.
- **No sampling rules:** X-Ray sampling rules are not managed by this BB. The default sampling rule (1 req/sec + 5% of additional requests) applies unless configured externally.

When `enabled: false` is passed, no CDK mutations occur — the Lambda runs without active tracing.

## Mock Implementation

- `startSegment` captures timing (start/end timestamps via `Date.now()`) and manages a segment hierarchy via a stack (`segmentStack: TraceRecord[]`).
- Nested `startSegment` calls push child records onto the stack; child records are added to the parent's `children` array.
- Annotations and metadata are stored on each `MockSegment` instance and copied to the `TraceRecord` on segment close.
- On top-level segment close, the complete segment tree is persisted to `.bb-data/{fullId}/traces.json`.
- Traces are also logged to console as structured JSON (`_type: 'trace'`).
- File persists a rolling window of the last 100 traces (older traces are dropped).
- `getTraceId()` returns a lazily-generated `randomUUID()` trace ID, reused across the same request.
- When `enabled` is `false`, all operations are no-ops (the `NO_OP_SEGMENT` singleton is used).
- `shouldSample()` uses `Math.random() < samplingRate` for probabilistic local sampling.

### Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| `samplingRate` is mock-only (ignored in AWS) | Code relying on `samplingRate` to control production trace volume will not behave as expected | Documented in README and JSDoc. Production sampling is controlled by X-Ray sampling rules — this is the correct architecture (X-Ray rules are dynamic, per-service, and centrally managed) |
| No X-Ray service map | Cannot visualize service dependencies locally | No mitigation — service map is an X-Ray console feature. Use sandbox testing for dependency visualization |
| No cross-service trace propagation | Traces do not span across multiple Lambda invocations locally | No mitigation — trace propagation requires X-Ray daemon infrastructure |
| No trace visualization | Cannot view waterfall/timeline views locally | Mock logs structured JSON with timing; `.bb-data/` files provide raw trace data |
| Trace ID format differs from X-Ray | Mock uses UUID; X-Ray uses `1-{hex timestamp}-{hex random}` format | No impact on correctness — format difference is cosmetic. Sandbox testing covers real X-Ray format |
| No IAM enforcement | Permission errors only surface in AWS | No mitigation at mock level — IAM is handled by CDK configuration automatically |
| `getTraceId()` null behavior differs | Mock always returns a value when enabled (lazily generated UUID); AWS returns `null` when there is no active trace context (X-Ray enabled but `_X_AMZN_TRACE_ID` unset). Code that only tests against mock may never exercise the `null` branch | Documented in JSDoc. Callers must handle a `null` return; sandbox testing covers the AWS no-active-trace path |

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| No OpenTelemetry | X-Ray SDK is the native AWS choice with zero config on Lambda. OTel adds complexity (collector, exporters) without benefit for single-service tracing |
| No auto-instrumentation | Auto-tracing every BB call (KVStore.get, FileBucket.put) generates excessive trace data and couples tracing to all other BBs. Explicit `startSegment` gives customers control over what is traced |
| Logging correlation via `getTraceId()` | Rather than coupling Tracer and Logging BBs internally, expose `getTraceId()` so customers can pass it to their logger. Keeps BBs independent and composable |
| Composite BB (no new resources) | Lambda has built-in X-Ray integration — Tracer just activates it and provides a structured API on top. No DynamoDB tables, no SQS queues, no additional cost beyond X-Ray pricing |
| `samplingRate` mock-only | In production, X-Ray sampling rules are the correct control plane (dynamic, per-service, centrally managed). A per-instance `samplingRate` option would conflict with X-Ray's sampling. The mock needs it because there is no X-Ray sampling infrastructure locally |
| Interface-based Segment | Allows no-op singleton for disabled/unsampled traces without allocating objects. Decouples consumers from implementation differences across mock/AWS/browser |
