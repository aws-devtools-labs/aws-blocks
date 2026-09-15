---
"@aws-blocks/core": patch
"@aws-blocks/bb-lambda-compute": patch
---

Mount a per-namespace `/aws-blocks/api/{namespace}` ingress on each compute

Each compute now exposes a stable per-namespace path, so routing infrastructure has a deterministic target for the compute that owns a namespace. `Compute.mountNamespaceRoutes()` (a no-op by default) is called at synth finalize — after every `ApiNamespace` has recorded itself on its compute — and `LambdaCompute` overrides it to add `/aws-blocks/api/{namespace}` (and `/aws-blocks/api/{namespace}/*`) resources on its API Gateway, both proxying to the same Lambda. The `api` segment scopes the tree to API traffic, so namespace names can never collide with other framework endpoints (which are siblings, e.g. `/aws-blocks/dashboard`).

Additive and non-breaking: the `/aws-blocks/api` endpoint keeps serving and the client still uses it. Dispatch reads the namespace from the request body, and the runtime handler already treats every path under `/aws-blocks/api` as an RPC request, so no handler or client change is involved. Mounting is idempotent.
