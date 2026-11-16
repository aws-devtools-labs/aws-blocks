---
"aws-blocks-kotlin": patch
---

A JSON-RPC error that arrives with a non-2xx HTTP status is now thrown as the same `ApiException` as one that arrives with HTTP 200. A backend namespace created with `httpErrorStatus: true` answers a 4xx `ApiError` that way, for example a 401 from `requireAuth()`; the client used to fail with an `IllegalArgumentException` instead. A non-2xx response that carries no JSON-RPC error object is a transport failure rather than an application one.
