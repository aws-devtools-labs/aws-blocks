---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): only forward real cookie deletions on an API error response

When an API method throws, only `Set-Cookie` headers that delete a cookie are sent with the error, so a method can clear a session cookie but never issue one. The deletion check used `Date.parse` on `Expires`, so values like `Expires=0` or `Expires=1` counted as deletions. Browsers ignore those values and keep the cookie, so a live cookie could reach the client on an error. The check is now strict. A cookie counts as deleted only with an integer `Max-Age` of `0` or less, or an `Expires` that is an IMF-fixdate (`Thu, 01 Jan 1970 00:00:00 GMT`) at or before now. Any other value is not a deletion and is dropped from the error response.
