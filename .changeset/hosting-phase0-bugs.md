---
"@aws-blocks/hosting": patch
"@aws-blocks/core": patch
---

Fix three hosting correctness bugs:

- **Nuxt `app.baseURL` is now modelled.** The Nitro adapter reads `app.baseURL` from the built server bundle and sets `manifest.basePath` (parity with Next `basePath` / Astro `base`). Previously it was silently dropped, so a Nuxt app with a base path deployed broken — pages rendered but their hashed `/<base>/_nuxt/*` assets 404'd (no hydration). If a base path is detected in the prerendered output but can't be read from the bundle, synth now fails loud instead of shipping a broken site.
- **Dropped security headers now fail the build.** When a per-pattern header rule would exceed the CloudFront behavior cap and that rule sets a security header (CSP, HSTS, X-Frame-Options, …), synth throws instead of silently dropping it (a lost CSP previously looked like a successful deploy). Cosmetic custom headers are still dropped with a warning.
- **config.json deploy ordering is now wired correctly.** The resolved `config.json` deployment now depends on the asset deployments so the build's placeholder config can't clobber it. The previous `tryFindChild('AssetDeployment')` never matched the real child ids and the dependency was silently never created.
