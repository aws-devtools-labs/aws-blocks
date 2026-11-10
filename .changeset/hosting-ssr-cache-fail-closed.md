---
"@aws-blocks/hosting": minor
"@aws-blocks/blocks": minor
---

fix(hosting): keep credentialed and cookie-setting SSR responses out of the shared edge cache

The hosting construct now installs an SSR cache guard in front of the SSR server it builds (native Lambda handlers, buffered or streaming; Node.js servers on the Lambda Web Adapter or a Lambda Web Function), for every framework. Where the guard cannot be installed (e.g. a Lambda Web Adapter server that is not Node.js), synth emits a `@aws-blocks/hosting:SsrCacheGuardNotInstalled` warning. The guard sends `Cache-Control: private, no-store` in place of the origin's value when:

- the response sets cookies (`Set-Cookie`); or
- the request carries `Authorization` (unless `'authorization'` is in `cacheKeyHeaders`) or a cookie whose name is not in the SSR cache key (the Next.js preview cookies, the skew-protection `__dpl` cookie and `cacheKeyCookies`), and the response is shared-cacheable: `s-maxage`, `public`, `max-age` without `private`, a future `Expires`, or no caching headers while `ssrDefaultTtl > 0`.

Responses already `private`/`no-store`, or `no-cache` without `s-maxage`, are unchanged. The cache-key names are baked into the generated guard module at synth.

**BREAKING:** SSR responses that the origin marks shared-cacheable are no longer edge-cached for requests that carry `Authorization` or cookies outside the cache key, and responses with `Set-Cookie` are never cached. To keep a credentialed route cacheable, list its session cookie in `cacheKeyCookies` and/or `'authorization'` in `cacheKeyHeaders`, so the cache is keyed per credential.

The SSR cache policy's maximum TTL is lowered from 1 year to 1 day, so an origin `s-maxage` longer than a day is clamped to a day.

On a Lambda Web Adapter server the guard is loaded through `NODE_OPTIONS` (`--import`); a `NODE_OPTIONS` set in `compute.environment` keeps the guard loaded first.
