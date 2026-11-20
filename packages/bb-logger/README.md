# @aws-cdk-blocks/bb-logger

Structured logging with consistent JSON format, log levels, and contextual metadata.

**When to use:** You need structured, queryable application logs, or request-scoped loggers with correlation IDs.

**When NOT to use:** For numeric measurements over time, use `Metrics`. For distributed request tracing, use `Tracer`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick start

```typescript
import { Scope } from '@aws-cdk-blocks/core';
import { Logger } from '@aws-cdk-blocks/bb-logger';

const scope = new Scope('my-app');
const log = new Logger(scope, 'app');

log.info('Server started', { port: 3000 });
log.warn('Slow query', { durationMs: 1500 });
log.error('Request failed', { err: new Error('timeout') });
```

## API

### Constructor

```typescript
new Logger(scope: ScopeParent, id: string, options?: LoggingOptions)
```

### Methods

```typescript
log.debug(message: string, context?: Record<string, unknown>): void
log.info(message: string, context?: Record<string, unknown>): void
log.warn(message: string, context?: Record<string, unknown>): void
log.error(message: string, context?: Record<string, unknown>): void
log.child(context: Record<string, unknown>): ChildLogger
```

All log methods are **synchronous** (no await needed).

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `level` | `'debug' \| 'info' \| 'warn' \| 'error'` | `'info'` | Minimum log level; entries below it are dropped. Set only here: there is no `LOG_LEVEL` env var |
| `defaultContext` | `Record<string, unknown>` | `{}` | Fields included in every log entry. The entry's own keys (`level`, `message`, `timestamp`, `logger`, `traceId`, `awsRequestId`) are reserved: a context value under one of them is ignored |

Log retention is not a Logger option — it is a compute-level setting (see [Retention](#retention-production) below).

### Log Entry Format

Every log entry is a JSON object written to stdout (or stderr for errors):

```json
{
  "level": "info",
  "message": "User logged in",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "logger": "app",
  "awsRequestId": "c6af9ac6-7b61-11e6-9a41-93e8deadbeef",
  "userId": "user-123"
}
```

`traceId` is the X-Ray trace id: the `Root=` part of the `_X_AMZN_TRACE_ID` environment variable, the same id `getTraceId()` of an enabled `Tracer` returns on AWS. An entry carries it when that variable is set; it is absent in local dev.

`awsRequestId`:

- On the Lambda functions AWS CDK Blocks runs through `createLambdaHandler` (the backend API and its event handlers), it is the invocation's request id (the same id as in the function's `START`/`END`/`REPORT` lines), added to every line automatically.
- To find everything one request logged, query by it, for example with CloudWatch Logs Insights: `filter awsRequestId = "<id>"`.
- Your own correlation fields, such as a `requestId` passed to `child()`, are separate keys and are kept as is.
- Local dev, SSR hosting web functions and container compute set no request id, so the field is absent there.

### Child Loggers

Create request-scoped loggers that inherit context:

```typescript
const requestLog = log.child({ requestId: 'req-abc', userId: 'u-123' });
requestLog.info('Processing request');
// Output includes requestId and userId automatically
```

A child's `child()` adds to the inherited context.

## Serialization Safety

Context values that JSON cannot represent:
- **Circular references** → replaced with `"[Circular]"`
- **BigInt values** → converted to string
- **Functions/Symbols** → replaced with `"[unserializable]"`
- **Errors in context** → extracted to `{ name, message, stack }`

## Retention (Production)

Logging is always on. Every compute captures its handler's stdout to its own CloudWatch log
group, which carries the stack-wide default retention (`defaults.logRetention` —
one week in sandbox, one year in production).

In `cdk-blocks/index.cdk.ts`, add the `RetentionDays` import and replace the inline
`defaults` value as shown in this API-only scaffold excerpt. Spreading the selected
preset keeps its other settings; `logRetention` overrides retention for every compute's handler log group.

```typescript
import { BlocksStack, BlocksPresets } from 'aws-cdk-blocks/cdk';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: {
    ...(sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production),
    logRetention: RetentionDays.ONE_MONTH,
  },
});
```

In the Amplify scaffold, make the same inline `defaults` change in
`BlocksBackend.create(stack, 'blocks', …)` instead.

A `Logger` does not configure retention — the compute owns the single,
framework-owned handler log group. To override the default for one compute, set
`logRetention` on that `Compute`.

## Errors

```typescript
import { LoggingErrors } from 'aws-cdk-blocks';

LoggingErrors.SerializationFailed // 'SerializationFailedException'
```

This error is used as a marker in degraded log entries when context
serialization fails (not thrown to consumers).

## Local development

In local dev (`npm run dev`), the Logger BB:
- Writes structured JSON to stdout/stderr (same as production)
- Writes nothing to disk (no `.cdk-blocks/local/data/` files)
- Writes no `awsRequestId` field: the dev server doesn't set a request id

Retention has no local effect.
