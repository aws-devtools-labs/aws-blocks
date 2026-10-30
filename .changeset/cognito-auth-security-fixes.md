---
'@aws-blocks/bb-auth-cognito': patch
'@aws-blocks/blocks': patch
'@aws-blocks/auth-common': patch
---

`AuthCognito`: security and error-reporting fixes.

- **Security:** after `autoSignIn`, the auto-sign-in cookie (which holds the encrypted sign-up password) is now actually cleared in the browser. Before, writing the session cookie overwrote the clear, so the cookie stayed for up to 15 minutes.
- **Security:** IAM and credential errors from AWS (for example `AccessDeniedException`) no longer send their message, which names your function's role ARN and AWS account ID, to the client. The client gets a generic message with HTTP 500, and the full detail goes to the block's logger. No error message that contains an ARN or account ID reaches the client.
- **Security:** a client can no longer tell whether an account exists. On any user pool, including one adopted with `fromExisting` that doesn't enable `PreventUserExistenceErrors`, an unknown user now gets exactly the same sign-in error as a wrong password (`NotAuthorizedException`, 401, "Incorrect username or password"). The same applies to a disabled user. `resendSignUpCode` now succeeds for an unknown user. `confirmSignUp` and `confirmResetPassword` now answer an unknown user like a wrong code (`CodeMismatchException`). `resetPassword` returns plausible delivery details instead of an empty or placeholder destination. Both the local mock and AWS behave this way. `auth.admin.*` still reports `UserNotFoundException`.
- Refreshed ID tokens are now verified the same way as at sign-in. A token that fails verification signs the user out and clears the session cookie.
- Errors raised by the block itself keep their status. For example, "Cognito returned no tokens" is a 500, and an SRP challenge is a non-retriable 501 (it was reported as a retriable 400).
- `InternalErrorException` from Cognito is now a retriable 500 instead of a non-retriable 400.
- In the local mock, masked phone numbers now keep the leading `+` (`+*******0100`), matching Cognito.
- `@aws-blocks/auth-common`: the error-name mapping table in `DESIGN.md` now lists the AWS credential and IAM error names that `AuthCognito` can report.
