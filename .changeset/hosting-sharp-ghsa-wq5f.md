---
'@aws-blocks/hosting': patch
---

Ship a patched `sharp` in every image-optimization bundle. The Next.js image-optimization Lambda, the Astro SSR `/_image` endpoint and the Nuxt IPX Lambda installed sharp 0.34.x, which is affected by [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) (a librsvg use-after-free that can lead to remote code execution on glibc Linux). They now install `sharp@^0.35.5`. A sharp already in the bundle is replaced unless it is 0.35.5 or later and built for the function's CPU, and the Nuxt IPX bundle forces ipx onto the same sharp. Redeploy to pick up the fix.

Astro 4 and 5: sharp 0.35 removed the `failOnError` option that Astro's sharp image service passes, so a slightly corrupt source image (for example a truncated JPEG) that `/_image` used to render now fails to optimize.
