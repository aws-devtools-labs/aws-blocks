---
"@aws-blocks/core": patch
---

Never serve a stale placeholder `config.json` after a deploy. The build-time placeholder (`{"_placeholder":true}`) was uploaded with the 1-year mutable cache-control (`public, s-maxage=31536000, max-age=0, must-revalidate`), and the post-deploy CloudFront invalidation targeted `/.blocks-sandbox/*` — which never matches the real cache key, because the skew-protection viewer-request function rewrites the URI to `/builds/<buildId>/.blocks-sandbox/config.json` before the cache lookup. An edge that cached the placeholder during the deploy window could keep serving it for up to a year, making `getApiUrl()` throw and every client API call fail. The placeholder is now registered as a no-cache path (`no-cache, no-store, must-revalidate`) so edges never cache it long-term, and the config deployment now also invalidates the post-rewrite key `/builds/<buildId>/.blocks-sandbox/*`.
