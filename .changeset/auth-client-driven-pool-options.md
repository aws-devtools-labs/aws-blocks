---
'@aws-blocks/bb-auth': minor
'@aws-blocks/blocks': minor
---

`Auth` can now share its user pool with a frontend that signs in directly against Cognito, such as one built with the Amplify client libraries. All three additions are opt-in; a block that sets none of them synthesizes the same template as before.

- **`users.caseSensitive`.** Set `false` to match usernames, and the email or phone a user signs in with, ignoring case (Cognito's `UsernameConfiguration.CaseSensitive`, the setting Amplify Gen 2 pools use). Cognito fixes it when the pool is created, so the block refuses a later change at synth and again at deploy. Unset keeps Cognito's default, case-sensitive. The local user pool in `npm run dev` matches names the same way.
- **`allowBearerAuth: { clientIds }`.** Besides `true`, `allowBearerAuth` now takes an object whose `clientIds` lists other app clients of the same pool. The guards then accept the access tokens those clients issue, fully verified (signature, issuer, `token_use: access`, expiry, client). The client id given to `Auth.fromExisting(userPoolId, clientId)` is accepted the same way once `allowBearerAuth` is on; before, it was ignored. An id can be a literal or a CDK token, such as the app client Amplify Gen 2 creates in the same CDK app: the block forwards the list through its deployed config, so a token resolves at deploy time. The frontend sends the access token, never the ID token (with Amplify JS, `(await fetchAuthSession()).tokens?.accessToken`).
- **`user.federatedIdentity`.** A federated user now carries `{ providerId, sub }`: the provider's key in your options and the provider's own subject for the user. It is the same whether the provider uses `federateVia: 'direct'` or `federateVia: 'cognito'`, so data keyed on it survives moving a provider between the two. It is server-side only and never sent to the browser.

The README has a new section, "Planning to use Amplify client libraries?", covering the pool shape, which `federateVia` to pick, `userSub` (Amplify's `userId`), adding an app client for the Amplify app, and the sign-in hooks. `phase: 'signIn'`, `onSignIn` and `onSignOut` run only for sign-ins that go through the block, and their docs now say so.
