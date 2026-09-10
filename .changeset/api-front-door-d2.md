---
"@aws-blocks/core": minor
"@aws-blocks/bb-lambda-compute": minor
"@aws-blocks/blocks": minor
---

Provision a managed CloudFront **API front door**: one CloudFront distribution that becomes the stable public origin for the backend HTTP surface, so adding or scaling a compute never changes the browser hostname and `Secure` auth cookies are never dropped. At this stage the distribution is provisioned and its URL published, but the client does **not** route through it yet — it still calls the API Gateway directly, so this is an additive, no-traffic-change step that can be deployed and smoke-tested first.

- New `BlocksDefaults.provisionApiFrontDoor` (boolean) gates it: **`true` in the `production` preset, `false` in `sandbox`** (a sandbox's dev server is same-origin `localhost` and a deployed sandbox is disposable, so origin stability is moot and the CloudFront propagation isn't worth paying). Apps that spread a `BlocksPresets` preset are unaffected; a hand-rolled `BlocksDefaults` literal must add the field.
- `scheduleFrontDoor` (core, `@aws-blocks/core/cdk`) registers a one-shot CDK **aspect** at the end of `create()`. When provisioning is on it builds one `cloudfront.Distribution` whose single default behavior proxies the stack's API origin — forwarding cookies + `Authorization` and disabling caching — and emits a `FrontDoorUrl` output. Off (sandbox / opt-out) it does nothing.
- The origin is built from the stack's API URL by `httpOriginFromApiUrl`, the single place the framework turns a Blocks API URL into a CloudFront origin. The distribution and its output are scoped to the owning `BlocksStack` / `BlocksBackend`, so several front-door-enabled backends can share one stack without colliding on a logical id.

Non-breaking: purely additive; nothing routes through the distribution yet, so single-compute apps keep reaching the API Gateway directly. Per-namespace routing to multiple computes and the client switch land in later changes.
