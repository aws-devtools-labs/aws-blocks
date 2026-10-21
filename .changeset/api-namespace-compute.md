---
"@aws-blocks/core": minor
"@aws-blocks/bb-compute": patch
"@aws-blocks/blocks": patch
---

feat(core): run an API namespace on its own compute

`ApiNamespace` takes an optional fourth argument, `{ compute }`, that runs the
namespace's methods on a `Compute` instead of the app's default compute — for
example to give one namespace more memory or a longer timeout, or to keep a slow
namespace from competing with latency-sensitive ones:

```ts
import { ApiNamespace, Compute } from '@aws-blocks/blocks';

const reportsCompute = new Compute(scope, 'reports', { type: 'serverless', memory: 2048, maxTimeoutSeconds: 120 });

export const reports = new ApiNamespace(scope, 'reports', (context) => ({
  async build(month: string) {
    // …
  },
}), { compute: reportsCompute });
```

- The client is unchanged: it still calls `POST /aws-blocks/api/reports`, and
  the stack's shared API gateway routes that path to the namespace's compute —
  on every `apiFrontDoor` tier and behind `Hosting`, so the API keeps one domain.
- Routing follows the export name (what the frontend imports), not the second
  `ApiNamespace` argument.
- One `Compute` can host several namespaces and `AsyncJob`s; they then run in
  the same function.
- Only `serverless` computes can serve API namespaces for now; a `container`
  compute is a type error.
- Namespaces without a `compute`, `RawRoute`s and auth routes stay on the
  default compute. In local dev every namespace still runs in the dev server.
