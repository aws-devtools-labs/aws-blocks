---
"@aws-blocks/bb-cron-job": minor
---

feat(bb-cron-job): run a CronJob on a container compute for long-running jobs

`CronJob` takes the same `compute` and `timeoutSeconds` options as `AsyncJob`.
Assign a container `Compute` to run a scheduled job longer than a serverless
compute's 15-minute limit:

```ts
import { Compute, CronJob } from '@aws-blocks/blocks';

const worker = new Compute(scope, 'worker', { type: 'container', size: { vcpu: 1, memory: 2048 } });

new CronJob(scope, 'nightly-rebuild', {
  schedule: 'cron(0 3 * * ? *)',
  compute: worker,
  timeoutSeconds: 2 * 60 * 60,
  handler: async () => {
    // ...
  },
});
```

On a container compute each tick is delivered like a container `AsyncJob`: the
handler runs in its own worker thread, `timeoutSeconds` is enforced, and a
failed tick is retried up to 3 attempts in total before moving to a dead-letter
queue. Jobs on the default serverless compute deploy as before.

Also fixes the shared scheduler role, which granted invoke on only the first
CronJob's function. Each CronJob now grants access to its own target.
