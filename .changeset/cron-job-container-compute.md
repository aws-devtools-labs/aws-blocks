---
"@aws-blocks/bb-cron-job": minor
"@aws-blocks/blocks": patch
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
queue. A CronJob under a container scope (`new Scope(id, { parent, compute })`)
now runs on that container instead of failing synth. Jobs on a serverless
compute deploy as before.
