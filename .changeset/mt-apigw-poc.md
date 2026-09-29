---
"@aws-blocks/hosting": minor
---

feat(hosting): multi-tenant API Gateway POC — one HTTP API, N tenants (experimental)

Adds `MultiTenantApiGateway` (experimental / proof-of-concept): ONE Amazon API
Gateway (HTTP API v2, `$default` → ONE router Lambda) fronting many tenant apps,
routed by the first path segment (`/<tenantId>/…`) or the Host header's first DNS
label (`<tenantId>.host`). Tenant assets live under `t/<tenantId>/` prefixes in a
single private S3 bucket; the router reads a baked `tenantId → { prefix, spa }`
table, streams the tenant's object, stamps `x-tenant-id`, and 404s an unknown
tenant. Adding a tenant is a route-table entry + a prefix — not a new API, route,
stage, or integration. The API-Gateway sibling of the multi-tenant CloudFront POC.

POC scope: static/SPA tenants only — no per-tenant SSR/backend fan-out, custom
domains/TLS, or per-tenant throttling/usage plans yet; `subdomain` mode's real DNS
+ wildcard TLS is out of scope (only the Host-based routing logic).
