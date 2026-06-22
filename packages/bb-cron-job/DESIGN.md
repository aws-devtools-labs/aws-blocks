# CronJob — Design

Design document for CronJob. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-cron-job`
**Re-exported from:** `@aws-blocks/blocks`
**Type:** Primitive (new infrastructure, no runtime methods)
**AWS Service:** Amazon EventBridge Scheduler + shared Lambda

## Overview

CronJob provides scheduled task execution on a cron or rate schedule. It targets periodic jobs like cleanup, report generation, data sync, and cache warming.

**Key distinction from AsyncJob:** CronJob has no runtime methods — the constructor defines the schedule and handler. AsyncJob has `.submit()` and `.submitBatch()`. CronJob is a pure infrastructure declaration; AsyncJob is a programmable runtime primitive.

## Architecture

```
EventBridge Scheduler (AWS)
    └── CfnSchedule (one per CronJob instance)
         ├── scheduleExpression (cron or rate)
         ├── scheduleExpressionTimezone (IANA timezone)
         └── target: shared Lambda (via IAM role)
              └── routes event by { source: 'blocks.cronjob', jobName }
                   └── invokes registered handler

Local Mock
    └── CronJob class (extends Scope)
         ├── rate schedules: setInterval
         ├── cron schedules: setTimeout → nextCronTime calculation
         └── handler called with CronJobEvent<T>
