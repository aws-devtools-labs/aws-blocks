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

Additive and backward-compatible: omit `frontDoor` (or use any built-in door —
`'cloudfront'` default, `'none'`, `{ kind: 'alb' }`, `{ kind: 'apiGateway' }`,
`{ kind: 'stacked', … }`) and nothing changes.
