---
"@aws-blocks/hosting": patch
---

Fix `bypassCdn` static-asset serving for the browser module loader, and degrade
image optimization to the source image instead of 403/404.

Two browser-only failures on a `bypassCdn` preview (curl looked healthy because
it only issues GET):

- **`HEAD`/`OPTIONS` on a static asset leaked to SSR.** The static routes were
  registered `GET`-only, so the browser's crossorigin module loader
  (`<link rel=modulepreload>` / `rel=prefetch`) — which also issues `HEAD` (and,
  cross-origin, an `OPTIONS` preflight) — missed those routes and fell through to
  the SSR `$default` integration, which 500s on an asset path. The module load
  then failed in the console even though the `GET` body was fine (and the 500 was
  cached as `immutable`, so it stuck). Static routes now answer `GET`/`HEAD`/
  `OPTIONS`; the asset-proxy Lambda strips the body on `HEAD` and returns a 204
  CORS preflight on `OPTIONS`. Write methods still fall through to SSR (so
  App-router server-action POSTs to a prerendered path keep reaching the server).

- **Image-optimization endpoints 403/404'd.** With `skipImageOptimization` always
  on under bypass (no image Lambda), `_ipx/*` (Nuxt), `_next/image?url=` (Next)
  and `_image?href=` (Astro) had no handler. They now route to the asset proxy,
  which recovers the original object key and serves the **source image
  unoptimized** — matching the documented preview trade-off (functionality over
  optimization). A **remote** source is 302'd to its origin so the browser loads
  it directly — the proxy never fetches arbitrary URLs (which would make it an
  open SSRF proxy).

Also sets `scopePermissionToRoute: false` on the shared asset-proxy integration,
collapsing its per-route Lambda invoke-permissions into a single api-scoped
statement. The proxy backs many routes (bare + greedy × GET/HEAD/OPTIONS per
prefix, plus the image endpoints); per-route permissions would otherwise
multiply toward the 20 KB Lambda resource-policy limit.

Validated on a real Nuxt deploy: `_nuxt/*` module chunks load (no cached 500s),
local `_ipx/*` images render (5/5), remote `_ipx/*` images 302 to origin and
render (3/3), `HEAD`→200 / `OPTIONS`→204 on assets.
