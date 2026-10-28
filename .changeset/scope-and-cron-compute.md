---
"@aws-blocks/core": minor
"@aws-blocks/bb-cron-job": minor
"@aws-blocks/bb-compute": patch
"@aws-blocks/blocks": minor
---

feat: place a whole scope, or a CronJob, on its own compute

A `Scope` takes `compute`, which places everything created under it, including in
its child scopes, on one `Compute`:

```ts
const reportsCompute = new Compute(scope, 'reports-compute', { type: 'serverless', memory: 4096 });
const reports = new Scope('reports', { parent: scope, compute: reportsCompute });

export const reportsApi = new ApiNamespace(reports, 'reports', (context) => ({ /* methods */ }));
new CronJob(reports, 'nightly', { schedule: 'cron(0 2 * * ? *)', handler: async () => {} });
```

- The nearest setting wins: a block's own `compute`, then the nearest scope's,
  then the app's default compute.
- `AsyncJob` follows a serverless or container scope. `ApiNamespace` and
  `CronJob` run only on a serverless compute for now; under a container scope
  they fail synth with an error that names the compute.
- `Realtime` and `RawRoute` always run on the default compute, inside such a
  scope too. `Realtime.publish()` works from any compute.

`CronJob` also takes its own `compute` (serverless only; a container compute is a
type error). Each job's schedule now gets permission to invoke the function it
targets: before, the shared scheduler role could only invoke the first job's
function, so a job on a different function would have been refused at run time.

In local dev every block still runs in the dev server.
