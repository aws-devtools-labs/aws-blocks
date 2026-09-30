---
"@aws-blocks/hosting": minor
---

fix(hosting): fail-closed SSR cache key + per-credential cache-key options

Ensures cacheable SSR responses on compute deployments are keyed per credential, and adds the controls to include credentials in the SSR cache key.

- **Fail-closed guard on `cdn.ssrDefaultTtl`.** Enabling `ssrDefaultTtl > 0` makes SSR responses without an explicit `Cache-Control` header cacheable at the CloudFront edge, keyed only on the Next.js router headers — not on `Authorization` or session cookies (CloudFront ignores `Vary`). Synth now throws unless `cacheKeyCookies` and/or `cacheKeyHeaders` is set, so credentials are in the cache key before per-credential responses can be cached. An unresolved-token TTL is treated as `> 0` (fail closed).
- **New `cdn.cacheKeyCookies` and `cdn.cacheKeyHeaders` options.** Add your session cookie name(s) and/or credential-bearing header(s) (e.g. `'authorization'`) to the SSR cache key so authenticated responses are cached per credential. `'accept-encoding'` is rejected (handled by the brotli/gzip flags), and at most 8 caller cookies are allowed (CloudFront's 10-cookie cap, 2 reserved for Next.js preview mode).
- **Behavior change: SSR `maxTtl` lowered from 365 days to 1 day.** Clamps wild origin `Cache-Control` values and bounds how long a cached SSR response can persist at the edge. Origins that intentionally cache longer than a day at the edge will now be capped.
- **Cache-key JSDoc** on `ssrDefaultTtl`, `cacheKeyCookies`, and `cacheKeyHeaders` documenting how credentials enter the cache key and safe usage.

Note: any route that sets cookies via `Set-Cookie`, or otherwise varies per user without opting into the cache key, must emit `Cache-Control: private` so its response is not cached as a single shared entry at the edge.
