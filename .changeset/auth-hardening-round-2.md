---
'@aws-blocks/bb-auth': patch
'@aws-blocks/core': patch
'@aws-blocks/blocks': patch
---

Hardening:

- `Auth`: when account state is hidden (the default), the answers `Auth` withholds from the client on `resendSignUpCode`, `resetPassword`, `confirmSignUp` and `confirmResetPassword` (for example a malformed username, or an expired code reported as a wrong code) are logged at `warn`, so you can see them with a `warn`-level logger. The username is redacted from the logged Cognito message.
- `Auth`: the "already validated" marker that lets the PreSignUp trigger skip a second `validateUser` call is signed with its own key, derived from the session secret, never with the session secret itself.
- `@aws-blocks/core`: an RPC error response no longer passes through a `Set-Cookie` whose `Max-Age` is malformed but could be read as a positive lifetime (such as `+999` or `999abc`), even when its `Expires` is in the past. Error responses carry only cookies that every browser deletes.
