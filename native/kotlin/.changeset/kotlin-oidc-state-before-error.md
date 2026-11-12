---
"aws-blocks-kotlin": patch
---

`OidcClient.signIn` checks the callback's `state`, and the CSRF value in its envelope, before it
honours an `error` in the callback. A callback without the state the sign-in was issued is rejected
as a state mismatch, and one whose envelope carries another CSRF value as a CSRF mismatch. A page
that can reach the relay target can no longer end a pending sign-in with an error of its choosing,
or put its text on the JVM landing page or an app's error page. A state envelope the client cannot
decode now throws `OidcCallbackException("Undecodable state envelope")` instead of an
`IllegalArgumentException` or `SerializationException`.
