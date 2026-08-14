# @aws-blocks/bb-cron-job

Scheduled task execution backed by EventBridge Scheduler and Lambda.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick Reference

**Common Operations → Configuration**

| What you want | How to configure |
|---------------|-----------------|
| Run every N minutes | `schedule: 'rate(5 minutes)'` |
| Run every hour | `schedule: 'rate(1 hour)'` |
| Run daily at 9 AM UTC | `schedule: 'cron(0 9 * * ? *)'` |
| Run daily at 9 AM Pacific | `schedule: 'cron(0 9 * * ? *)', timezone: 'America/Los_Angeles'` |
| Pass data to handler | `input: { mode: 'full' }` |
| Disable until manually triggered | `enabled: false` |

**Keywords:** cron, schedule, timer, periodic, recurring, rate, EventBridge, background, interval

## Quick Start

```typescript
import { Scope } from '@aws-blocks/core';
import { CronJob } from '@aws-blocks/bb-cron-job';

const scope = new Scope('my-app');

const cleanup = new CronJob(scope, 'cleanup', {
  schedule: 'rate(1 hour)',
  handler: async (event) => {
    console.log(`Running cleanup at ${event.scheduledTime}`);
    await deleteExpiredRecords();
  },
});
```

## When to Use

- Running periodic cleanup tasks (expired sessions, stale data)
- Generating scheduled reports
- Cache warming on a timer
- Data synchronization between systems
- Periodic health checks or monitoring

## When NOT to Use

- One-off async tasks triggered by events or user actions → use `AsyncJob`
- Reacting to data changes → use event subscriptions on the relevant Building Block

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `schedule` | `string` | (required) | Cron or rate expression (see Schedule Expressions below) |
| `handler` | `(event: CronJobEvent<T>) => Promise<void>` | (required) | Function to execute on each invocation. Must be idempotent. |
| `enabled` | `boolean` | `true` | Whether the schedule is active |
| `description` | `string` | — | Human-readable description of the job |
| `timezone` | `string` | `'UTC'` | IANA timezone for cron expressions (e.g., `'America/Los_Angeles'`) |
| `input` | `T` | — | Static payload passed to the handler on every invocation |

## Schedule Expressions

### Rate Expressions

Simple interval-based schedules:

```
rate(1 minute)
rate(5 minutes)
rate(1 hour)
rate(12 hours)
rate(1 day)
rate(7 days)
```

### Cron Expressions

AWS EventBridge cron format (6 fields): `cron(minute hour day-of-month month day-of-week year)`

```
cron(0 9 * * ? *)       → daily at 9:00 AM
cron(0 */2 * * ? *)     → every 2 hours
cron(30 9 ? * MON-FRI *) → weekdays at 9:30 AM
cron(0 0 1 * ? *)       → first day of every month at midnight
```

Use `?` for either day-of-month or day-of-week (one must be `?`).

## Handler Event

The handler receives a `CronJobEvent<T>` with:

| Field | Type | Description |
|-------|------|-------------|
| `scheduledTime` | `string` | ISO 8601 timestamp of the scheduled invocation time |
| `jobName` | `string` | The CronJob's fully-qualified id |
| `input` | `T` | Static input configured on the CronJob (`undefined` when no input is provided) |

## Error Constants

```typescript
import { CronJobErrors } from '@aws-blocks/bb-cron-job';

CronJobErrors.InvalidSchedule  // schedule expression is not a valid cron or rate format
CronJobErrors.InvalidTimezone  // timezone string is not a valid IANA timezone
```

Both errors are thrown at construction time (fail-fast validation).

## Examples

### Cron Schedule with Timezone

```typescript
const dailyReport = new CronJob(scope, 'daily-report', {
  schedule: 'cron(0 9 * * ? *)',
  timezone: 'America/Los_Angeles',
  description: 'Generate and email daily analytics report at 9 AM Pacific',
  handler: async (event) => {
    const data = await analytics.query({ date: event.scheduledTime });
    await email.send('team@example.com', 'Daily Report', formatReport(data));
  },
});
```

### Typed Input

```typescript
new CronJob<{ keys: string[] }>(scope, 'cache-warmer', {
  schedule: 'rate(5 minutes)',
  input: { keys: ['top-products', 'featured'] },
  handler: async (event) => {
    for (const key of event.input.keys) {
      await warmCache(key);
    }
  },
});
```

### Disabled Job (Manual-Only in Dev)

```typescript
const migration = new CronJob(scope, 'data-migration', {
  schedule: 'rate(1 day)',
  enabled: false,
  handler: async () => {
    await migrateRecords();
  },
});
```

### Handler Accessing Other Building Blocks

```typescript
const store = new KVStore(scope, 'sessions');

const sessionCleanup = new CronJob(scope, 'session-cleanup', {
  schedule: 'rate(1 hour)',
  handler: async () => {
    const now = Date.now();
    for await (const session of store.scan()) {
      if (session.expiresAt < now) {
        await store.delete(session.key);
      }
    }
  },
});
```

### Multiple Schedules for One Handler

```typescript
const syncHandler = async (event: CronJobEvent<{ mode: string }>) => {
  if (event.input.mode === 'incremental') await syncIncremental();
  else await syncFull();
};

new CronJob<{ mode: string }>(scope, 'sync-hourly', {
  schedule: 'rate(1 hour)',
  input: { mode: 'incremental' },
  handler: syncHandler,
});

new CronJob<{ mode: string }>(scope, 'sync-daily', {
  schedule: 'cron(0 9 * * ? *)',
  input: { mode: 'full' },
  handler: syncHandler,
});
```

## Best Practices

- **Idempotency:** EventBridge provides at-least-once delivery. Design handlers to tolerate duplicate invocations.
- **Rate expressions** for simple intervals; **cron expressions** for precise timing.
- **Concurrent executions:** If a handler runs longer than the schedule interval, the next invocation starts while the previous is still running. Design for overlap or implement application-level locking with `KVStore`.
- **Failure handling:** Handler exceptions are retried by Lambda's built-in async invoke retry policy (2 retries with exponential backoff). After retries exhaust, the error is logged to CloudWatch.

## Local Development

In local dev mode, CronJob runs schedules in-process:

- Rate schedules use `setInterval`
- Cron schedules calculate the next fire time with timezone support and use `setTimeout`
- Console logs when the job fires: `[CronJob:{id}] triggered at {timestamp}`
- When `enabled: false`, the schedule does not run automatically
- Failed handlers are logged with a warning that AWS would retry

## AWS Deployment

Automatically provisions:

- **EventBridge Schedule:** One `AWS::Scheduler::Schedule` per CronJob instance
- **Shared Lambda:** Targets the shared Lambda (same as API handlers and AsyncJob). No dedicated Lambda per job.
- **IAM role:** Per-stack EventBridge Scheduler role with `lambda:InvokeFunction` permission
- **Schedule name:** Derived from the CronJob's `fullId` (truncated to 64 chars)

## Key Distinction from AsyncJob

CronJob is a **pure infrastructure declaration** — the constructor defines the schedule and handler. There are no runtime methods like `submit()` or `submitBatch()`. The handler runs on the schedule automatically.

| | CronJob | AsyncJob |
|-|---------|----------|
| Trigger | Time-based (cron/rate) | Programmatic (`submit()`) |
| Runtime methods | None | `submit()`, `submitBatch()` |
| Use case | Periodic recurring tasks | One-off event-driven work |
| AWS service | EventBridge Scheduler | SQS + Lambda |
