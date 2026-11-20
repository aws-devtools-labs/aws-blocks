---
"aws-blocks-kotlin": patch
---

The desktop (JVM) loopback listener only ends a sign-in on this attempt's relay redirect: a `GET`
of exactly `/oidc/callback` whose `state` equals the one the attempt was issued, compared in
constant time, with a non-empty `code` or an `error`. Only the first such request is served. Any
other request, including one that arrives before the browser is opened, one for a path below the
callback, and a repeat of the redirect, gets an empty 404 and leaves the sign-in as it was. Before, any request that carried a
`state` and a `code` or `error` ended the wait, so a stray local request could fail the sign-in.
