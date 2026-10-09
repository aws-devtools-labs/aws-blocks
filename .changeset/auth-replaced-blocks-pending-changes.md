---
'@aws-blocks/bb-auth': patch
'@aws-blocks/auth-common': patch
'@aws-blocks/blocks': patch
---

Fixes made to `AuthCognito`, `AuthOIDC` and `AuthBasic` since their last release (`bb-auth-cognito` 0.1.11, `bb-auth-oidc` 0.2.1, `bb-auth-basic` 0.1.10) ship in `Auth`, which replaces them in this release. If you upgrade an `AuthCognito`, `AuthOIDC` or `AuthBasic` app to `Auth`, this is what changes for you compared with those versions.

**Security (from `AuthCognito`)**

- After `autoSignIn`, the auto-sign-in cookie (which holds the encrypted sign-up password) is actually cleared in the browser. Before, writing the session cookie overwrote the clear, so the cookie stayed for up to 15 minutes.
- IAM and credential errors from AWS (for example `AccessDeniedException`) no longer send their message, which names your function's role ARN and AWS account ID, to the client. The client gets a generic message with HTTP 500, and the full detail goes to the block's logger. No error message that contains an ARN or account ID reaches the client.
- A client can no longer tell whether an account exists. On any user pool, including one adopted with `fromExisting` that doesn't enable `PreventUserExistenceErrors`, an unknown user gets exactly the same sign-in error as a wrong password (`NotAuthorizedException`, 401, "Incorrect username or password"). The same applies to a disabled user. `resendSignUpCode` succeeds for an unknown user. `confirmSignUp` and `confirmResetPassword` answer an unknown user like a wrong code (`CodeMismatchException`). `resetPassword` returns plausible delivery details instead of an empty or placeholder destination. Both the local mock and AWS behave this way. `auth.admin.*` still reports `UserNotFoundException`.

**Behaviour (from `AuthCognito`)**

- Refreshed ID tokens are verified the same way as at sign-in. A token that fails verification signs the user out and clears the session cookie.
- Errors raised by the block itself keep their status. For example, "Cognito returned no tokens" is a 500, and an SRP challenge is a non-retriable 501 (it was reported as a retriable 400).
- `InternalErrorException` from Cognito is a retriable 500 instead of a non-retriable 400.
- In the local mock, masked phone numbers keep the leading `+` (`+*******0100`), matching Cognito.

**Behaviour (from `AuthOIDC`)**

- A provider with `federateVia: 'cognito'` no longer fails `cdk synth` with `CannotFindAsset`. The published `bb-auth-oidc` package was missing the bundled Lambda that registers the identity provider on the user pool; `@aws-blocks/bb-auth` ships it (`dist/idp-registration-lambda/`), and a release check now fails if a packed package lacks a deploy-time Lambda bundle it loads.

**Docs (from `AuthOIDC`)**

- Federating a provider through Cognito does not add MFA, adaptive authentication or brute-force protection to its sign-in: for federated users, Amazon Cognito delegates authentication to the identity provider and offers no extra authentication factors, device tracking or threat protection. The `Auth` README says so and tells you to enforce MFA at the IdP (for example Google 2-Step Verification, or your Okta / Microsoft Entra ID MFA policy). `AuthOIDC`'s docs had claimed otherwise.
- `@aws-blocks/auth-common`: the error-name mapping table in `DESIGN.md` lists the AWS credential and IAM error names that `Auth` (like `AuthCognito`) can report.

**Internal**

- The tests that pinned what `AuthCognito` deploys — the CloudFormation identity of its user pool, app client, groups, session table and session secret, its config keys and its session cookie name, plus `AuthOIDC`'s deployed resources — and the offline tests of the Cognito runtime against a stubbed client (sign-in, sign-up, sign-out, refresh, cookie verification, error mapping, live group checks) now run against `Auth`, with `AuthCognito`'s side frozen from its final source. No runtime or infrastructure change.
