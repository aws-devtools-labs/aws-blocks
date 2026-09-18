---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

feat(hosting): API Gateway as a public front door (`frontDoor: { kind: 'apiGateway' }`)

Promotes API Gateway from an in-tree/dormant adapter to a **public front-door
choice** — the serverless sibling of the ALB door. API Gateway owns routing (a
route per origin/namespace), serves private-S3 assets through an asset-proxy
Lambda, and proxies `/aws-blocks/*` **same-origin** to the backend natively (no
forwarder Lambda). Unlike the ALB door it needs no VPC/NAT and scales to zero —
the right fit for the "SPA/SSR + API, no CDN, many low-traffic apps" shape (e.g.
a platform that stands up an app per user).

```ts
// Default flavor — a regional HTTP API v2 (rootless; no CloudFront)
new Hosting(stack, 'Web', { root, api, frontDoor: { kind: 'apiGateway' } });

// REST flavor — only behind a custom domain / CloudFront (its /prod stage path
// would break a bare SPA's root-absolute asset URLs)
new Hosting(stack, 'Web', { root, api, frontDoor: { kind: 'apiGateway', api: 'rest' } });
```

**Flavor (`api`): `'http'` (default) or `'rest'`.** HTTP API v2 is the default
because its auto `$default` stage is **rootless** — a SPA/SSR app's root-absolute
asset URLs (`/assets/*`, `/favicon.ico`) resolve directly — and it's cheaper. A
bare REST API `execute-api` URL always carries a **stage path** (`/prod/`), which
breaks those root-absolute URLs, so `'rest'` is only suitable **behind a custom
domain** (base-path mapping to the stage) or a CloudFront edge — not as a bare
standalone door for a root SPA. (The Function-URL SigV4 body-hash issue that
motivates REST behind CloudFront is moot for a standalone door — there's no OAC.)
Both flavors render the same neutral `CapabilityPlan` through the existing
`api-gateway` adapter/graph seam; only the construct differs.

The asset-proxy Lambda is now payload-format-agnostic — it reads the request
path from a v1 (`event.path`, REST) or v2 (`event.rawPath`, HTTP API / Function
URL) event, so one generator serves both flavors. The SSR/image Lambdas already
branch on v1/v2, so a REST door works with the existing compute.

**Custom domains** are wired for both flavors (`CustomDomainTls` is `core`, and
actually built — not an overclaim): pass `domain` and the door provisions a
**regional** API Gateway custom `DomainName` + mapping (REST base-path mapping /
HTTP API mapping) and Route 53 A/AAAA alias records to the gateway's regional
domain, for one or more names. The certificate is your BYO regional cert
(`frontDoor.certificate` or `domain.certificate`, same region as the stack — not
the CloudFront us-east-1 requirement) or is DNS-validated against the hosted zone
when omitted. `wwwRedirect` remains `unsupported` on this door (no edge function).

Edge capabilities (global cache, per-route response headers, skew-pin, geo) and
response streaming are `degraded`/`unsupported` on this door and — as with the
ALB door — must be accepted via `degrade`, else the negotiator fails at synth
(missing ≠ degraded; a real loss is never silent). The ~29 s integration timeout
and ~10 MB payload cap apply.

Additive and backward-compatible: omit `frontDoor` (or keep `'cloudfront'` /
`'none'` / `{ kind: 'alb' }`) and nothing changes. `@aws-blocks/blocks` gets the
same bump because it re-exports `Hosting` and its widened `frontDoor` prop.
