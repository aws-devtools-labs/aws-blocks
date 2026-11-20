---
"@aws-cdk-blocks/hosting": patch
---

The SSR cache guard now reads `Vary` behind the CloudFront door and the stacked door. CloudFront ignores `Vary`, so a shared-cacheable response that varies on a request header outside the server-route cache key (for example `Vary: Accept-Language` with `Cache-Control: public, s-maxage=60`) was stored once and served to every visitor whatever that header said. Such a response, and any shared-cacheable response with `Vary: *`, is now sent as `Cache-Control: private, no-store`, keeps its `Vary` header for the browser, and the server logs once per header name why. `Accept-Encoding`, the Next.js router headers and, on the CloudFront door, `cacheKeyHeaders` count as keyed; add a header to `frontDoor.features.cacheKeyHeaders` to cache one copy per value instead.
