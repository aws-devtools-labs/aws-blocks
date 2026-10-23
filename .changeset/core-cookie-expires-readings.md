---
'@aws-blocks/core': patch
'@aws-blocks/blocks': patch
---

An RPC error response now passes a `Set-Cookie` through only when every browser would delete that cookie, including when it has several `Expires` attributes or one that is not a strict HTTP date. For example, `Expires=Thu, 01 Jan 1970 00:00:00 GMT; Expires=Fri, 01-Jan-2100 00:00:00 GMT` is no longer treated as a deletion, because browsers keep the later date. Cookies cleared the usual way (`Max-Age=0`, or a single past `Expires`) are unaffected.
