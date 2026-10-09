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

Every object-form door (`{ kind: 'alb' }`, `{ kind: 'apiGateway' }`,
`{ kind: 'stacked', … }`, `{ kind: 'custom', … }`) also accepts
`negotiation: 'strict' | 'warn' | 'off'`, an explicit escape hatch for the
capability check. `'strict'` (the default) keeps today's behavior: a demanded
capability the door can't serve fails synth. `'warn'` reports it and deploys
anyway; `'off'` skips the check, for platforms that validate their door their
own way. `degrade` (accepting specific capabilities) works in every mode.

The capability vocabulary was reviewed against real sample apps for what can
actually be detected from an app. `LongRequest` and `LargePayload` are removed:
nothing in an app's build or props reveals them, so they could never be checked.

`SupportTier` is simplified to two values, `'supported' | 'unsupported'`. A door
states a fact about each capability; what the app can live without is the app's
call. `degrade: [capability]` now waives any unsupported capability the app
demands (deploy without it), and `negotiation` relaxes the check door-wide.

Additive and backward-compatible: omit `frontDoor` (or use any built-in door —
`'cloudfront'` default, `'none'`, `{ kind: 'alb' }`, `{ kind: 'apiGateway' }`,
`{ kind: 'stacked', … }`) and nothing changes.
