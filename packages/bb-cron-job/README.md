# @aws-cdk-blocks/bb-cron-job

Scheduled task execution backed by EventBridge Scheduler and Lambda, or a container compute for long-running jobs.

**When to use:** Work that runs on a fixed schedule: cleanup, report generation, cache warming, data synchronization.

**When NOT to use:** Work started by a request or an event: use `AsyncJob`. `CronJob` has no runtime methods, so code cannot start a run.

**Keywords:** cron, schedule, timer, periodic, recurring, rate, EventBridge, background, interval

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick start

```typescript
import { Scope } from '@aws-cdk-blocks/core';
import { CronJob } from '@aws-cdk-blocks/bb-cron-job';

const scope = new Scope('my-app');

const cleanup = new CronJob(scope, 'cleanup', {
  schedule: 'rate(1 hour)',
  handler: async (event) => {
    console.log(`Running cleanup at ${event.scheduledTime}`);
    await deleteExpiredRecords();
  },
});
```

## API

`new CronJob<T>(scope, id, options)`. `T` is the type of `input`. The constructor declares the schedule and the handler; the instance has no methods to call at runtime.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `schedule` | `string` | (required) | Cron or rate expression (see [Schedule expressions](#schedule-expressions)) |
| `handler` | `(event: CronJobEvent<T>) => Promise<void>` | (required) | Function to execute on each invocation. Must be idempotent: delivery is at-least-once. |
| `enabled` | `boolean` | `true` | `false` deploys the schedule in the `DISABLED` state: it does not fire, on AWS or locally. There is no way to run a disabled job by hand. |
| `description` | `string` | — | Human-readable description of the job |
| `timezone` | `string` | `'UTC'` | IANA timezone for cron expressions (e.g., `'America/Los_Angeles'`). Rate expressions ignore it. |
| `input` | `T` | — | Static payload passed to the handler on every invocation |
| `logger` | `ChildLogger` | — | Optional logger for internal operations; defaults to a Logger at error level |
| `compute` | `Compute` | the scope's compute | The `Compute` to run the handler on: serverless for its own function, container for long-running work (see [Running on its own compute](#running-on-its-own-compute)) |
| `timeoutSeconds` | `number` | — | Wall-clock limit for one tick. On a container the runtime terminates the tick's worker at the deadline; on serverless it's bounded by the function timeout. |

### Handler event

The handler receives a `CronJobEvent<T>` with:

| Field | Type | Description |
|-------|------|-------------|
| `scheduledTime` | `string` | ISO 8601 timestamp of the scheduled invocation time |
| `jobName` | `string` | The CronJob's fully-qualified id |
| `input` | `T` | Static input configured on the CronJob (`undefined` when no input is provided) |

## Errors

```typescript
import { CronJobErrors } from 'aws-cdk-blocks';
```

| Constant | `error.name` | Thrown when |
|----------|--------------|-------------|
| `CronJobErrors.InvalidSchedule` | `InvalidScheduleExpression` | Construction (local) or synth: an invalid rate expression, unrecognized expression, or cron with the wrong field count. With six cron fields, synth leaves field values to EventBridge; the local parser also checks the fields it simulates. |
| `CronJobErrors.InvalidTimezone` | `InvalidTimezoneExpression` | Construction (local) or synth time: `timezone` is not a valid IANA timezone. |
| `CronJobErrors.ScheduleNotSupported` | `ScheduleNotSupportedInMock` | Local mock only, at construction: a valid cron expression uses `L`, `W` or `#` in a day field. The schedule deploys and runs on AWS; the mock cannot simulate it. |
| `CronJobErrors.UnsupportedCompute` | `UnsupportedComputeException` | Synth time: the resolved compute is not a serverless or container compute, or belongs to another backend. |

## Schedule expressions

Rate: `rate(<n> <unit>)`, where the unit is `minute`, `hour` or `day`, singular for 1 and plural otherwise: `rate(1 hour)`, `rate(5 minutes)`, `rate(7 days)`.

Cron: AWS EventBridge cron format (6 fields): `cron(minute hour day-of-month month day-of-week year)`

```
cron(0 9 * * ? *)       → daily at 9:00 AM
cron(0 */2 * * ? *)     → every 2 hours
cron(30 9 ? * MON-FRI *) → weekdays at 9:30 AM
cron(0 0 1 * ? *)       → first day of every month at midnight
```

Use `?` for either day-of-month or day-of-week (one must be `?`).

Cron expressions are evaluated in `timezone`: `schedule: 'cron(0 9 * * ? *)', timezone: 'America/Los_Angeles'` runs daily at 9:00 AM Pacific.

## Running on its own compute

By default the handler runs on its scope's compute, which is the app's default
compute unless the scope sets one (`new Scope(id, { parent, compute })`). Pass a
serverless `Compute` to give the job its own function, for example more memory
or a longer timeout than the API's:

```typescript
import { Compute, CronJob } from 'aws-cdk-blocks';

const reports = new Compute(scope, 'reports', { type: 'serverless', memory: 2048, maxTimeoutSeconds: 900 });

new CronJob(scope, 'monthly-report', {
  schedule: 'cron(0 3 1 * ? *)',
  compute: reports,
  handler: async () => { /* … */ },
});
```

### Running on a container compute

A serverless compute (Lambda) stops a handler after at most 15 minutes. Assign
a container `Compute` for a job that runs longer, using the same `Compute`
objects and `timeoutSeconds` option as `AsyncJob`:

```ts
import { Compute } from 'aws-cdk-blocks';

const worker = new Compute(scope, 'worker', {
  type: 'container',
  size: { vcpu: 1, memory: 2048 },
  scaling: { minInstances: 1, maxInstances: 2 },
});

new CronJob(scope, 'nightly-rebuild', {
  schedule: 'cron(0 3 * * ? *)',
  compute: worker,
  timeoutSeconds: 60 * 60 * 2,   // may run 2 hours, enforced by the runtime
  handler: async (event) => { /* ... */ },
});
```

A container inherited from the scope works the same way. For `scaling.minInstances`,
which decides how soon a tick starts and what the container costs between ticks,
see [Compute scaling](../bb-compute/README.md#scaling).

## Delivery and retries

| Compute | Delivery | When the handler fails |
|---------|----------|------------------------|
| Serverless | EventBridge Scheduler invokes the compute's function directly. | Lambda's async invoke retry policy retries twice with exponential backoff. After that the error is logged to CloudWatch. |
| Container | The schedule sends each tick to the queue of an internal `AsyncJob`, and the container drains it. Each tick runs in its own worker thread. | A tick that throws or times out is retried, up to 3 attempts in total, then moved to a dead-letter queue. |

- **Overlap:** If a handler runs longer than the schedule interval, the next invocation starts while the previous is still running, on a serverless and on a container compute (a container runs up to its concurrency limit of ticks at once). Design for overlap or implement application-level locking with `KVStore`.
- **Deploys (container):** A deploy that changes your code restarts a tick that is still running after about 2 minutes. The tick runs again from the start, and the restart counts as one of its 3 attempts.

## Examples

### Typed input

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

To run one handler on several schedules, create one `CronJob` per schedule and vary `input`.

## What it provisions (AWS)

- **EventBridge Schedule:** One `AWS::Scheduler::Schedule` per CronJob instance, named after the CronJob's `fullId` (truncated to 64 chars).
- **IAM role:** One EventBridge Scheduler role per backend, with access to each job's target: `lambda:InvokeFunction` for serverless jobs or `sqs:SendMessage` for container jobs. Its trust policy is limited to schedules in the stack's account and region.
- **Serverless jobs:** Each schedule targets its resolved function. No dedicated Lambda is created per job.
- **Container jobs:** An internal `AsyncJob` with its queue and dead-letter queue. The schedule targets the queue.

## Local development

In local dev mode, CronJob runs schedules in-process:

- Rate and cron schedules fire on their real schedule, with `timezone` applied to cron expressions. If a tick was due while the process was suspended (for example, during machine sleep), the job runs once on wake and skips the other missed slots.
- Console logs when the job fires: `[CronJob:{id}] triggered at {timestamp}`
- When `enabled: false`, the job is registered and the schedule does not run.
- A failed handler is logged with a warning that AWS would retry. The mock does not retry it.
- Handlers run in the dev server whatever the compute: a container compute's worker isolation and `timeoutSeconds` are not reproduced.
- A cron expression that uses `L`, `W` or `#` throws `CronJobErrors.ScheduleNotSupported` (see [Errors](#errors)). Deploy to a sandbox to exercise it.
- The mock ignores the year field: `cron(0 0 1 1 ? 2030)` fires every January 1 locally.
