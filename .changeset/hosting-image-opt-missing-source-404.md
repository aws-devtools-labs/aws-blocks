---
'@aws-cdk-blocks/hosting': patch
---

A Next.js image request for a source image that isn't in the assets bucket now returns `404 Not Found` instead of `500 Internal server error`. A real server error from the Next.js image optimizer is now sent with `Cache-Control: no-store`, so CloudFront no longer caches it for 60 seconds. The Nuxt and Astro (IPX) image optimizer already returned 404 for a missing source.
