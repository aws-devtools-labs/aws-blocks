---
"@aws-blocks/hosting": patch
---

Fix multi-page routing for static sites (Astro static, SSGs). The L3 no longer infers SPA-vs-multi-page from the presence of error pages; adapters now declare `staticAssets.spaFallback` explicitly. The Astro adapter sets `spaFallback: false` (static Astro is always multi-page), and the SPA adapter detects nested `index.html` files. Multi-page static sites without their own `404.html` now get a built-in default 404 page (served at HTTP 404) instead of CloudFront's raw error. Adds a `hosting-ssr-astro` e2e test app.
