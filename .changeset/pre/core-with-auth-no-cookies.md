---
'@aws-cdk-blocks/core': minor
'aws-cdk-blocks': minor
---

`withAuth(fn, cookies, { allowAnonymous: true })` runs `fn` signed out when no cookies are found, instead of throwing a `401`. Use it for server-rendered pages that signed-out visitors can see: public API methods work, and methods gated with `auth.requireAuth` still answer `401`. A missing, `null`, empty or blank `cookies` argument all count as "no cookies", so the option works with Fetch `headers.get('cookie')`, Node `req.headers.cookie`, and the built-in Next.js detection (`withAuth(fn, undefined, { allowAnonymous: true })`). Explicit cookies, an existing request context, and registered providers still take precedence. Without the option, `withAuth` behaves as before. The `WithAuthOptions` type is exported from `@aws-cdk-blocks/core/server` and `aws-cdk-blocks/server`.

With the option, pages that answered an error for signed-out visitors now render with a `200`. Responses to requests without cookies can be edge-cached, so check that the anonymous HTML of these pages is safe to cache.
