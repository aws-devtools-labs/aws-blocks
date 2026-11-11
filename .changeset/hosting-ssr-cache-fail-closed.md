---
"@aws-blocks/hosting": minor
"@aws-blocks/blocks": minor
---

fix(hosting): keep credentialed and cookie-setting SSR responses out of the shared edge cache

The hosting construct now installs an SSR cache guard in front of the SSR server it builds, and in front of every other regional compute a route targets (native Lambda handlers, buffered or streaming; Node.js servers on the Lambda Web Adapter or a Lambda Web Function), for every framework. Where the guard cannot be installed (e.g. a Lambda Web Adapter server that is not Node.js), synth emits a `@aws-blocks/hosting:SsrCacheGuardNotInstalled` warning. The guard sends `Cache-Control: private, no-store` in place of the origin's value when:

- the response sets cookies (`Set-Cookie`) and is not already `private` or `no-store`; or
- the request carries `Authorization` (unless `'authorization'` is in `cacheKeyHeaders`) or a cookie whose name is not in the SSR cache key (the Next.js preview cookies, the skew-protection `__dpl` cookie and `cacheKeyCookies`), and the response is shared-cacheable: `s-maxage`, `public`, `max-age` without `private`, a future `Expires`, no caching headers while `ssrDefaultTtl > 0`, or an error status CloudFront caches without caching headers (404, 414, 500-504). Behind the CloudFront-over-ALB door, whose server-route cache key holds every cookie, only `Authorization` and `Set-Cookie` lead to the rewrite.

Responses already `private`/`no-store`, or `no-cache` without `s-maxage`, are unchanged. The cache-key names are baked into the generated guard module at synth.

**BREAKING:** SSR responses that the origin marks shared-cacheable are no longer edge-cached for requests that carry `Authorization` or cookies outside the cache key, and responses with `Set-Cookie` are never edge-cached. To keep a credentialed route cacheable, list its session cookie in `cacheKeyCookies` and/or `'authorization'` in `cacheKeyHeaders`, so the cache is keyed per credential. Client-side analytics and consent cookies (`_ga`, `_gid`, `_fbp`, consent cookies) make ISR/SSR pages uncacheable at the edge for every visitor that carries them, unless they are listed in the new `cacheGuardIgnoredCookies` option (`frontDoor.features.cacheGuardIgnoredCookies`), which the guard ignores and keeps out of the cache key; a listed cookie must never affect the rendered output.

A distribution with a server sets the error caching minimum TTL to 0 for 500, 501, 502, 503 and 504 (CloudFront caches these for 10 s by default, and caches 500 and 502-504 whatever their `Cache-Control` says), keeping any error page configured for them.

The SSR cache policy's maximum TTL (and the server-route cache policy of the CloudFront-over-ALB front door) is lowered from 1 year to 1 day, so an origin `s-maxage` longer than a day is clamped to a day.

On a Lambda Web Adapter server the guard is loaded through `NODE_OPTIONS` (`--import`); a `NODE_OPTIONS` set in `compute.environment` keeps the guard loaded first.
