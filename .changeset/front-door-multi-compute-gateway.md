---
"@aws-blocks/core": minor
---

feat(core): multi-compute routing — per-namespace RPC paths + shared-gateway fan-out

Make the shared HTTP API v2 gateway route each API namespace to the compute that hosts it, in two parts.

**Per-namespace paths.** The typed RPC client now POSTs to `/aws-blocks/api/{namespace}` (the namespace in the path) instead of the shared `/aws-blocks/api` — a gateway routes by URL path, not the JSON-RPC body, so giving each namespace its own path is what lets one gateway fan out to multiple computes. The namespace still travels in the body, and `POST /aws-blocks/api` keeps working: the runtime handler and the local dev server resolve the namespace from the path when present and fall back to the body's `namespace.method` prefix otherwise, so raw HTTP callers and existing clients are unaffected.

Migration note for `ApiNamespaceClientOptions.url`: pass the **base** URL (e.g. `/aws-blocks/api`, or `https://d123.cloudfront.net/aws-blocks/api`) — the client now appends `/{namespace}` itself. A pre-qualified URL that already includes the namespace routes to `{url}/{namespace}` and is not supported.

**Gateway fan-out.** The shared gateway now collects every compute on the stack and routes each namespace's path to the compute that hosts it: the default compute's function stays the `$default` catch-all (so the RPC root, auth, `RawRoute`s, and any namespace left on the default compute all reach it), while every non-default compute gets its own Lambda integration plus explicit `/aws-blocks/api/{namespace}` (and `{proxy+}` subtree, `ANY` method) routes. A more specific route wins over `$default`, so requests fan out with a single gateway — and a single CloudFront origin under `apiFrontDoor: 'edge'`. Each `ApiNamespace` records its name on the `namespaces` list of the compute that resolves it (the stack default compute today).

Internal only: there is still no public way to assign a namespace to a non-default compute, so for every app today every namespace resolves to the default compute and the synthesized gateway is unchanged. The customer-facing compute-assignment surface lands in a later release. The `createSharedGateway` signature (it now takes the compute list + default compute) is `@internal`.
