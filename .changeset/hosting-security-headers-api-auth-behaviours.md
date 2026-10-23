---
"@aws-blocks/hosting": minor
"@aws-blocks/core": patch
---

Security headers (and the CSP) now cover the API and auth CloudFront
behaviours, not just the static site. Before, a `ResponseHeadersPolicy` was
attached only to the static root; requests through `/aws-blocks/api`,
`/aws-blocks/api/*`, `/aws-blocks/auth/*` and the raw-route proxies went out
with no security headers at all, so the two surfaces where it matters most —
auth and API — were the ones left uncovered (issue #765).

Both front-door paths are fixed:

- **Hosting-claimed path:** the behaviours added in `addApiBehaviors` now reuse
  the distribution's existing `securityHeadersPolicy` — the same policy already
  on the static behaviours — so there is one policy per distribution and no
  drift. To reach it, `CdnConstruct` and `HostingConstruct` now expose the
  policy as a public `securityHeadersPolicy` field.
- **Standalone managed front door** (`api-front-door.ts`): has no Hosting
  construct to borrow from, so it attaches the AWS-managed
  `ResponseHeadersPolicy.SECURITY_HEADERS` to its default behaviour. The managed
  policy creates no CloudFormation resource and consumes no account
  `ResponseHeadersPolicy` quota (capped at 20 per account by default), so a
  cloudfront-tier app near that cap can't fail a deploy, and it matches what the
  Hosting-fronted path ships by default. It carries HSTS, X-Content-Type-Options,
  X-Frame-Options, X-XSS-Protection and Referrer-Policy — no CSP, since the API
  subtree serves JSON and redirects rather than documents.

This is a `minor` bump for `@aws-blocks/hosting` because it adds public API
(`CdnConstruct.securityHeadersPolicy` and `HostingConstruct.securityHeadersPolicy`)
and a `patch` for `@aws-blocks/core` because it only changes behaviour (no new
public surface). Existing apps gain the headers automatically on their next
synth. On the Hosting-fronted path the API/auth behaviours reuse the policy
already on the static site, so there is no new option to set and no behaviour
change beyond the added response headers. On the standalone managed front door
the behaviour attaches the AWS-managed `SECURITY_HEADERS` policy — no new
CloudFormation resource and no quota impact.
