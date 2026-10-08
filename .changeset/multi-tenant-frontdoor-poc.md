---
"@aws-blocks/hosting": minor
---

feat(hosting): experimental multi-tenant front-door POC — one door, N tenants (CloudFront · API Gateway · ALB)

Adds three experimental / proof-of-concept constructs to
`@aws-blocks/hosting/constructs` that each front **N tenant apps behind a single
door**, proving the shared multi-tenant front-door substrate on each primitive:

- **`MultiTenantCloudFront`** — one CloudFront distribution; a single
  viewer-request CloudFront Function reads a **KeyValueStore** tenant route table.
- **`MultiTenantApiGateway`** — one HTTP API v2 (`$default` → one router Lambda).
- **`MultiTenantAlb`** — one Application Load Balancer (one default listener
  action → one router Lambda; **no** per-tenant listener rules).

All three share the same model: one private S3 bucket holds every tenant's assets
under `t/<tenantId>/`; the router resolves the tenant from the first path segment
(`/<tenantId>/…`) or the Host header's first DNS label (`<tenantId>.host`), reads
a `tenantId → { prefix, spa }` route table, rewrites into the tenant's prefix
(extensionless → `index.html`; SPA fallback), stamps an `x-tenant-id` header
inward, and 404s an unknown tenant. **Adding a tenant is a route-table entry + an
asset prefix — never a new distribution / API / listener / rule** (which is what
lets one door carry many tenants without hitting per-behavior/route/rule limits).

POC scope: static/SPA tenants only — no per-tenant SSR/backend fan-out, custom
domains/TLS, or per-tenant throttling yet; `subdomain` mode exercises the
Host-based routing logic only (real DNS + wildcard TLS is out of scope); the
tenant route table is synth-baked (a data-driven runtime table is the design
follow-up). Demonstrates the design in the multi-tenancy front-door notes.
