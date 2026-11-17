---
"@aws-blocks/bb-auth": patch
"@aws-blocks/auth-common": patch
"@aws-blocks/blocks": patch
---

`auth.createApi()` is typed by the block's options, so the frontend gets the same gates as the server-side methods, and the signed-in user with its own groups and attributes.

- **Actions.** `setAuthState` takes `AuthActionInputOf<O>`: the password actions (`signIn`, `signUp`, `confirmSignUp`, `resendSignUpCode`, `autoSignIn`, `resetPassword`, `confirmResetPassword`, `confirmSignIn`) need email + password, the passkey actions need `passkeys`, and `confirmSignIn` takes only the challenges the configuration can produce: the MFA challenges follow `mfa.types` (and `mfaType` is one of them), and the first-factor ones need `users.authFlow: 'USER_AUTH'`. On an `emailPassword: false` block, `authApi.setAuthState({ action: 'signIn', username, password })` and `submitAuthAction(authApi, { action: 'signIn', … })` are compile errors. A setting the compiler cannot see (the wide `Auth` type, a `boolean`-typed option, a union `authFlow`, a wrapped pool, `mfa.types` typed `MfaFactor[]`) keeps its actions.
- **User.** `AuthState.user` is `AuthStateUser<O>`: the signed-in `AuthenticatedUser` (`groups` typed by `users.groups`, `attributes`, `userSub`, `signInProvider`) without the server-only `claims` and `federatedIdentity`. `onAuthChange`, `AuthenticatedContent`, `subscribeAuthState`, `getAuthStateSnapshot` and `submitAuthAction` pass it on, so `onAuthChange(authApi, (user) => user?.groups)` compiles with no cast and no `api.me()` endpoint. `AuthUserOf<typeof authApi>` names the type.
- **`@aws-blocks/auth-common`.** `AuthStateApi` and `AuthState` now take these as optional type parameters (`AuthStateApi<I, U>`, `AuthState<U>`), defaulting to `AuthActionInput` and `AuthUser`, so code that names them, and helpers such as `Authenticator(api)`, accept every narrowed API unchanged; `AuthStateUser` is an `AuthUser`. A custom renderer that builds a wide `AuthActionInput` from runtime `action.fields` takes the API as a plain `AuthStateApi`, as `Authenticator` does. `submitAuthAction`, `subscribeAuthState`, `getAuthStateSnapshot`, `onAuthChange` and `AuthenticatedContent` are now generic over the API you pass (`submitAuthAction<A extends AuthStateApi<never>>(api: A, input: Parameters<A['setAuthState']>[0])`), and type-check on TypeScript 5.0 and later.
- **Federated sign-in** is not a `setAuthState` action: it is a browser redirect, the `signIn:<id>` action's `url`. `FederatedActionNameOf<O>` types those names.
- **Native clients.** The narrowing is TypeScript-only. The OpenRPC spec describes `setAuthState`'s input and `AuthState` in their wide form, so differently configured blocks generate the same native types; the server enforces each block's configuration.

New types: `AuthActionInputOf<O>`, `AuthStateApiOf<O>`, `AuthStateUser<O>`, `ConfirmSignInInputOf<O>`, `FederatedActionNameOf<O>` and `AuthUserOf<A>`.
