---
"@aws-blocks/core": minor
---

Add the managed CloudFront **API front door**: a stable public CloudFront origin for the backend HTTP surface, so adding or scaling a compute never changes the browser hostname (auth cookies persist). The client now resolves this origin.

- New `BlocksDefaults.provisionApiFrontDoor` (boolean) gates it: **`true` in `production`, `false` in `sandbox`** (a sandbox is same-origin `localhost` / disposable, so origin stability is moot and the CloudFront propagation isn't worth paying). Apps that spread a `BlocksPresets` preset are unaffected; a hand-rolled `BlocksDefaults` literal must add the field.
- `scheduleFrontDoor` registers a one-shot CDK **aspect** that resolves the front door at synth (after the whole app, including a `Hosting` construct built after `create()`, exists):
  - **Hosting present** → reuse Hosting's distribution (it already fronts `/aws-blocks/api/*`); no second distribution is created.
  - **No Hosting + provisioning on** → create one Blocks-owned `Distribution` (default behavior → the stack's API origin, cookies + `Authorization` forwarded, caching off) and a `FrontDoorUrl` output.
  - **No Hosting + off** → nothing; the client keeps hitting the API Gateway.
- The Blocks-owned distribution and its `FrontDoorUrl` output are scoped under the owning `BlocksStack` / `BlocksBackend`, so several front-door-enabled backends can share one stack without colliding on a logical id.
- The `ApiUrl` CfnOutput is now `Lazy` — it resolves to the front-door origin when one is provisioned, else the gateway — so the deploy script writes the front-door URL into the client's `config.json`. That is the entire client switch; no client-code change.
- `httpOriginFromApiUrl` centralizes building the API origin from the API URL token; Hosting's `addApiBehaviors` reuses it.
- **Deprecated** `BlocksStack.gateway`/`apiUrl` and `BlocksBackend.gateway`/`apiUrl` — the front door (or a compute's own `apiGateway`) supersedes the stack-level accessors; they are removed in a later change.

Non-breaking (coordinated redeploy — no production traffic yet). Per-namespace routing to multiple computes and the client's per-namespace path segment land with later multi-compute fan-out work.
