---
'@aws-blocks/core': patch
'@aws-blocks/blocks': patch
---

The local dev server now handles API and raw-route requests through the same dispatcher as deployed handlers, so cookie and error responses match. Handlers in local dev can now read the request cookies and client user agent through the request context, API and raw-route responses carry the same no-store cache headers, and `ctx.request.url` formats the query string the same way as in a deployment.
