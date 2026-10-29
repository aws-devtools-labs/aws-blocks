---
"aws-blocks-kotlin": patch
---

A JSON-RPC error that arrives with a non-2xx HTTP status is now thrown as the same `ApiException` (with its `code` and `data`) as one that arrives with HTTP 200. A backend namespace created with `httpErrorStatus: true` answers a 4xx `ApiError` that way, for example a 401 from `requireAuth()`; the client used to fail with an `IllegalArgumentException` instead. A non-2xx response without a JSON-RPC error body is still a `NetworkException`.
