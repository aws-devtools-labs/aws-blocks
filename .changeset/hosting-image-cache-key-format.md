---
'@aws-blocks/hosting': patch
---

Fix the CloudFront door caching one image format for every viewer. Image optimization requests (Next.js `/_next/image`, the Nuxt and Astro image endpoints) are keyed by the default behavior's cache policy, which left out `Accept`, so the first viewer's format was served to every later one: a client without WebP support got a cached WebP, or a WebP-capable browser got the source PNG. The edge router now writes the formats the viewer accepts (`avif`, `webp`, both, or neither) into an `x-blocks-image-format` header on image routes, and the SSR cache policy keys on it when the app has an image optimizer. `Accept` stays out of the page cache key. The header takes a free cache-key header slot; an app whose `cacheKeyHeaders` already uses all five keeps its cache key and gets a `@aws-blocks/hosting:ImageFormatNotInCacheKey` synth warning.