```

## Design Decisions

### D-CJ-1: No runtime methods (infrastructure-only BB)

**Decision:** CronJob exposes no callable runtime methods. The constructor defines the schedule and handler — there is nothing to call at runtime.

**Rationale:**
- **Conceptual clarity** — a scheduled job IS the schedule + handler. There's no "use the cron job" action in application code.
- **Simplicity** — no SDK client, no queue URL, no environment variable plumbing. Pure infrastructure declaration.
- **Separation from AsyncJob** — AsyncJob is the runtime primitive (submit/submitBatch). CronJob is the infrastructure primitive.

### D-CJ-2: Shared Lambda target (not dedicated per-job Lambda)

**Decision:** CronJob targets the shared API Lambda (same as API handlers and AsyncJob). No dedicated Lambda per job.

**Rationale:**
- **Resource efficiency** — one Lambda function handles all routes, async jobs, and cron jobs. No per-job cold starts or idle cost.
- **Composition** — CronJob handlers can access other Building Blocks (KVStore, FileBucket, etc.) because they share the same Lambda environment with all permissions already granted.
- **Consistency** — same execution model as AsyncJob. Same timeout (15 min), same memory, same observability.
- **Trade-off** — per-job timeout and memory cannot be configured independently; all jobs share the handler Lambda's settings.

### D-CJ-3: EventBridge Scheduler (not EventBridge Rules)

**Decision:** Use `AWS::Scheduler::Schedule` (EventBridge Scheduler), not `AWS::Events::Rule` (EventBridge Rules).

**Rationale:**
- **Timezone support** — Scheduler natively supports `ScheduleExpressionTimezone`. Rules do not.
- **At-least-once delivery** — Scheduler guarantees at-least-once invocation with built-in retry.
- **Flexible time windows** — Scheduler supports `FlexibleTimeWindow` for jitter (configured to OFF).
- **One-time schedules** — Scheduler supports `at()` expressions for one-time invocations.
- **Dedicated service** — Scheduler is purpose-built for invoking targets on a schedule; Rules is a broader event routing service.

### D-CJ-4: Schedule validation at construction time (mock only)

**Decision:** `schedule` and `timezone` are validated immediately in the mock constructor. Invalid expressions throw synchronously. The CDK construct does not validate — it defers to EventBridge's own validation at deploy time.

**Rationale:**
- **Fail fast in local dev** — developers see errors immediately when running locally, not after a 2-minute CDK deploy.
- **No partial state** — if the mock constructor throws, no timer is started.
- **CDK defers intentionally** — EventBridge may support expressions the mock parser doesn't understand; deferring avoids false negatives.

### D-CJ-5: Shared IAM role across CronJob instances

**Decision:** A single `BlocksSchedulerRole` is created per CloudFormation stack (keyed by a Symbol). All CronJob instances in the stack share this role.

**Rationale:**
- **Resource efficiency** — avoids creating N IAM roles for N cron jobs. One role with `lambda:InvokeFunction` scoped to the shared Lambda is sufficient.
- **Simplicity** — no per-job role management, no cross-references between jobs.
- **Security** — the role can only invoke the shared Lambda (least privilege for the scheduler service).

### D-CJ-6: Event routing via `source` + `jobName`

**Decision:** EventBridge sends `{ source: 'blocks.cronjob', jobName: fullId, scheduledTime, input }` as the Lambda payload. The Lambda handler routes to the correct CronJob handler by matching `jobName`.

**Rationale:**
- **Same pattern as AsyncJob** — AsyncJob routes by event source ARN; CronJob routes by `source` field. Consistent dispatch model.
- **No extra infrastructure** — no SQS queue, no SNS topic. Direct Lambda invocation via EventBridge.
- **Debugging** — `jobName` in the payload makes CloudWatch logs self-identifying.

## Infrastructure (CDK)

Creates the following resources per CronJob instance:

- **EventBridge Schedule** — `AWS::Scheduler::Schedule` with the specified cron/rate expression.
- **Schedule name** — derived from `scope.fullId`, truncated to 64 characters.
- **Timezone** — passed to `ScheduleExpressionTimezone`. Defaults to UTC.
- **Input** — JSON payload embedded in `Target.Input` containing `{ source, jobName, scheduledTime, input }`.
- **State** — `ENABLED` or `DISABLED` based on the `enabled` option.
- **Flexible time window** — `OFF` (exact timing).
- **Target** — shared Lambda ARN with the shared scheduler IAM role.

Per stack (shared):

- **IAM Role** — `BlocksSchedulerRole` with `lambda:InvokeFunction` scoped to the shared Lambda ARN.

**Removal policy:** DESTROY (sandbox). Schedules are deleted when the stack is destroyed.

No `fromExisting()` — wrapping an existing EventBridge schedule is not supported. CronJob owns the schedule lifecycle.

## AWS Runtime

- CronJob registers a Lambda event handler via `registerLambdaEventHandler('blocks.cronjob', fullId, handler)`.
- When the Lambda receives an event with `source === 'blocks.cronjob'`, it routes to the handler matching `jobName`.
- The handler receives `{ scheduledTime, jobName, input }` — the same `CronJobEvent<T>` shape used in mock.
- `scheduledTime` is resolved by EventBridge at invocation time via the `<aws.scheduler.scheduled-time>` template variable.
- Exposes `bbName` and `bbVersion` properties from auto-generated `version.ts` for observability.
- Creates a default error-level Logger when no custom logger is provided.

## Mock Implementation

- **Rate schedules** — `setInterval` with the computed interval in milliseconds. Timer is `unref()`'d to avoid blocking process exit.
- **Cron schedules** — `setTimeout` to the next fire time, computed via `nextCronTime()`. After each fire, the next timeout is scheduled recursively.
- **Timezone support** — `Intl.DateTimeFormat` with the specified timezone extracts local time components for cron matching.
- **Console logging** — logs `[CronJob:{id}] triggered at {timestamp}` on each fire, and `[CronJob:{id}] registered (disabled)` when `enabled: false`.
- **Error handling** — handler errors are caught and logged with a warning that AWS would retry.
- **Validation** — `parseSchedule()` validates cron/rate expressions; `validateTimezone()` validates IANA timezone strings.
- **Logger** — creates a default error-level Logger when no custom logger is provided via `options.logger`.

### Cron Next-Fire-Time Algorithm

The mock computes the next cron fire time by:
1. Starting 1 minute after `now`, with seconds zeroed.
2. Iterating minute-by-minute (up to 525,600 iterations = 1 year).
3. Checking if the candidate time matches all cron fields (minute, hour, day-of-month, month, day-of-week).
4. For timezone-aware schedules, components are extracted via `Intl.DateTimeFormat`.

This is a brute-force approach that trades performance for correctness. Acceptable for local dev where precision is not critical.

## Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| Local cron timing may drift | Schedule fires at slightly different times than EventBridge | No mitigation — timing precision is not critical for correctness |
| No EventBridge retry in mock | Failed handlers are not retried locally | Mock logs the error with a warning that AWS would retry |
| Handler runs in-process (not isolated) | Shared memory, no cold start, no timeout enforcement | No mitigation — shared Lambda in AWS is also not isolated per-job |
| No concurrency control | Multiple invocations can overlap locally | No mitigation — same behavior in AWS (no per-job concurrency option) |
| No IAM enforcement | Permission errors only surface in AWS | No mitigation — IAM is handled by the shared Lambda's grants |
| No schedule validation in CDK | Invalid expressions only fail at deploy time (EventBridge rejects) | Mock validates locally; developers catch errors in local dev first |

## Trade-offs

| Decision | Trade-off |
|----------|-----------|
| No runtime methods | Cannot dynamically modify schedule at runtime, but keeps BB conceptually simple |
| Shared Lambda | Cannot tune per-job memory/timeout, but avoids resource sprawl |
| EventBridge Scheduler over Rules | Smaller community/docs surface, but better timezone + reliability semantics |
| Brute-force cron calculation | Slow for far-future schedules in mock, but correct and simple |
| Shared IAM role per stack | Cannot scope permissions per-job, but one role is sufficient for lambda:InvokeFunction |
| No `fromExisting()` | Cannot wrap pre-existing schedules, but keeps ownership model clean |

## Integration with AsyncJob

CronJob and AsyncJob are complementary primitives:

| Aspect | CronJob | AsyncJob |
|--------|---------|----------|
| **Trigger** | Time-based (EventBridge schedule) | Event-based (code calls `.submit()`) |
| **Runtime methods** | None (infrastructure-only) | `.submit()`, `.submitBatch()` |
| **AWS service** | EventBridge Scheduler | SQS |
| **Delivery guarantee** | At-least-once (EventBridge) | At-least-once (SQS) |
| **Retry mechanism** | Lambda async invoke retry (2 retries) | SQS visibility timeout + DLQ |
| **Concurrency** | No control (overlapping invocations possible) | SQS-managed (configurable batch size) |
| **Payload** | Static `input` set at deploy time | Dynamic payload per `.submit()` call |
| **Lambda target** | Shared Lambda (same as AsyncJob) | Shared Lambda (same as CronJob) |

Common pattern: CronJob triggers periodic work, which may use AsyncJob for fan-out:

```typescript
const processor = new AsyncJob<{ itemId: string }>(scope, 'processor', {
  handler: async (payload) => { /* process one item */ },
});

new CronJob(scope, 'daily-batch', {
  schedule: 'cron(0 2 * * ? *)',
  handler: async () => {
    const items = await db.query({ stale: true });
    await processor.submitBatch(items.map(i => ({ itemId: i.id })));
  },
});
```
