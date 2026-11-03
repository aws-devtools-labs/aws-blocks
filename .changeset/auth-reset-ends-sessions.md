---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

A password reset now signs the user out everywhere. Once `confirmResetPassword` (or the `confirmResetPassword` action of `createApi()`) succeeds, every session the user had is rejected from the next request on with 401 `NotAuthenticatedException` and its cookie is cleared, locally and on AWS. A session stolen before the reset no longer authenticates after it. The user signs in again with the new password.

- On AWS the reset also revokes the user's Cognito refresh tokens (`AdminUserGlobalSignOut`), so an Amplify or native client calling the API with bearer tokens can't refresh. An access token it already holds stays valid until it expires.
- The block's role gains `cognito-idp:AdminGetUser` and `cognito-idp:AdminUserGlobalSignOut` on its user pool, only when email + password sign-in is on. Neither needs `admin`.
- Each request with a password session makes one extra read of the sessions table. Rows gain an optional `issuedAt` field.
- If the password changed but ending the sessions failed, `confirmResetPassword` throws a 5xx (logged at error), never a wrong-code error. Reset again to end them.
- `updatePassword` and `auth.admin.setUserPassword` still leave other sessions signed in. Call `auth.admin.revokeUserSessions(username)` to end them.
