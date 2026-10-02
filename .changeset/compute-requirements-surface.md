---
"@aws-blocks/core": minor
"@aws-blocks/bb-lambda-compute": minor
"@aws-blocks/blocks": minor
---

Declare a compute by what a workload needs, not by which service runs it.

`ComputeProvider.provide()` takes an id and what the workload needs — `{ timeoutSeconds, memoryMb }` — and returns a compute:

```ts
const reports = ComputeProvider.provide('reports', { timeoutSeconds: 60 * 4, memoryMb: 1024 });
```

The app never names the service that fulfils the request. Today every declaration resolves to a serverless (Lambda) compute; when another fulfillment exists, the same declaration resolves differently without a call site changing. The returned value is a compute handle — under CDK it is a `Compute`, now exported as a type from `@aws-blocks/core/cdk` — and `new LambdaCompute(scope, id)` remains supported and equally valid for an app that wants to name its platform. The surface that assigns a declared compute to an API namespace or worker arrives next; this release ships the declaration itself.

Requirements are validated against the fulfillment that exists today, and an impossible request fails with a message naming the field, the requested value, the ceiling, and what to do instead. Failing is deliberate: there is no compute-type escape hatch yet, so a workload needing more than serverless allows has nowhere to go, and silently clamping it would produce an app that deploys and then times out under load. The check is pure and runs in every environment, so a bad value fails the first time the app runs locally rather than only at `cdk synth`.

Requirements stay out of the compute packages: a compute takes the settings its own platform understands (`LambdaCompute` gained `timeout` and `memorySize`), and translating requirements into them belongs to whoever declares the compute. That is what lets a second fulfillment map the same requirements differently. `LambdaCompute.timeout` accepts either a `cdk.Duration` or a plain number of seconds, so a caller can set one without importing `aws-cdk-lib`. Its previous hardcoded values — 2048 MiB and the 15-minute maximum timeout — are now its defaults, so an app that never configures a compute is unaffected.

No `computeType` selector and no container `image` option: a single-valued enum would imply a choice that does not exist, and nothing could fulfil an image yet. Both arrive with the container fulfillment that makes them real.
