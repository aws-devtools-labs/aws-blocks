---
"@aws-blocks/core": minor
"@aws-blocks/blocks": patch
---

feat(core): route the API front door from the RawRoute registry, and address namespaces by path

The API front door (managed CloudFront distribution and the reuse path where
`Hosting` fronts the API) now builds its CloudFront behaviors from **one route
table** — the existing `RawRoute` registry (`getRegisteredRoutes()`) — instead of
hardcoding the reserved behaviors and looping over `RawRoute`s separately. Each
registered route carries the `endpoint` of the compute that serves it, so a single
`addRouteBehaviors()` pass emits one behavior per distinct `(path, endpoint)` and
dedupes origins by endpoint. Both front-door paths (the managed distribution and
Hosting's own) now route identically from that table.

Today every route resolves to the default compute, so `addRouteBehaviors()` emits
only the behaviors that actually route somewhere distinct: each app `RawRoute` and
the reserved `/aws-blocks/api` RPC and `/aws-blocks/auth` subtrees, all pointing at
the one default origin. A namespace on the default compute gets **no** dedicated
behavior — it falls through to the RPC catch-all — so the behavior count does not
grow with the number of namespaces (which would otherwise add two behaviors each and
push a ~11-namespace app past CloudFront's 25-behaviors-per-distribution quota for no
routing gain). There is deliberately **no mode flag**: `addRouteBehaviors()` never
sets a distribution's default behavior — each caller (the managed distribution → the
default compute; Hosting → the frontend) owns that — so everything unrouted falls
through to the caller's own default, correctly in both cases. This is a no-op on the
wire until an assignment surface (a later change) gives a namespace a non-default
compute — at which point the *same* registration carries a non-default endpoint and
the *same* front-door code emits that namespace's exact/subtree pair to fan it out to
the assigned origin, with no change here.

Two things are deliberately deferred to that later change, since neither has an
observable effect while every route resolves to the default endpoint: per-stack
route scoping (the process-global registry is not yet partitioned per
`BlocksStack`, which only matters once two backends in one `cdk synth` assign
diverging endpoints) and the routability guard that rejects assigning a namespace
to an ingress-less compute.

**Wire protocol — an API namespace is now addressed by path.** A client call to
namespace `foo` posts to `/aws-blocks/api/foo` (was: `/aws-blocks/api` with the
namespace only in the JSON-RPC body). The namespace still travels in the body and
the server still dispatches on it; the path is a CloudFront routing hint that lets
the front door send a namespace to its own compute without a per-namespace API
Gateway resource. The whole `/aws-blocks/api` subtree is treated as RPC — the
Lambda handler and the local dev server now accept any `/aws-blocks/api/*` path via
`isRpcPath()`, not only the bare prefix.

New/changed public surface on `@aws-blocks/core`:

- `RegisteredRoute` gains optional `endpoint` (the serving compute's origin base)
  and `subtree` (prefix match, for the RPC/auth subtrees).
- `registerRoutingEntry()` registers a **handler-less, routing-only** entry that
  shapes CloudFront behaviors but never dispatches — it bypasses the reserved-path
  guard (user `RawRoute`s still cannot claim `/aws-blocks/api*`). `matchRoute()`
  skips handler-less entries, and `isDispatchRoute()` narrows a route to one that
  can be invoked.
- `isRpcPath(pathname)` — true for the bare RPC prefix and its subtree.

This is a `minor` bump for `@aws-blocks/core` (pre-1.0 minor = a behavior change):
the client's RPC URL and the synthesized CloudFront behavior set both change, so
snapshot assertions on either will see a diff. The unused `Compute.namespaces`
field is also removed — the registry is now the single source of truth for which
compute serves a path.
