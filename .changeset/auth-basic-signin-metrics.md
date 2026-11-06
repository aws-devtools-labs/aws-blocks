---
"@aws-blocks/bb-auth-basic": minor
"@aws-blocks/blocks": patch
---

`AuthBasic` can now emit sign-in metrics you can alarm on. Pass a `Metrics` instance as the new `metrics` option and every `signIn` emits a CloudWatch count: `SignInSuccess`, `SignInFailure` (unknown user, unconfirmed user or wrong password, under one name so usernames are not revealed) or `SignInLocked` (refused by the `lockout` policy), each with an `AuthBlock` dimension naming the AuthBasic instance.

The option is off by default, so existing apps emit nothing and pay nothing new. A failing emitter is logged and never changes a sign-in result.
