---
"aws-blocks-swift": patch
---

A refused OIDC sign-in now reports the server's error instead of "malformed exchange response"

When the backend refused an OIDC code exchange (or any other auth raw route), for example because the sign-in provider rejected the code, the Swift client ignored the HTTP status. It read the error body as if it were a success and threw `OIDCError.malformedExchangeResponse`, which hid what went wrong.

Raw routes now throw `RawRouteError` for any response outside 2xx. Its `message` names the route, the HTTP status, and the error name and message the server sent, for example `/aws-blocks/auth/exchange answered HTTP 400 (IdpErrorException: The sign-in provider refused the sign-in.)`. The new `statusCode` and `errorName` properties carry the same details. That matches the Kotlin and Dart clients, which already reported a failed exchange by its HTTP status. `malformedExchangeResponse` is still thrown for a 2xx response that has no `user`.

Code that caught `OIDCError.malformedExchangeResponse` to handle a refused sign-in should catch `RawRouteError` as well.
