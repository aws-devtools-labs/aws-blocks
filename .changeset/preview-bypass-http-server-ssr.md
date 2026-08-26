---
"@aws-blocks/hosting": patch
---

Fix `bypassCdn` SSR for non-Next frameworks (Nuxt/Astro/SvelteKit).

Previously `bypassCdn` fronted the SSR catch-all with an HTTP API v2
`HttpLambdaIntegration` (a direct Lambda invoke with an API-Gateway-v2 payload).
That only works for Next's OpenNext `aws-apigw-v2` handler; a Nitro/Astro/
SvelteKit SSR handler (or a Lambda Web Adapter `http-server`) returned a
response the integration couldn't map, so every SSR request 500'd (static
assets still served).

The bypass SSR catch-all now routes to the compute's **Function URL** via
`HttpUrlIntegration`, invoking the handler exactly as the (working) non-bypass
Function-URL path does — so every framework's SSR serves correctly. The SSR
Function URL is made **public (`authType: NONE`)** under `bypassCdn` so the
unsigned API Gateway proxy can reach it.

No signature bug: the CloudFront-OAC POST-body signature issue requires
CloudFront OAC SigV4 signing an IAM-authed Function URL. The bypass has no
CloudFront and the Function URL is unsigned (`authType: NONE`), so no SigV4
signing occurs anywhere — POST/PUT bodies pass through untouched.

Validated on real deploys: Nuxt SSR `GET /` 500 → 200 (renders), `/nonexistent`
→ 404, `POST /` → 200; Next SSR regression clean (`GET /` 200, `POST /` 200,
`/profile` 307). Same-origin cookie auth is preserved (the browser only sees the
API-Gateway origin; the API forwards the request — including cookies — to the
Function URL server-side).

Note: the SSR Function URL is publicly reachable in `bypassCdn` mode (a preview-
only, opt-in shape). The browser never uses it directly; it's an internal hop
from the API-Gateway origin.
