---
'@aws-blocks/core': patch
'@aws-blocks/blocks': patch
---

fix(core): cookies set by an API method are no longer dropped on AWS when more than one is set

When an `ApiNamespace` method set more than one cookie in a single response
(for example `context.response.headers.set('set-cookie', …)` followed by
`append('set-cookie', …)`), only one of them reached the browser on AWS — the
others were silently lost. Local development was unaffected, so the problem
only appeared after deploying. Every `Set-Cookie` value is now delivered,
matching how `RawRoute` responses already behaved. This also fixes `Auth`
responses that set both the session cookie and the auto-sign-in cookie.
