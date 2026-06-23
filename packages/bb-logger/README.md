# @aws-blocks/bb-logger

Structured logging with consistent JSON format, log levels, and contextual metadata.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## When to Use

- You need structured, queryable application logs
- You want consistent log format across your backend
- You need request-scoped loggers with correlation IDs
- You want log level filtering without code changes

## When NOT to Use

- For numeric measurements over time → use `Metrics`
- For distributed request tracing → use `Tracing`

## Quick Start

```typescript
import { Scope } from '@aws-blocks/core';
import { Logger } from '@aws-blocks/bb-logger';

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

**Options:**
- `level` — Minimum log level (`'debug' | 'info' | 'warn' | 'error'`). Default: `'info'`.
- `defaultContext` — Fields included in every log entry.
- `retention` — CloudWatch Logs retention (days). Creates a LogGroup when set.

### Methods

```typescript
log.debug(message: string, context?: Record<string, unknown>): void
log.info(message: string, context?: Record<string, unknown>): void
log.warn(message: string, context?: Record<string, unknown>): void
log.error(message: string, context?: Record<string, unknown>): void
log.child(context: Record<string, unknown>): ChildLogger
```

All log methods are **synchronous** (no await needed).

### Log Entry Format

Every log entry is a JSON object written to stdout (or stderr for errors):

```json
{
  "level": "info",
  "message": "User logged in",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "logger": "app",
  "userId": "user-123"
}
```

### Child Loggers

Create request-scoped loggers that inherit context:

```typescript
const requestLog = log.child({ requestId: 'req-abc', userId: 'u-123' });
requestLog.info('Processing request');
// Output includes requestId and userId automatically
```

Children can be nested:

```typescript
const dbLog = requestLog.child({ component: 'database' });
dbLog.warn('Slow query', { table: 'users', durationMs: 500 });
```

## Log Level Precedence

1. Constructor `level` option (highest priority)
2. `LOG_LEVEL` environment variable
3. Default: `'info'`

This allows ops teams to change log levels without code changes via the
`LOG_LEVEL` env var (set automatically by the CDK construct).

## Error Object Handling

Error instances passed in context are automatically extracted:

```typescript
try {
  await doSomething();
} catch (err) {
  log.error('Operation failed', { err });
  // err is serialized as { name, message, stack }
}
```

## Serialization Safety

The logger handles edge cases gracefully:
- **Circular references** → replaced with `"[Circular]"`
- **BigInt values** → converted to string
- **Functions/Symbols** → replaced with `"[unserializable]"`
- **Errors in context** → extracted to `{ name, message, stack }`

## Retention (Production)

Set `retention` to create a CloudWatch Logs LogGroup with a retention policy:

```typescript
const log = new Logger(scope, 'app', {
  level: 'warn',
  retention: 30,  // 30 days
});
```

Without `retention`, Lambda's auto-created log group applies (logs never expire).

Valid retention values: 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653 days.

**Note on CDK stack teardown:** When `retention` is specified, the Logger BB creates a CloudWatch Logs LogGroup with automatic cleanup enabled (RemovalPolicy.DESTROY). This ensures that E2E test stacks and ephemeral deployment stacks can be torn down cleanly. Production stacks using `RemovalPolicies.of(stack).destroy()` will also delete the LogGroup on stack destruction.

## Local Development

In local dev (`npm run dev`), the Logger BB:
- Writes structured JSON to stdout/stderr (same as production)
- Does NOT persist logs to disk
- Does NOT create any files in `.bb-data/`
- `retention` option is ignored locally
- `LOG_LEVEL` env var works the same way

## Errors

```typescript
import { LoggingErrors } from '@aws-blocks/bb-logger';

LoggingErrors.SerializationFailed // 'SerializationFailedException'
```

This error is used as a marker in degraded log entries when context
serialization fails (not thrown to consumers).
