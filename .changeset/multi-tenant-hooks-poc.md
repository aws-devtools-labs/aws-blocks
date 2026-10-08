---
"@aws-blocks/hosting": minor
---

feat(hosting): EXPERIMENTAL shared multi-tenant front doors on build hooks (POC)

`SharedCloudFrontDoor`, `SharedApiGatewayDoor`, and `SharedAlbDoor` — one front
door fronting many independent tenant apps. A platform creates the shared door
once; each app opts in with `frontDoor: { kind: 'custom', door: shared.forTenant('a') }`.
Tenants are routed by the first path segment or the Host header's first DNS
label, each request is served from that tenant's own bucket and backend, and the
door stamps `x-tenant-id` (overwriting any client-sent value). Proof-of-concept;
not a supported API yet.
