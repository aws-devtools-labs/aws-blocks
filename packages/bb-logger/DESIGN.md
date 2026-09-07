# Logger — Design

Design document for Logger. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-logger`
**Type:** Composite (optional infrastructure)
**AWS Service:** Amazon CloudWatch Logs (via Lambda's built-in log integration)

## Infrastructure (CDK)

The framework owns a single CloudWatch Logs LogGroup for the shared handler
Lambda (created by the `BlocksStack`/`BlocksBackend` with retention from the
stack-wide `defaults.logRetention`). The Logger construct **reconfigures that
group's retention** rather than creating its own:

- **Retention:** Resolved as `options.retention ?? scope.defaults.logRetention`
  and applied to the shared handler log group via the L1 escape hatch
  (`CfnLogGroup.retentionInDays`). An explicit per-Logger `retention` wins over
  the stack-wide default; both target the one group.
- **When `retention` is omitted:** The group keeps the stack-wide
  `defaults.logRetention` already applied by the BlocksStack/BlocksBackend.
- **No second LogGroup:** Logger deliberately does not create a
  `/aws/lambda/${handler.functionName}` group of its own — that would collide
  with the framework-owned group on the log-group name.
- **Log level env var:** Sets `LOG_LEVEL` on the shared Lambda handler when
  `options.level` is configured. Multiple Logger BBs can coexist with different
  levels via constructor options.

## Serialization Format

Each log entry is a single-line JSON object written to stdout (debug/info/warn) or stderr (error):

```json
{
  "level": "info",
  "message": "Request handled",
  "timestamp": "2025-01-15T12:00:00.000Z",
  "logger": "app",
  "method": "GET",
  "path": "/users"
}
```

Fields:
- `level` — Log severity (`debug`, `info`, `warn`, `error`).
- `message` — The log message string.
- `timestamp` — ISO 8601 timestamp from `new Date().toISOString()`.
- `logger` — The `id` passed to the constructor.
- `traceId` — X-Ray trace ID (auto-injected from `_X_AMZN_TRACE_ID` env var when present).
- Spread fields from `defaultContext`, `child()` context, and per-call `context` (later wins).

### Serialization Safety

- **Circular references** → replaced with `"[Circular]"` via WeakSet tracking.
- **BigInt values** → converted to string representation.
- **Functions/Symbols** → replaced with `"[unserializable]"`.
- **Error objects in context** → extracted to `{ name, message, stack }`.
- **Serialization failure** → emits a degraded entry with `_serializationError: 'SerializationFailedException'`.

## Interface Decisions

### Synchronous Methods

All logging methods are **synchronous**. This is an intentional deviation from the "Async by Default" guideline. Logging writes to stdout/stderr which Lambda captures asynchronously. Returning a Promise would add overhead for zero benefit — logging should never block.

### Child Loggers

`child()` returns a `ChildLogger` interface (not a full `Logger` Scope node). Children:
- Inherit the parent's log level and default context.
- Merge additional context on top (later wins on key conflicts).
- Can be nested arbitrarily (`child().child().child()`).
- Are lightweight objects — no Scope registration, no CDK constructs.

### Log Level Resolution

Priority order (highest wins):
1. Constructor `options.level`
2. Global env var: `LOG_LEVEL`
3. Default: `'info'`

## Mock Implementation

The mock entry point (`index.mock.ts`) re-exports the AWS runtime (`index.aws.ts`) directly. Both environments use the same code: write structured JSON to `process.stdout` / `process.stderr`. There is no mock-specific behavior because the logging mechanism (stdout/stderr → CloudWatch) is provided by the Lambda runtime, not by the BB.

- No files created in `.bb-data/` — logs are ephemeral.
- `retention` option is accepted but ignored (no local CloudWatch equivalent).
- Log level filtering works identically to production.

### Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| No CloudWatch Logs Insights | Cannot test Insights queries locally | Sandbox testing for Insights queries |
| No log retention enforcement | Logs are ephemeral in local terminal | No mitigation needed — local logs don't persist |
| No log group/stream structure | Cannot test subscription filters | Sandbox testing covers these |
| No X-Ray trace ID injection | `traceId` field absent locally | Set `_X_AMZN_TRACE_ID` env var manually if needed |
