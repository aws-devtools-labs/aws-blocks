---
"@aws-blocks/core": minor
"@aws-blocks/bb-lambda-compute": minor
---

Route each API namespace to the compute that hosts it — the multi-compute request fan-out. This completes the routing work the API front door deferred: the front door previously sent the whole `/aws-blocks/api` subtree to one origin, so an app with several computes could provision them but not reach them.

- **`Compute.endpoint`** exposes a compute's HTTP ingress as an origin **base** URL (scheme + host + stage, with no `/aws-blocks/api` suffix and no trailing slash). `LambdaCompute` supplies it from its API Gateway URL. The base is what routing infrastructure actually wants — a CloudFront origin is a host plus an origin path — and it is a plain string rather than a CDK `IOrigin` so it also serves non-CloudFront front doors (an ALB listener rule, an API Gateway custom domain, a reverse proxy). It is optional: a worker-only compute (queues, cron) has no HTTP ingress.
- **`BlocksStack.apiEndpoints` / `BlocksBackend.apiEndpoints`** expose the namespace → endpoint routing table, derived from the namespaces each `ApiNamespace` records on its compute. This is the contract for building your own front door with `apiFrontDoor: 'none'` — plain data, so nothing needs to import framework types to consume it. A namespace claimed by two computes now throws at synth rather than routing ambiguously.
- **Both front-door paths fan out identically.** The managed CloudFront distribution and a `Hosting` app's own distribution share one helper, which adds a behavior per namespace (`/aws-blocks/api/{namespace}` and its subtree) pointed at the owning compute. Namespaces sharing a compute share a single CloudFront origin instead of one per namespace. Each owner attaches behaviors to the distribution it owns, so only endpoint *values* cross a stack boundary — `Hosting` receives them as the new optional **`apiEndpoints`** field on its `api` prop.
- **The client now addresses a namespace as `/aws-blocks/api/{namespace}`** instead of posting every namespace to `/aws-blocks/api`. The namespace also stays in the JSON-RPC body — that is still what the server dispatches on, so the path is purely a routing hint. The explicit **`url` option is a base URL**: it replaces config.json *discovery*, not the request path, so the client still appends the namespace segment to it (a trailing slash is tolerated).
- The local dev server now accepts the whole RPC subtree rather than only the bare prefix, matching the Lambda handler, which already did. Both now share one predicate so local dev and deployed cannot drift on what counts as an RPC request.

**Single-compute apps are unaffected in behavior** — every namespace path resolves to the same compute, and the per-namespace API Gateway routes the previous release mounted already serve them.

Non-breaking, but **redeploy the backend and the frontend together**: a client from this release requests per-namespace paths, which a backend older than the release that mounted per-namespace API Gateway routes will not serve.

Native (Swift/Kotlin/Dart) clients still post to the base RPC path. They keep working, but their traffic all reaches the default compute; their per-namespace path lands with the native client work.
