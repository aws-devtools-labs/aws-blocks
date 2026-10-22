---
"@aws-blocks/hosting": patch
---

fix(hosting): load `astro.config` under Astro 7

Astro 7's `astro/config` pulls in a Vite build that uses `import.meta.require`, which the adapter's config loader couldn't handle. The adapter logged "Failed to load astro.config … falling back to defaults" and dropped the whole config, so `redirects`, `trailingSlash` and image settings were ignored. The config now loads natively first, and the verified Astro range covers 7.x.
