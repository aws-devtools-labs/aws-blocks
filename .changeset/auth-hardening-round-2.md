---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

Hardening:

- `Auth`: when account state is hidden (the default), the answers `Auth` withholds from the client on `resendSignUpCode`, `resetPassword`, `confirmSignUp` and `confirmResetPassword` (for example a malformed username, or an expired code reported as a wrong code) are logged at `warn`, so you can see them with a `warn`-level logger. The username is redacted from the logged Cognito message.
- `Auth`: the "already validated" marker that lets the PreSignUp trigger skip a second `validateUser` call is signed with its own key, derived from the session secret, never with the session secret itself.
