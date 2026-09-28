---
"@aws-blocks/hosting": minor
---

feat(hosting): experimental multi-tenant CloudFront POC — one distribution, N tenants

Adds `MultiTenantCloudFront` (experimental / proof-of-concept) to
`@aws-blocks/hosting/constructs`: **one** CloudFront distribution fronting **N**
tenant apps, routed by the first path segment (`/<tenantId>/…`) via a
**KeyValueStore tenant route table** read by a **single** viewer-request
CloudFront Function. One private S3 bucket holds every tenant's assets under
`t/<tenantId>/`; the edge function resolves the tenant, rewrites the URI into the
tenant's prefix (extensionless → `index.html`; SPA fallback), stamps an
`x-tenant-id` header inward, and 404s an unknown tenant.

Adding a tenant is a KVS entry + an asset prefix — **not** a new distribution or
cache behavior — which is what lets one distribution carry many tenants (a
per-tenant behavior would hit the ~25/distribution limit). Demonstrates the
shared multi-tenant front-door substrate from the design notes (single behavior +
KVS tenant route table + one distribution). Static/SPA tenants only for now.
