---
"@aws-blocks/core": minor
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

feat(core): multi-compute routing — per-namespace RPC paths + shared-gateway fan-out

Make the shared REST API gateway route each API namespace to the compute that hosts it, in two parts.

**Per-namespace paths.** The typed RPC client now POSTs to `/aws-blocks/api/{namespace}` (the namespace in the path) instead of the shared `/aws-blocks/api` — a gateway routes by URL path, not the JSON-RPC body, so giving each namespace its own path is what lets one gateway fan out to multiple computes. `{namespace}` is the backend export name. The body still carries `namespace.method`, and that is what the runtime handler and the local dev server dispatch: a per-namespace path must be exactly `/aws-blocks/api/{namespace}` and name the same namespace, or the request is rejected with a JSON-RPC `-32600` Invalid Request rather than silently running either one. `POST /aws-blocks/api` keeps working unchanged, so raw HTTP callers that use it are unaffected.

Migration note for `ApiNamespaceClientOptions.url`: pass the **base** URL (e.g. `/aws-blocks/api`, or `https://d123.cloudfront.net/aws-blocks/api`) — the client now appends `/{namespace}` itself. A pre-qualified URL that already includes the namespace routes to `{url}/{namespace}` and is not supported.

Deploy order: a web client built with this release calls `/aws-blocks/api/{namespace}`, which needs the gateway resource this release adds. Deploy the backend before, or together with, clients built against it; a gateway deployed from an earlier release may reject the per-namespace path (403). If you run your own proxy or rewrite in front of the API (nginx, a framework rewrite, your own CloudFront behavior), make it forward the whole `/aws-blocks/api/*` subtree, not just the exact `/aws-blocks/api` path — `Hosting` already does.

Native clients (Swift, Kotlin, Dart) still POST to the bare `/aws-blocks/api` URL and dispatch by the body's `namespace.method` prefix, so they keep working unchanged. They always reach the default compute; routing them to a non-default compute will need them to append `/{namespace}` once compute assignment ships.

**Gateway fan-out.** The shared gateway now routes each namespace's path to the compute that hosts it. The default compute's function stays behind the catch-all resources, so the RPC root, auth, `RawRoute`s, and any namespace left on the default compute all reach it; a new `/aws-blocks/api/{proxy+}` resource carries the per-namespace RPC paths for those namespaces. Every non-default compute gets its own Lambda integration plus a literal `/aws-blocks/api/{namespace}` (`ANY`) resource for each namespace it hosts. A literal resource wins over the sibling `{proxy+}`, so requests fan out within a single gateway — and a single CloudFront origin under `apiFrontDoor: 'cloudfront'`. Routes key on each namespace's export name — what the client calls — read from the backend module after it is imported, and each namespace's compute is resolved then (today: the compute of the scope it was built in). A non-default compute's function gets one API-scoped invoke permission however many namespaces it hosts. Synth fails with a clear error for a namespace on a compute that takes no API traffic, or for an export name API Gateway can't use as a path segment.

Internal only: there is still no public way to assign a namespace to a non-default compute, so for every app today every namespace resolves to the default compute. The only synthesized change is the additive `/aws-blocks/api/{proxy+}` resource; existing gateway resources keep their logical IDs. The customer-facing compute-assignment surface lands in a later release. The `createSharedGateway` signature (it now takes the per-compute namespace routes + default compute) is `@internal`, and so is the `Compute.namespaces` list this replaces.
