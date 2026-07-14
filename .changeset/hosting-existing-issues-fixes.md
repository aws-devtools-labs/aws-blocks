---
"@aws-blocks/hosting": patch
---

Fix ten reproducible hosting issues:

- **Next image optimizer on Next 15.x**: the `fetchInternalImage` arity patch was gated on an inverted version assumption (the `maximumResponseBody` parameter was added in Next 16, not 15.5). It now only applies on Next ≥ 16, so local image optimization no longer 500s on Next 15.x apps. Renamed `patchImageOptimizerForNext155` → `patchImageOptimizerForNext16`.
- **Image optimizer on disallowed types (SVG)**: an untrusted SVG (with `dangerouslyAllowSVG` disabled) now fails closed with its real `400` status instead of a blanket `500` — OpenNext was catching Next's 400 in a generic block that discarded the status.
- **SPA hashed assets**: the SPA adapter now marks Vite's content-hashed `assets/*` bundles `immutable` (`immutablePaths: ['assets/*']`) instead of leaving them in the revalidation-only cache tier.
- **Missing static assets**: the OAC bucket policy now grants `s3:ListBucket` so a missing key returns a clean `404 NoSuchKey` instead of leaking `403 AccessDenied` XML to the viewer.
- **RSC prefetch cache efficiency**: the SSR cache policy excludes Next's random `_rsc` prefetch query param from the cache key (`denyList('_rsc')`), so prefetches of the same page share one edge cache entry.
- **Wildcard redirects**: Next `:path*` named-catch-all redirects are now lifted to the edge router (converted to `/*`), with a bare-prefix companion redirect, so they no longer leak the literal `:path*` token in `Location`.
- **Route-table budget error**: `TooManyRoutesError` now names which table (routes/redirects/headers) exceeded the budget and calls out `trailingSlash: true` as the likely driver.
- **Nuxt ISR/SWR on-demand pages**: route coalescing no longer collapses prerendered static siblings into one `parent/*` wildcard when ISR/SWR is active (`manifest.cache` set), so a non-prebuilt on-demand child renders at the SSR Lambda instead of hard-404ing from S3.
- **CloudFront S3-origin policy**: every behavior whose origin is S3 — the default behavior AND the edge-route (`runtime: 'edge'`) behavior — now uses a synthesized custom origin request policy instead of the managed `ALL_VIEWER_EXCEPT_HOST_HEADER`, which CloudFront rejects on S3 origins (`InvalidRequest` at distribution create). The sentinel behaviors keep the managed policy (their origins are the tagged server/image custom origins, not S3). A regression guard asserts no S3-origin behavior references a managed origin request policy.
- **Nuxt IPX remote images**: the IPX image Lambda now rides the shared SSR API Gateway (via a dedicated `<baseURL>/{proxy+}` resource) instead of an OAC Function URL, so an unencoded `://` in a remote source path no longer breaks SigV4 (was `403 InvalidSignatureException`); and the IPX runtime is configured with `httpStorage` scoped to the allowlisted domains so allowlisted remote images resolve instead of `404 IPX_RESOURCE_NOT_FOUND`.
