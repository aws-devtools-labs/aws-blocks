---
"@aws-blocks/hosting": patch
---

Fix non-prerendered ISR pages returning 404 when a Nuxt/Nitro app prerenders a page inside an ISR directory (for example `routeRules: { '/blog/**': { isr: 60 }, '/blog/featured': { prerender: true } }`). The route table no longer keeps a static `/blog/*` row ahead of the compute `/blog/*` row, so `/blog/any-other-post` now renders on demand instead of going to the static asset origin.
