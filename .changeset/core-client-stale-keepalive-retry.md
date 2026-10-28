---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

feat(core): Node clients resend a call once when the connection closes before the response headers arrive (at-least-once delivery); `retryStaleConnection: false` opts out

In Node (CLIs, SSR servers, scripts), an API call made after a few idle seconds could fail with `TypeError: fetch failed` (cause `other side closed`, `ECONNRESET` or `EPIPE`) when the deployed API had closed the pooled keep-alive connection just as the call was sent. The typed client now resends such a call once on a new connection, but only when `fetch` failed before the response headers arrived, with `TypeError: fetch failed` whose cause is an undici socket error (`UND_ERR_SOCKET`, for example `other side closed`), `ECONNRESET` or `EPIPE`.

**This makes delivery at-least-once.** In the idle-close race the first copy never reached your method. But Node's `fetch` doesn't say whether the connection was a reused one, so the same failure on a fresh connection is resent too, including a server that read the request and crashed before answering: in that rare case a method runs twice. Behind API Gateway or CloudFront a crashed backend answers with a 5xx, which is never retried. Keep state-changing methods idempotent where a duplicate would matter, or pass `retryStaleConnection: false` to `ApiNamespaceClient` (or to the generated `generateClient`) for at-most-once delivery. Timeouts, aborts, failures after the response headers arrived (while reading the body), and HTTP or JSON-RPC errors are still never retried. Browser behaviour is unchanged (browsers already resend in this case).
