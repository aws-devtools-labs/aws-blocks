---
"@aws-blocks/core": patch
---

Serve `/.blocks-sandbox/config.json` from the dev server itself instead of proxying it to the framework dev server.

The browser auth client resolves its API URL by fetching `/.blocks-sandbox/config.json`. The dev server proxied that request to the framework dev server (Next.js/Nuxt/Astro), which only serves its own static dir and returned 404 — so the client failed with "Blocks API URL not configured" in local `dev`. The dev server now answers this reserved path directly, mirroring production where CloudFront serves `/.blocks-sandbox/*` as static assets. Framework-agnostic and requires no per-app workaround.
