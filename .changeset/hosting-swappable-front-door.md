---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/auth-common": minor
"@aws-blocks/bb-auth-basic": minor
---

feat(hosting): swappable, removable & nestable front door

Hosting no longer hard-codes CloudFront as the front door. A single optional
`frontDoor` prop on `Hosting` selects it — **omit it and nothing changes**: you
get today's global CloudFront door (CloudFormation byte-identical, no migration).

The front door becomes a first-class choice:

- **`'cloudfront'`** *(default)* — global CloudFront CDN (unchanged).
- **`'none'`** — no front door; served directly from an S3 website bucket (static/SPA, HTTP).
- **`{ kind: 'alb', vpc?, internal?, certificate? }`** — a regional Application Load Balancer, no CDN.
- **`{ kind: 'apiGateway', api?: 'http' | 'rest', certificate? }`** — API Gateway, no CDN; the serverless sibling of the ALB door (no VPC/NAT, scale-to-zero).
- **`{ kind: 'stacked', edge: 'cloudfront', router: 'alb', vpc?, internal? }`** — a CloudFront edge stacked over an ALB router.

Under the hood, the CloudFront-specific machinery (routing, private-asset access,
atomic release, the same-origin API proxy, header injection) is lifted into a
**service-agnostic plan layer** (`CapabilityPlan`) that each front-door **adapter**
renders onto its own primitives. A **capability negotiator** makes any capability
a chosen door can't provide **fail at synth** (missing ≠ degraded) — never a silent
runtime surprise — with an opt-in `degrade` for accepted trade-offs.

Auth works across the new doors: CORS origin matching is now case-insensitive, and
session cookies handle non-TLS / cross-origin (S3-website) front doors correctly,
so auth flows behave regardless of the chosen door.

Backward compatible — `frontDoor` defaults to `'cloudfront'` and all new exports
are additive.
