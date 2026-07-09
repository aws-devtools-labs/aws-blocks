---
"@aws-blocks/hosting": patch
---

Fix six reproducible hosting issues:

- **Next image optimizer on Next 15.x**: the `fetchInternalImage` arity patch was gated on an inverted version assumption (the `maximumResponseBody` parameter was added in Next 16, not 15.5). It now only applies on Next ≥ 16, so local image optimization no longer 500s on Next 15.x apps. Renamed `patchImageOptimizerForNext155` → `patchImageOptimizerForNext16`.
- **SPA hashed assets**: the SPA adapter now marks Vite's content-hashed `assets/*` bundles `immutable` (`immutablePaths: ['assets/*']`) instead of leaving them in the revalidation-only cache tier.
- **Missing static assets**: the OAC bucket policy now grants `s3:ListBucket` so a missing key returns a clean `404 NoSuchKey` instead of leaking `403 AccessDenied` XML to the viewer.
- **RSC prefetch cache efficiency**: the SSR cache policy excludes Next's random `_rsc` prefetch query param from the cache key (`denyList('_rsc')`), so prefetches of the same page share one edge cache entry.
- **Wildcard redirects**: Next `:path*` named-catch-all redirects are now lifted to the edge router (converted to `/*`), with a bare-prefix companion redirect, so they no longer leak the literal `:path*` token in `Location`.
- **Route-table budget error**: `TooManyRoutesError` now names which table (routes/redirects/headers) exceeded the budget and calls out `trailingSlash: true` as the likely driver.
