---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
---

fix(hosting): fail-closed SSR cache key + per-credential cache-key options

Ensures cacheable SSR responses on compute deployments are keyed per credential, and adds the controls to include credentials in the SSR cache key.

**BREAKING:** existing configs that set `cdn.ssrDefaultTtl > 0` now fail synth (`SsrCacheKeyCredentialsRequiredError`) until they include a credential in the SSR cache key. Enabling `ssrDefaultTtl > 0` makes SSR responses without an explicit `Cache-Control` header cacheable and shared at the CloudFront edge, keyed only on the Next.js router headers — not on `Authorization` or session cookies (CloudFront ignores `Vary`).

Migration — pick one:
- Add `cacheKeyCookies: ['<your session cookie>']` and/or `cacheKeyHeaders: ['authorization']` so cached responses are keyed per credential; or
- Remove `ssrDefaultTtl` (and ensure personalized routes emit `Cache-Control: private`).

- **Fail-closed guard on `cdn.ssrDefaultTtl`.** Synth throws unless `cacheKeyCookies` and/or `cacheKeyHeaders` is set, so credentials are in the cache key before per-credential responses can be cached. An unresolved-token TTL is treated as `> 0` (fail closed).
- **New `cdn.cacheKeyCookies` and `cdn.cacheKeyHeaders` options.** Add your session cookie name(s) and/or credential-bearing header(s) (e.g. `'authorization'`) to the SSR cache key so authenticated responses are cached per credential. `'accept-encoding'` is rejected (handled by the brotli/gzip flags), and at most 8 caller cookies are allowed (CloudFront's 10-cookie cap, 2 reserved for Next.js preview mode). The cookie/header caps are resolved via `QuotaBudget` (`quotas.cacheKeyCookies` / `quotas.cacheKeyHeaders`) so a granted quota increase raises them.
- **Shared-route cache key on compute deploys.** Compute deploys route every request through a single default cache behavior, so `cacheKeyCookies`/`cacheKeyHeaders` would key all routes per credential. The edge router now strips the configured cookies and `authorization` on static and image routes so shared assets keep a shared cache key, while SSR/compute routes stay keyed per credential.
- **Cache-key JSDoc** on `ssrDefaultTtl`, `cacheKeyCookies`, and `cacheKeyHeaders` documenting how credentials enter the cache key and safe usage.
- **`@aws-blocks/core`:** `Hosting` exposes `ssrDefaultTtl`, `cacheKeyCookies`, and `cacheKeyHeaders` as top-level props and forwards them to the CDN cache-key config.

Note: any route that sets cookies via `Set-Cookie`, or otherwise varies per user without opting into the cache key, must emit `Cache-Control: private` so its response is not cached as a single shared entry at the edge.
