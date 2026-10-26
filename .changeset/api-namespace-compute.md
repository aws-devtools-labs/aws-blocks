---
"@aws-blocks/core": minor
"@aws-blocks/bb-compute": patch
"@aws-blocks/blocks": minor
---

feat(core): run an API namespace on its own compute

`ApiNamespace` takes an optional fourth argument, `{ compute }`, that runs the
namespace's methods on a `Compute` instead of the app's default compute — for
example to give one namespace more memory (and CPU) or its own scaling:

```ts
import { ApiNamespace, Compute } from '@aws-blocks/blocks';

const reportsCompute = new Compute(scope, 'reports', { type: 'serverless', memory: 4096 });

export const reports = new ApiNamespace(scope, 'reports', (context) => ({
  async build(month: string) {
    // …
  },
}), { compute: reportsCompute });
```

- Clients are unchanged: the TypeScript client, and the Swift, Kotlin and Dart
  clients from `aws-blocks-swift` 0.2.0, `aws-blocks-kotlin` 0.3.0 and the matching
  Dart `blocks_runtime`, call `POST /aws-blocks/api/reports`, and the stack's
  shared API gateway routes that path to the namespace's compute — on every
  `apiFrontDoor` tier and behind `Hosting`, so the API keeps one domain. Calls to
  the bare `/aws-blocks/api` endpoint — raw HTTP calls and older native clients —
  still run on the default compute.
- API calls stay capped at ~29 seconds by the gateway whatever the compute's
  `maxTimeoutSeconds`; run longer work in an `AsyncJob`.
- Routing follows the export name (what the frontend imports), not the second
  `ApiNamespace` argument.
- One `Compute` can host several namespaces and `AsyncJob`s; they then run in
  the same function.
- A `serverless` or a `container` compute can serve API namespaces.
- Namespaces without a `compute`, `RawRoute`s and auth routes stay on the
  default compute. In local dev every namespace still runs in the dev server.
- A `compute` created in a different `BlocksBackend` can't serve this backend's
  API: synth warns, and the namespace runs on this backend's default compute.
