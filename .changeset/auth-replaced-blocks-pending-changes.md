---
'@aws-blocks/bb-auth': patch
'@aws-blocks/auth-common': patch
'@aws-blocks/blocks': patch
---

Fixes made to `AuthCognito`, `AuthOIDC` and `AuthBasic` since their last release (`bb-auth-cognito` 0.1.12, `bb-auth-oidc` 0.2.2, `bb-auth-basic` 0.1.11) ship in `Auth`, which replaces them in this release. If you upgrade an `AuthCognito`, `AuthOIDC` or `AuthBasic` app to `Auth`, this is what changes for you compared with those versions.

**Security (from `AuthCognito`)**

- After `autoSignIn`, the auto-sign-in cookie (which holds the encrypted sign-up password) is actually cleared in the browser. Before, writing the session cookie overwrote the clear, so the cookie stayed for up to 15 minutes.
- IAM and credential errors from AWS (for example `AccessDeniedException`) no longer send their message, which names your function's role ARN and AWS account ID, to the client. The client gets a generic message with HTTP 500, and the full detail goes to the block's logger. No error message that contains an ARN or account ID reaches the client.
- A client can no longer tell whether an account exists. On any user pool, including one adopted with `fromExisting` that doesn't enable `PreventUserExistenceErrors`, an unknown user gets exactly the same sign-in error as a wrong password (`NotAuthorizedException`, 401, "Incorrect username or password"). The same applies to a disabled user. `resendSignUpCode` succeeds for an unknown user. `confirmSignUp` and `confirmResetPassword` answer an unknown user like a wrong code (`CodeMismatchException`). `resetPassword` returns plausible delivery details instead of an empty or placeholder destination. Both the local mock and AWS behave this way. `auth.admin.*` still reports `UserNotFoundException`.

**Behaviour (from `AuthCognito`)**

- Refreshed ID tokens are verified the same way as at sign-in. A token that fails verification signs the user out and clears the session cookie.
- Errors raised by the block itself keep their status. For example, "Cognito returned no tokens" is a 500, and an SRP challenge is a non-retriable 501 (it was reported as a retriable 400).
- `InternalErrorException` from Cognito is a retriable 500 instead of a non-retriable 400.
- In the local mock, masked phone numbers keep the leading `+` (`+*******0100`), matching Cognito.

**Behaviour (from `main`'s synth guards, #824)**

- Calling a runtime method of `Auth` (for example `auth.requireAuth()` or `auth.admin`) at the top level of a backend module, which runs it during `cdk synth`, throws the actionable `Auth.<method>() cannot be called during CDK synth` error that every Building Block gives, instead of a `TypeError`. `AuthOIDC.signInRoutePath()` has no `Auth` equivalent to make synth-safe: `Auth`'s sign-in routes are fixed (`/aws-blocks/auth/signin/<provider>`).

**From `main` after those releases (#840, #903, #887)**

- `AuthBasic` gained server-side revocation of a signed-out session token (#840) and an opt-in per-username sign-in lockout (#903). Neither ships in `Auth`, which replaces `AuthBasic`: `Auth`'s `signOut()` deletes the session row, so a replayed cookie is already rejected, and Cognito applies its own sign-in throttling to repeated failed password attempts.
- `AuthOIDC`'s signed state and session cookies use Node's built-in `base64url` (#887). `Auth` already encodes its state envelope and cookies that way, so nothing changes for you.

**From `main` after those releases (#949, #827, #510, #1032, #1042, browser error constants)**

- `AuthBasic` capped failed guesses against one verification code at 5 (#949). `Auth`'s sign-up and password-reset codes are Amazon Cognito's, which limits repeated failed code attempts itself; the local mock does not cap them.
- `AuthOIDC`'s `cdk` and `aws-runtime` entries gained the `OIDCClient` type (#827). `Auth` has no `OIDCClient` (federated sign-in buttons come from `getAuthState()`), and every `Auth` entry exports the same types.
- `AuthBasic`'s same-origin session cookie dropped `Secure` behind a plain-HTTP front door such as a TLS-less ALB (#510). `Auth` keeps `Secure` off localhost, so put an HTTPS front door in front of it.
- `AuthBasic` and `AuthCognito`'s browser stubs no longer imported `ApiNamespace`, so their error constants could be imported in frontend code. `Auth`'s browser entry never imported it: `import { AuthErrors } from '@aws-blocks/bb-auth'` bundles for the browser.
- `AuthOIDC`'s mock cookie secret became random per project (#1032). `Auth`'s local session secret already was. `Auth`'s mock entry now fails closed on deployed compute, like every Building Block's.
- `AuthOIDC` limited `stubIdp()` to local development and sandbox deployments (#1042). So does `Auth` (see the `stubIdp()` changeset).

**From `main` after those releases (#1050)**

- `AuthOIDC`'s `cognitoFederated()` app client registered only an `https://localhost` placeholder callback URL, so Cognito answered `redirect_mismatch` for a deployed app (#1050 fixed it and added `additionalCallbackUrls` / `additionalLogoutUrls`). `Auth`'s hosted-UI app client registers the backend's API URL and the public origin `Hosting` registers as its callback and sign-out URLs, so a deployed `Auth` app signs in through Cognito. `Auth` has no `additionalCallbackUrls` / `additionalLogoutUrls` options.

**From `main` after those releases (#1120)**

- `AuthBasic`'s browser entry gained the `AuthActionInput` type, which its server entry and README already had (#1120). `Auth` does not re-export `@aws-blocks/auth-common`'s types from any entry: import `AuthActionInput` from `@aws-blocks/blocks` (the migrate codemod says so). Every `Auth` entry, the browser one included, exports the same types, including the options-narrowed `AuthActionInputOf<O>`.

**Docs (from `AuthOIDC`)**

- Federating a provider through Cognito does not add MFA, adaptive authentication or brute-force protection to its sign-in: for federated users, Amazon Cognito delegates authentication to the identity provider and offers no extra authentication factors, device tracking or threat protection. The `Auth` README says so and tells you to enforce MFA at the IdP (for example Google 2-Step Verification, or your Okta / Microsoft Entra ID MFA policy). `AuthOIDC`'s docs had claimed otherwise.
- `@aws-blocks/auth-common`: the error-name mapping table in `DESIGN.md` lists the AWS credential and IAM error names that `Auth` (like `AuthCognito`) can report.

**Internal**

- The tests that pinned what `AuthCognito` deploys — the CloudFormation identity of its user pool, app client, groups, session table and session secret, its config keys and its session cookie name, plus `AuthOIDC`'s deployed resources — and the offline tests of the Cognito runtime against a stubbed client (sign-in, sign-up, sign-out, refresh, cookie verification, error mapping, live group checks) now run against `Auth`, with `AuthCognito`'s side frozen from its final source. No runtime or infrastructure change.
