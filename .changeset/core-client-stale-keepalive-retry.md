---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): Node clients no longer fail with `fetch failed` when a deployed API closes an idle connection

In Node (CLIs, SSR servers, scripts), an API call made after a few idle seconds could fail with `TypeError: fetch failed` (cause `other side closed` or `ECONNRESET`) when the deployed API had closed the pooled keep-alive connection just as the call was sent. The typed client now resends such a call once on a new connection, but only when the connection failed before any response byte arrived. In that idle-close race the first copy never reached your method. A server that crashes after reading a request but before answering looks the same, so in that rare case a method can run twice. Behind API Gateway or CloudFront a crashed backend answers with a 5xx, which is never retried, so keep state-changing methods idempotent where a duplicate would matter. Timeouts, aborts, failures after the response started, and HTTP or JSON-RPC errors are still never retried. Browser behaviour is unchanged (browsers already resend in this case).
