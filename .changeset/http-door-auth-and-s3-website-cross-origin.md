---
"@aws-blocks/auth-common": minor
"@aws-blocks/bb-auth-basic": minor
"@aws-blocks/hosting": patch
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(auth,hosting): make Auth + cross-origin API work behind non-CloudFront front doors

Two fixes so an app's Building Blocks (Auth / Data / Storage) actually work
behind the S3-website and ALB front doors, not only behind CloudFront:

**1. Session cookies over a plain-HTTP front door.** The auth cookie only
dropped `Secure` for localhost — every other deploy was assumed to be HTTPS. But
a TLS-less front door (an S3-website endpoint, or an ALB with no certificate) is
non-localhost *and* HTTP, so its `Secure` session cookie was silently discarded
by the browser and every `requireAuth` call 401'd. `auth-common` now exposes
`isInsecurePublicOrigin()` (derived from the front door's own
`BLOCKS_PUBLIC_ORIGIN` scheme — config-derived, not a forgeable header) and a new
`CookieSecurityInput.plainHttpOrigin` flag; `AuthBasic` feeds it so the
same-origin `Lax` cookie omits `Secure` over an HTTP door and the session works.
A `SameSite=None` cross-domain cookie still requires `Secure` and therefore
genuinely cannot work behind a TLS-less door — surfaced honestly, not papered
over.

**2. Cross-origin API URL for the S3-website door.** The S3-website door serves
static files from its own public website bucket (at root), and cannot proxy a
POST to the backend — so the API is cross-origin. The client config now publishes
the ABSOLUTE API-Gateway URL (`<apiUrl>/api`) instead of the same-origin relative
path for that door, and `config.json` is published to the website bucket's root
(the origin the SPA actually loads from) rather than only to the private assets
bucket. CORS for the website origin was already allowed. Every proxying door
(CloudFront, the composed CF→ALB, ALB, API-Gateway) is unchanged — still
same-origin, still relative.

Additive/backward-compatible: HTTPS same-origin deploys keep `SameSite=Lax; Secure`
exactly as before; only HTTP doors change. `@aws-blocks/blocks` gets a patch bump
because it re-exports the affected surfaces.
