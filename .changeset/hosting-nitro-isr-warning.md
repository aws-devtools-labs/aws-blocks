---
'@aws-cdk-blocks/hosting': patch
---

A Nuxt (Nitro) route rule with `isr` and no `swr` or `cache` now prints a warning at build that names the route. Nitro implements `isr` only in its Vercel, Netlify and Zeabur presets, so on AWS such a route was rendered on every request without a word. The warning, and the README, point to `swr: <seconds>`, which caches the page at the edge.
