---
"@aws-blocks/bb-container-compute": minor
"@aws-blocks/core": patch
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

Waking takes a few minutes (queue metrics, the scaling alarm, and the task's
start). Computes with `minInstances` of 1 or more deploy the same autoscaling as
before.

Instance bounds are now checked at synth: `minInstances` must be an integer of
0 or more, `maxInstances` an integer of 1 or more, and `minInstances` must not
exceed `maxInstances`.
