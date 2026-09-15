---
'@aws-blocks/hosting': patch
---

fix(astro): allow an empty `dist/client` for pure-SSR builds

A server/hybrid Astro app with no static assets — no `public/` files and no
prerendered pages — produces an empty `dist/client`. The adapter treated that as
a missing build output and threw `AstroBuildOutputMissingError`, blocking synth
and deploy. `dist/server/entry.mjs` is the real required artifact; an empty (or
absent) `dist/client` is valid, since CloudFront routes every request to the SSR
Lambda. The adapter now requires only the server entry and ensures `dist/client`
exists (creating it when absent) instead of failing.
