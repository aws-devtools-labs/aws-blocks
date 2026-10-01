---
"aws-blocks-kotlin": minor
---

Improve what the browser shows after a JVM/desktop OIDC sign-in. The loopback server now
serves styled, self-contained success and failure pages instead of a single line of HTML, and
a failed sign-in no longer renders the success page. `signIn` accepts an `OidcSignInOptions`,
whose `platformOptions` is a per-target type; on JVM its `successPage` and `errorPage` take an
`OidcLandingPage`: `BuiltIn`, `Redirect(url)` to send the browser to your own page, or
`Html(document)` to serve your own markup without hosting anything.
