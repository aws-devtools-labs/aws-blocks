---
"@aws-blocks/bb-auth-cognito": patch
---

fix(bb-auth-cognito): stop leaking raw Cognito SDK text in ApiError wire messages

Cognito SDK failures are now translated to a BB-authored message keyed on the exception name; the raw SDK error stays on the non-enumerable `cause`. Error `name`, HTTP status, and `retriable` are unchanged. `auth.admin.scan()` now translates SDK failures the same way as every other admin method.
