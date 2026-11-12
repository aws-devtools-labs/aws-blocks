---
"@aws-blocks/bb-auth": minor
"@aws-blocks/blocks": minor
---

`Auth`: a password change ends the user's other sessions, new audit hooks, opt-in sign-in metrics, and a cap on wrong local verification codes.

- **`updatePassword` ends the user's other sessions.** Every other session of the user is rejected from its next request on (401 `NotAuthenticatedException`), and on AWS their Cognito refresh tokens are revoked, as after `confirmResetPassword`. The caller stays signed in: their session is re-issued with the new password and the response sets a new session cookie. When signing in again needs a step only the user can answer (an MFA code), the caller's session ends too and they sign in again; the password change still succeeds.
- **`auth.admin.setUserPassword` ends the user's sessions**, the same way.
- **New audit hooks:** `onSignInFailed` (with the username as supplied, the step, the client's error name and a coarse reason that reports an unknown user and a wrong password alike), `onPasswordResetRequested`, `onPasswordReset` and `onPasswordChanged`. Each is awaited; a throw is logged and never changes the result. No payload carries a password or a code.
- **Opt-in sign-in metrics:** pass a `Metrics` instance as the new `metrics` option and each sign-in emits a CloudWatch count — `SignInSuccess`, `SignInFailure` or `SignInLocked` — with an `AuthBlock` dimension naming the `Auth` instance. Off by default.
- **Local verification codes are invalidated after 5 wrong attempts.** The 5th wrong answer, and every answer for the next 15 minutes, gets 429 `LimitExceededException` (the name Cognito answers with); requesting a new code does not reset the count.
