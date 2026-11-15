---
'@aws-blocks/core': patch
---

`withAuth(fn, cookies)` accepts a request that carries no cookies. With an explicit `null` or empty `cookies` argument, which is what `request.headers.get('cookie')` returns for a visitor without a session, `withAuth` runs `fn` without cookies when it detects none, instead of throwing a `401`. Public API methods now work during server rendering for signed-out visitors, and protected methods answer their own `401`. Cookies from an existing request context or a registered provider are still used when present, and `withAuth(fn)` with the argument omitted still throws a `401` when it finds none.
