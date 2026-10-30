---
"@aws-blocks/core": patch
---

The typed API client now rejects with an `ApiError` when a response is not a JSON-RPC envelope, such as a gateway's own `429`, `403`, `502` or `504` reply or an HTML error page, instead of resolving `undefined`. The error carries the HTTP status and the gateway's `message` when present.
