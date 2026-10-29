---
'@aws-blocks/core': patch
'@aws-blocks/blocks': patch
---

fix(core): let API errors clear cookies, and deliver cookies on HTTP API / Function URL events

- **An API method that throws can now clear cookies in the same response**,
  both locally and on AWS. Before, an error response dropped every
  `Set-Cookie` the method had set, so a method could not, for example, reject
  with a 401 _and_ clear a stale session cookie in one call. Now cookies that
  are being deleted (`Max-Age` of 0 or less, or an `Expires` in the past) are
  delivered with the error. Any other cookie set before the throw is still
  dropped, so a method that signs a user in and then rejects them (for example
  a post-sign-in access check that throws a 403) never hands out a live
  session. The error itself is unchanged, the method's other response headers
  are still not sent with an error, and errors without cookies are returned
  exactly as before. Successful responses and `RawRoute`s are unaffected.
- **Multiple cookies now work when the Lambda handler is invoked with the
  API Gateway HTTP API / Function URL event format (payload version 2.0).**
  `Set-Cookie` values are returned in that format's `cookies` list, for both
  API methods and `RawRoute`s. The default deployment (API Gateway REST API)
  is unaffected.
