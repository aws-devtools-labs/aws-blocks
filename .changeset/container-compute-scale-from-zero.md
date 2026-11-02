---
"@aws-blocks/bb-container-compute": minor
"@aws-blocks/core": minor
"@aws-blocks/bb-compute": patch
---

feat(bb-container-compute): scale a container compute to zero between jobs

A container `Compute` with `scaling: { minInstances: 0 }` now starts a task when
a job is waiting. Before, a service at zero tasks never woke for a backlog
smaller than `backlogPerInstance` (default 100), so its jobs were never run.

```ts
const worker = new Compute(scope, 'worker', {
  type: 'container',
  scaling: { minInstances: 0, maxInstances: 2 },
});
```

Use `minInstances: 0` only for long-running jobs that can tolerate high latency
before they start. Waking usually takes a few minutes (queue metrics, the
scaling alarm, and the task's start), and up to about 20 minutes when the job's
queue has been idle for more than six hours. Computes with `minInstances` of 1
or more deploy the same autoscaling as before.

`scaling.minInstances` is now optional and defaults to `1`, the recommended
value: `scaling: { maxInstances: 10 }` keeps one task running.

Instance bounds are now checked at synth: `minInstances` must be an integer of
0 or more, `maxInstances` an integer of 1 or more, and `minInstances` must not
exceed `maxInstances`.
