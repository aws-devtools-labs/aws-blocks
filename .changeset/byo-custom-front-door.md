---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
---

feat(hosting): bring-your-own (custom) front door, defined with build hooks

Adds `frontDoor: { kind: 'custom', door }` — a customer-authored front door
for the long tail the built-in doors can't cover (a third-party CDN, an edge you
already operate, a custom auth layer).

A door is a set of **build hooks** (`defineFrontDoor`). There is no separate
capability declaration: **defining a hook is what declares support**, and each
hook returns the flavor it actually built, so what a door claims and what it
builds can't drift.

- Required core: `create` builds the door, `route` does all routing and
  reports what it delivered (`ssr: 'buffered' | 'streaming'`, images, redirects,
  error pages, caching, headers, atomic release, session pinning), and `handle`
  returns the public URL + attach point.
- Optional feature hooks: `sameOriginApi`, `customDomain`, `waf`
  (`'edge' | 'regional'`), `restrictGeo`, `accessLogs`, `alarms`. A missing hook
  means unsupported; a present hook runs only when the app demands it.

At synth the framework checks that every capability the app **demands** has its
hook (before building), runs `create` → `route` → the demanded hooks →
`handle`, then checks the reports (for example, the app streams but `route`
reported `'buffered'`). An unmet demand fails synth — safe by construction,
never a silent runtime break. You provision the door itself; Hosting still
provisions the app (S3 assets, compute, backend) and hands them over via the
render context and `plan.backend`.

Every built-in door is defined the same way: `cloudFrontDoor` (the default
door — its output is unchanged), `albDoor`, `apiGatewayDoor`, `s3WebsiteDoor`,
and `cloudFrontEdgeDoor` (the CloudFront edge of the stacked door). `runFrontDoor`
drives any door and returns what it delivered.

To keep authors from reimplementing the hard parts, `@aws-blocks/hosting/constructs`
now also exports the building blocks the built-in doors use — `generateAlbAssetProxyCode`
/ `generateApiGwAssetProxyCode` (stream `builds/<id>/…` from the private bucket),
`backendBaseUrl` (same-origin API base), `coalesceRoutes` / `routeSpecificity`
(route ordering), and `createSecurityHeadersPolicy` — plus `assertDoorConformance`,
a test kit that checks a custom door's hooks are well-formed, that it serves a
given plan, and that `handle` returns a usable attach point.

Every object-form door (`{ kind: 'alb' }`, `{ kind: 'apiGateway' }`,
`{ kind: 'stacked', … }`, `{ kind: 'custom', … }`) also accepts
`negotiation: 'strict' | 'warn' | 'off'`, an explicit escape hatch for the
capability check. `'strict'` (the default) fails synth on a demanded capability
the door doesn't deliver. `'warn'` reports it and deploys anyway; `'off'` skips
the check, for platforms that validate their door their own way.
`degrade: [capability]` waives a specific capability (deploy without it) in
every mode.

The capability vocabulary was reviewed against real sample apps for what can
actually be detected from an app. `LongRequest` and `LargePayload` are removed:
nothing in an app's build or props reveals them, so they could never be checked.

Additive and backward-compatible: omit `frontDoor` (or use any built-in door —
`'cloudfront'` default, `'none'`, `{ kind: 'alb' }`, `{ kind: 'apiGateway' }`,
`{ kind: 'stacked', … }`) and nothing changes.
