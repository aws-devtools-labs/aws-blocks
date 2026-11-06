---
"@aws-blocks/bb-secret": patch
---

After `put()` resolves, the next `get()` on that `Secret` instance now returns the new value on AWS, as documented. Previously a `get()` whose Secrets Manager fetch was still in flight when `put()` cleared the read cache stored its pre-write result afterwards. Later reads then returned the old value until the cache entry expired (`cacheTtlSeconds`, default 300 s). Such a read now returns what it fetched without caching it. Cache TTL behavior is unchanged, and the local mock, which has no read cache, is unaffected.
