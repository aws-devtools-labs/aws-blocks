---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
---

feat(hosting): bring-your-own (custom) front door

Adds `frontDoor: { kind: 'custom', adapter }` — a customer-authored front door
for the long tail the built-in doors can't cover (a third-party CDN, an edge you
already operate, a custom auth layer).

You implement the `FrontDoorLayerAdapter` interface. At synth the framework
negotiates the deploy's capability plan against your adapter's `supports()` — a
capability the app **demands** that the door can't serve fails at synth (safe by
construction, never a silent runtime break) — then calls `renderLayer` to build
the door. You provision the door itself; Hosting still provisions the app (S3
assets, compute, backend) and hands them over via the render context and
`plan.backend`.

To keep authors from reimplementing the hard parts, `@aws-blocks/hosting/constructs`
now also exports the building blocks the built-in doors use — `generateAlbAssetProxyCode`
/ `generateApiGwAssetProxyCode` (stream `builds/<id>/…` from the private bucket),
`backendBaseUrl` (same-origin API base), `coalesceRoutes` / `routeSpecificity`
(route ordering), and `createSecurityHeadersPolicy` — plus `assertAdapterConformance`,
a test kit that verifies a custom adapter's `supports()` is total and consistent
with what `renderLayer` builds.

Additive and backward-compatible: omit `frontDoor` (or use any built-in door —
`'cloudfront'` default, `'none'`, `{ kind: 'alb' }`, `{ kind: 'apiGateway' }`,
`{ kind: 'stacked', … }`) and nothing changes.
