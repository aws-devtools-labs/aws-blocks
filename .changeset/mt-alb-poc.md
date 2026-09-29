---
"@aws-blocks/hosting": minor
---

feat(hosting): multi-tenant ALB POC — one load balancer, N tenants

Experimental `MultiTenantAlb` construct: one Application Load Balancer fronting N
tenant apps via a single default listener action → one router Lambda + a baked
tenant route table + shared S3 prefixes (`t/<tenantId>/`). The router reads the
tenant from the first path segment (or, in `subdomain` mode, the Host header's
first label), looks up its prefix, and streams the object — so adding a tenant is
a route-table entry + a prefix, with NO per-tenant listener rule (avoiding the
~100-rule/listener cap). Sibling to the multi-tenant CloudFront (#620) and API
Gateway (#641) POCs; experimental, for the multi-tenancy front-door design.
