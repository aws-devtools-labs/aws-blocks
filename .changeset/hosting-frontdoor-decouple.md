---
"@aws-blocks/hosting": minor
"@aws-blocks/core": patch
---

feat(hosting): decouple hosting features from the front door — CloudFront is now swappable

Hosting previously assumed CloudFront was the front door: routing, same-origin API
proxying, atomic releases, image optimization, and header injection were all wired
directly to CloudFront primitives. This change extracts a service-agnostic **plan
layer** and a **Ports & Adapters** seam so the front door becomes a swappable choice.

**`@aws-blocks/hosting`**

- **Service-agnostic `CapabilityPlan`** (`origins`, `routes`, `policies`, `release`)
  with zero CDK/service types — the single source of truth every front door renders
  from. `buildCapabilityPlan()` produces it; `renderKvsEntries()` consumes it (the KVS
  router output is byte-identical to before).
- **`FrontDoorAdapter` port** (`service`, `supports(CapabilityId): SupportTier`,
  `render(scope, plan, ctx)`) plus a **capability negotiator**: each capability is
  `core` / `extended` / `degraded` / `unsupported`; synth fails on a required +
  unsupported capability, fails on required + degraded unless the app opts into
  `degrade`, and warns otherwise. `AtomicRelease` / `RunServerRender` are required only
  when the plan has a server origin, so pure-static doors negotiate clean.
- **Five front doors**, selected via `new Hosting({ frontDoor: { kind } })`:
  `cloudfront` (default, unchanged), `alb`, `api-gateway` (HTTP API v2),
  `function-url`, and `s3-website`. The CloudFront path is byte-identical (snapshot
  tests); the new doors render the same plan and are gated by the negotiator per door.

**`@aws-blocks/core`** — CORS origin matching is now case-insensitive
(`parseCorsPatterns` compiles with the `i` flag). ALB DNS names are case-preserving
but browsers lowercase the `Origin` host, which otherwise 403s every cross-origin API
call behind an ALB front door. Origin scheme/host are case-insensitive per spec; no
effect on the (already-lowercase) CloudFront path.

Backward compatible — `frontDoor` defaults to `cloudfront` and all new exports are
additive.
