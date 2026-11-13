# @aws-blocks/auth-common

## 0.4.0

### Minor Changes

- 5f55dac: Add `AuthErrors`, the shared vocabulary of auth error names, with the `AuthErrorName` type and the `isAuthError()` / `isAuthErrorName()` guards. Match an auth failure by name with `isAuthError(e, AuthErrors.NotAuthenticated)` — it works the same on the server and in the browser, and an unknown or misspelled name is a compile error. `Auth` throws these names, as `AuthCognito` and `AuthOIDC` did. A sign-in provider that cannot sign anyone in (a configuration that is unusable at runtime, an unreachable provider, or a Cognito-federated provider under `npm run dev`) fails with `ProviderUnavailableException` (`AuthErrors.ProviderUnavailable`); the name reaches native clients as is.

  The `BlocksAuth` `requireAuth` documentation now states the 401 error name correctly: `NotAuthenticatedException` (the removed `AuthBasic` threw `SessionExpiredException`).

- 5f55dac: **Breaking: `AuthBasic`, `AuthCognito` and `AuthOIDC` are removed. Use `Auth`.** The `@aws-blocks/bb-auth-basic`, `@aws-blocks/bb-auth-cognito` and `@aws-blocks/bb-auth-oidc` packages are no longer part of AWS Blocks and receive no further releases. `Auth` (`@aws-blocks/bb-auth`, also exported from `@aws-blocks/blocks`) replaces all three.

  `@aws-blocks/blocks` no longer exports `AuthBasic`, `AuthBasicErrors`, `AuthCognito`, `AuthCognitoErrors`, `AuthOIDC`, `AuthOIDCErrors`, `cognitoFederated`, `customOidc`, `google`, or the types `AuthBasicOptions`, `AuthBasicUser`, `AuthCognitoOptions`, `AuthFlowType`, `CognitoUser`, `MFAPreference`, `AuthOIDCErrorName` and `OIDCUser`. `getSdkIdentifiers()` no longer has overloads for `AuthCognito` and `AuthOIDC`; `getSdkIdentifiers(auth)` returns `{ userPoolId, clientId, region, hostedUiDomain, hostedUiClientId }`, every field optional: an `Auth` without a user pool (a `store: 'builtin'` block) registers none of them, and `hostedUiDomain` / `hostedUiClientId` are set only when a provider federates through Cognito.

  **How to migrate.** From your app's root, run the codemod, then follow `MIGRATION.md` in `@aws-blocks/bb-auth`:

  ```bash
  npx @aws-blocks/bb-auth migrate --dry-run   # preview the changes
  npx @aws-blocks/bb-auth migrate             # rewrite the files
  ```

  It rewrites imports, class names, options, renamed methods and error names, never changes a block's id, and leaves a `TODO(aws-blocks-auth-migrate)` comment wherever you have to decide something. Keep every block's id exactly as it is: the id names the deployed resources, and changing it replaces the user pool and deletes its users.

  - **`AuthCognito`:** switching to `Auth` with the same id keeps your user pool, its users and their signed-in sessions.
  - **`AuthOIDC`:** directly federated providers keep working and users keep their `userId`, but everyone signs in once more. A `cognitoFederated()` provider's user pool is replaced, so those users get a new `userId`; `MIGRATION.md` shows how to re-key their data.
  - **`AuthBasic`:** there is no upgrade path for its users. Amazon Cognito can't import its password hashes, so every user signs up again. An existing `AuthBasic` session cookie is signed out and cleared on the next request, never an error.

  **`BlocksAuth.requireRole(context, role)` is now required** (`@aws-blocks/auth-common`). It was optional only because `AuthBasic` and `AuthOIDC` had no roles. If you implement `BlocksAuth` yourself, add `requireRole`: throw 401 `NotAuthenticatedException` when there is no session and 403 `NotAuthorizedException` when the user isn't in `role`.

  Telemetry: `@aws-blocks/core` no longer counts `AuthBasic`, `AuthCognito` and `AuthOidc` as official Building Blocks; `Auth` is.

- 5f55dac: feat(bb-auth): show local social and SAML sign-in as unavailable

  In `npm run dev`, Cognito managed login does not exist, so the providers of a block on the default (Cognito) store — social, SAML and `type: 'oidc'` — cannot sign anyone in. `getAuthState()` marks their `signIn:<id>` actions with a new optional `AuthAction.unavailable` reason — for example "Google sign-in works after deploy (npm run sandbox), or use stubIdp() in a store: 'builtin' block locally." — and the `Authenticator` renders those buttons disabled, with the reason as a hint. A browser that navigates to the sign-in route anyway gets an explanatory HTML page instead of raw JSON, unless the URL asks for `?format=json`, as the sign-out route already allows. API clients get a `501` JSON error named `ProviderUnavailableException`, whose message says the configuration is fine and the provider works after deploy.

- 1c7e0dd: `@aws-blocks/auth-common/cookies` adds `isLocalDevRequest(ctx)`, the per-request `isLocalhost` input for the session-cookie security policy. It is `true` only when the process itself is local, as reported by `getDeploymentType()` from deploy configuration, and the request comes from a loopback origin. On deployed compute it is always `false`, so a request that sends `Origin: http://localhost` cannot drop `Secure` (or, with `crossDomain: true`, `Partitioned`) from the cookie. `isLoopbackRequest(ctx)` stays exported and unchanged.
- 5f55dac: `Auth` refreshes a session consistently when requests overlap, and reports a sign-out that could not invalidate the server-side session.

  - **Session refresh.** Several requests can refresh one session at once (parallel calls when its access token expires, possibly on different Lambda instances), and `signOut()` can delete it mid-refresh. Both refresh writes are now conditional on the session row the request read. A refresh that completes after `signOut()` no longer restores the session: nothing is written and the cookie is cleared. A request whose own refresh is rejected, or whose write loses to a concurrent refresh, is served the session that refresh wrote, instead of deleting or overwriting it.
  - **Sign-out.** `signOut()` clears the session cookie first, so the device is signed out whatever happens next. If the session row can't then be deleted (a transient session-store failure), or the session secret can't be resolved to identify it, it reports the new `AuthErrors.SignOutIncomplete` (`SignOutIncompleteException`, 503) instead of success, because a copy of the cookie keeps authenticating until the session ends on its own: `auth.signOut(ctx)` rejects with it, `setAuthState({ action: 'signOut' })` returns a signed-out state with `errorName: 'SignOutIncompleteException'`, and `POST /aws-blocks/auth/signout` answers `503 { error, name }` to an API client (a browser form still lands on `postSignOutPath`). The browser redirect client's `signOut()` rejects with that `ApiError`. A failed session read no longer stops the delete; it only skips `onSignOut` and the upstream sign-out. The store error is logged server-side, never sent.
  - `@aws-blocks/auth-common` adds `SignOutIncomplete` to `AuthErrors`.

- 5f55dac: A signed-in user can enrol an authenticator app (TOTP) through `auth.createApi()`, with no backend code: `setAuthState` takes `setUpTotp`, `verifyTotpSetup`, `getMfaPreference` and `updateMfaPreference` actions. `setUpTotp` returns a state whose `verifyTotpSetup` action carries the shared secret (`sharedSecret`) and an `otpauth://` URI (`otpauthUri`, the QR code's content) as hidden fields; the other actions return the user's MFA settings, one `updateMfaPreference` action per change they can make. A wrong code is `retriable`; a caller who is not signed in gets the `NotAuthenticatedException` state. Replacing an enrolled authenticator and setting a factor `'DISABLED'` need a recent sign-in (`session.freshAgeSeconds`); a stale session gets the `ReauthenticationRequiredException` state, so a stolen session cookie cannot swap the authenticator or turn MFA off. The actions follow the block's options, in the frontend too: `setUpTotp` / `verifyTotpSetup` need `mfa` on with `'TOTP'` in `mfa.types` (`TotpEnabled<O>`), the preference actions need `mfa` on and take only the factors in `mfa.types`; untyped callers get `MfaNotEnabledException` or `InvalidParameterException`. The new `mfa.totpIssuer` option sets the issuer authenticator apps show (default: the root `Scope` id).

  `MfaSettings(authApi, options?)` (from `@aws-blocks/blocks/ui`, `@aws-blocks/bb-auth/ui` or `@aws-blocks/auth-common/ui`) is the enrolment panel for an account page: the setup key, an `otpauth://` link and, with `renderQrCode`, a QR code from the library of your choice, then the code form and the preference buttons, each a `<form>` with stable `mfa-settings-*` test hooks. It leaves the shared auth-state store alone, so a mounted `Authenticator` is unaffected; the `Authenticator`'s signed-in card does not change.

  Native clients: the `setAuthState` input union gains the four actions (additive). Code that matches exhaustively over that input needs the new cases: an exhaustive Swift `switch` over the `Input` enum, a Kotlin `when` over the sealed input class used as an expression, and a Dart `switch` over the sealed input class.

  Dev-server logs redact `otpauth` fields (`otpauthUri` embeds the TOTP secret).

- 5f55dac: feat(auth-common): `subscribeAuthState`, `getAuthStateSnapshot` and a shared auth-state store behind `submitAuthAction`; sign-in/out reaches every component and tab exactly once

  Custom sign-in forms now stay in sync with the rest of the page. Calling `authApi.setAuthState(...)` directly changes the session but notifies nothing on the client, so `onAuthChange`, `AuthenticatedContent` and `AccountMenuBar` kept showing the old state until a reload — most visibly after a custom sign-out.

  - `submitAuthAction(authApi, input)` (new in this release, see its own entry) now also writes the shared store and notifies everything that renders auth: a sign-in or sign-out reaches every `onAuthChange` subscriber in this tab and in other tabs, exactly once. It resolves to the same `AuthState` `setAuthState` returns; a `retriable` result (wrong password, bad code) changes nothing, so you can keep the current form and show the error. Outside a browser it is just the RPC. Use it for sign-in and sign-out alike.
  - `subscribeAuthState(authApi, listener)` and `getAuthStateSnapshot(authApi)` expose the shared auth state as a store, including mid-flow steps such as a confirm-code challenge, ready for React's `useSyncExternalStore`:

    ```ts
    useSyncExternalStore(
      (cb) => subscribeAuthState(authApi, cb),
      () => getAuthStateSnapshot(authApi),
      () => null,
    );
    ```

  - The `Authenticator` and `AccountMenuBar` now submit through `submitAuthAction`. Mid-flow challenge steps no longer broadcast a spurious signed-out `null` to `onAuthChange` subscribers, and a sign-in or sign-out in another tab triggers one `getAuthState()` refetch however many `Authenticator`s are mounted. A failed automatic sign-in after sign-up confirmation now shows its error instead of leaving the Continue step on screen, and two mounted `Authenticator`s no longer both redeem it.
  - `AccountMenuBar`'s Sign Out follows a `signOut` action that carries a `url` (a federated session that must also end at the identity provider) as a form submit, as the `Authenticator` already does.

  `subscribeAuthState` and `getAuthStateSnapshot` are exported, alongside `submitAuthAction`, from `@aws-blocks/blocks/ui` and `@aws-blocks/auth-common/ui`. `data-testid` hooks and action and field names are unchanged.

  The cross-tab broadcast gains one optional field, so two auth APIs on a page no longer wake each other's subscribers. `broadcastAuthChange(user, api?)` takes an optional second argument; with it, the message carries `api` (the RPC namespace of that API) and only that API's `onAuthChange` subscribers receive it. A message without `api`, from an older bundle or a call without the argument, still reaches every API, and older readers ignore the extra field. `submitAuthAction` tags its broadcasts this way when the API client reports its namespace, which the `@aws-blocks/core` API clients of this release do. `AuthStateApi` and `AuthState` also take optional type parameters (`AuthStateApi<I, U>`, `AuthState<U>`, defaulting to today's types, so existing code compiles unchanged), with `AuthUserOf<A>` naming an API's user type, and `AuthUser` has an optional `displayName`; their own entries describe them. The custom-UI guide (`CUSTOMIZING-AUTH-UI.md`) now ships with `@aws-blocks/bb-auth` instead of `@aws-blocks/auth-common`.

### Patch Changes

- 5f55dac: The `Authenticator` renders each action as a `<form>`, so browsers and password managers see the username and password fields together (Chrome no longer warns that the password inputs are not in a form). Enter in any field or a click on the button submits it once, and it never reloads the page; native validation is off, so the server's error is the one shown. Inputs carry `autocomplete` hints by default: `username`, `current-password` (`new-password` on sign-up and for a new password), `one-time-code` for codes, `email` for an email field and `tel` for `phone_number`. A field override's `autocomplete` still wins. Because each action is a form, a `<button>` without a `type` inside a field's `render` override now submits the action (the HTML default, `type="submit"`); give a button that should not submit `type="button"`. The `data-testid` hooks are unchanged; `authenticator-action-<action>` is now the `<form>` element.
- 5f55dac: The cookie helpers' documentation now names `bb-auth` as their caller and refers to `bb-auth-basic`, `bb-auth-cognito` and `bb-auth-oidc` as the removed blocks they replaced.
- 5f55dac: Auth broadcasts are tagged per API, so `onAuthChange` for one API no longer receives another API's user. With two auth blocks on one page, signing in to one no longer hands its user to the other's listener (typed as the other's user), in this window or in another tab, and the other block's store no longer refetches.

  `submitAuthAction` tags its sign-in and sign-out messages with the RPC namespace of the API it ran on (a generated client now answers `Symbol.for('aws-blocks.apiNamespace')` with it), and `broadcastAuthChange(user, api)` takes an optional `api` to do the same. An untagged message still reaches every API's listeners: `broadcastAuthChange(user)` without an `api`, and a message from a tab running an older `@aws-blocks/auth-common`. An API that is not a generated client (a hand-written `AuthStateApi`) has no namespace: `submitAuthAction` on it sends untagged broadcasts, and its listeners and store receive every message, tagged or untagged. The message format (the `blocks-auth` channel and the `blocks-auth-change` window event, `{ type: 'auth-change', user }`) only gains the optional `api` field, so tabs running an older bundle keep working.

- 5f55dac: Docs: the `AuthFieldOverride` reference documentation no longer names `bb-auth-supabase`, a package AWS Blocks does not ship.
- 5f55dac: The client auth-state store (`subscribeAuthState`, `getAuthStateSnapshot`, the `Authenticator`) and `onAuthChange` now end at the session's real state when requests overlap: another tab's broadcast, a hydration still in flight, answers that arrive out of order, and failed requests.

  - Answers are ordered by the session cookie they reflect: a `getAuthState()` counts from when it was sent, a sign-in or sign-out result from when it arrived. A cross-tab refetch that answers late no longer replaces a newer sign-in or sign-out in this tab.
  - A challenge step, a failed sign-in or a resend stays on screen over a signed-out session, so another tab's sign-out no longer cancels this tab's MFA step. It is dropped once the session is seen signed in after it was sent, so a resend that races another tab's sign-in ends signed in instead of on the code form.
  - When the answers conflict, the store re-reads the session with one extra `getAuthState()` and keeps showing what it showed until that answer lands: an MFA step while it still shows a user whose session may have timed out (the step is shown once the read confirms the session ended), and a sign-in or sign-out that another request was sent during. If that re-read fails, the store keeps showing what it showed until the next broadcast, submit or reload: the signed-in state after a session timeout, or an MFA step this tab holds after another tab signed in.
  - `onAuthChange` follows the store, so it ends where `subscribeAuthState` does. It still gets another tab's broadcast at once; the store's refetch then corrects it if the session changed again in between. An answer older than that broadcast never replaces it, so when the refetch fails the broadcast stands (a sign-out stays a sign-out on a network blip). It gets `null` when an MFA step replaces a timed-out session.
  - Each API with an `onAuthChange` subscriber now sends one `getAuthState()` per broadcast from another tab, also on pages with only `AuthenticatedContent` or `AccountMenuBar` (before, only store subscribers and the `Authenticator` did). A broadcast that names the user the tab already shows, while it is in no sign-in step and has no request in flight, is not refetched, so another tab's failed sign-in (which re-broadcasts `null`) or a repeat sign-in of the same user costs no request.
  - When a refetch for another tab's broadcast fails, `onAuthChange` keeps the broadcast: if another tab's late sign-out broadcast arrives after this tab signed in and its refetch fails, `onAuthChange` shows `null` while the store shows the sign-in, until the next broadcast, submit or reload.
  - `submitAuthAction` does not broadcast a `signedIn` / `signedOut` result the store does not show: a failed sign-in sent before the session was seen signed in, or one that arrives under a signed-in state the store is re-reading.
  - A failed request still never empties the store or masks an answer still in flight: a hydration lands even when a cross-tab refetch fails.

  No public API or wire-format changes.

- 5f55dac: `auth.createApi()` is typed by the block's options, so the frontend gets the same gates as the server-side methods, and the signed-in user with its own groups and attributes.

  - **Actions.** `setAuthState` takes `AuthActionInputOf<O>`: the password actions (`signIn`, `signUp`, `confirmSignUp`, `resendSignUpCode`, `autoSignIn`, `resetPassword`, `confirmResetPassword`, `confirmSignIn`) need email + password, the passkey actions need `passkeys`, and `confirmSignIn` takes only the challenges the configuration can produce: the MFA challenges follow `mfa.types` (and `mfaType` is one of them), and the first-factor ones need `users.authFlow: 'USER_AUTH'`. On an `emailPassword: false` block, `authApi.setAuthState({ action: 'signIn', username, password })` and `submitAuthAction(authApi, { action: 'signIn', … })` are compile errors. A setting the compiler cannot see (the wide `Auth` type, a `boolean`-typed option, a union `authFlow`, a wrapped pool, `mfa.types` typed `MfaFactor[]`) keeps its actions.
  - **User.** `AuthState.user` is `AuthStateUser<O>`: the signed-in `AuthenticatedUser` (`groups` typed by `users.groups`, `attributes`, `userSub`, `signInProvider`) without the server-only `claims` and `federatedIdentity`. `onAuthChange`, `AuthenticatedContent`, `subscribeAuthState`, `getAuthStateSnapshot` and `submitAuthAction` pass it on, so `onAuthChange(authApi, (user) => user?.groups)` compiles with no cast and no `api.me()` endpoint. `AuthUserOf<typeof authApi>` names the type.
  - **`@aws-blocks/auth-common`.** `AuthStateApi` and `AuthState` now take these as optional type parameters (`AuthStateApi<I, U>`, `AuthState<U>`), defaulting to `AuthActionInput` and `AuthUser`, so code that names them, and helpers such as `Authenticator(api)`, accept every narrowed API unchanged; `AuthStateUser` is an `AuthUser`. A custom renderer that builds a wide `AuthActionInput` from runtime `action.fields` takes the API as a plain `AuthStateApi`, as `Authenticator` does. `submitAuthAction`, `subscribeAuthState`, `getAuthStateSnapshot`, `onAuthChange` and `AuthenticatedContent` are now generic over the API you pass (`submitAuthAction<A extends AuthStateApi<never>>(api: A, input: Parameters<A['setAuthState']>[0])`), and type-check on TypeScript 5.0 and later.
  - **Federated sign-in** is not a `setAuthState` action: it is a browser redirect, the `signIn:<id>` action's `url`. `FederatedActionNameOf<O>` types those names.
  - **Native clients.** The narrowing is TypeScript-only. The OpenRPC spec describes `setAuthState`'s input and `AuthState` in their wide form, so differently configured blocks generate the same native types; the server enforces each block's configuration.

  New types: `AuthActionInputOf<O>`, `AuthStateApiOf<O>`, `AuthStateUser<O>`, `ConfirmSignInInputOf<O>`, `FederatedActionNameOf<O>` and `AuthUserOf<A>`.

- 5f55dac: `Auth` names the option that is off when an untyped caller (plain JavaScript, or a native client generated from the wide spec) sends an action the block does not offer, before the session check or any Cognito call. A passkey action (`signInWithPasskey`, `startPasskeyRegistration`, `completePasskeyRegistration`, `listPasskeys`, `deletePasskey`) or a `confirmSignIn` `webauthn` challenge on a block without `passkeys` answers `PasskeysNotEnabledException` (409). A `confirmSignIn` MFA challenge (`code`, `mfaType`, `totpSetup`, `email`) with MFA off answers `MfaNotEnabledException` (409). A factor outside `mfa.types`, or a `password` / `firstFactor` challenge without `users.authFlow: 'USER_AUTH'`, answers `InvalidParameterException` naming the option. A block that wraps a pool with `userPool: Auth.fromExisting(…)` keeps every challenge.

  The runtime backstops of the MFA methods (`setUpTotp`, `verifyTotpSetup`, `updateMfaPreference`, `getMfaPreference`) throw `MfaNotEnabledException` with MFA off, and those of the passkey methods throw `PasskeysNotEnabledException` without `passkeys`. `WebAuthnNotEnabledException` is Cognito's answer for a user pool without a WebAuthn configuration.

  `@aws-blocks/auth-common`'s `AuthErrors` gains `PasskeysNotEnabled` and `MfaNotEnabled`.

- 5f55dac: The sign-in UI now shows a signed-in user's email address instead of a generated id. When users sign in with their email or phone number (`users: { signInWith: ['email'] }`), Amazon Cognito gives each user a generated username (a UUID), and the `Authenticator` and `AccountMenuBar` showed that UUID ("Signed in as: 815424a9-…").

  `AuthState.user` now has an optional `displayName`, which `Auth` sets in the signed-in state:

  - a username the user chose stays as it is;
  - otherwise it is the user's email address, then their phone number (each skipped if the session's ID token marks it unverified, as it does for an email the user changed with `updateUserAttributes` and hasn't confirmed yet), then `preferred_username`, then the username.

  The `Authenticator` and `AccountMenuBar` show `displayName`, and fall back to `username` when it is absent. `displayName` is for display only, so keep keying data on `userId` / `userSub`. Only the signed-in caller's own state carries it, never a signed-out or mid-sign-in state. Users returned by `requireAuth()` and `getCurrentUser()` don't have it; read `user.attributes.email` on the server instead.

  The `auth` template's status line now shows `displayName` directly.

- 5f55dac: feat(bb-auth): `Auth` options: a block-level `store` and one `providers` map

  `Auth` options start with where your users live. A block-level `store` picks it, and every sign-in provider goes in one `providers` map, keyed by provider id and tagged with its `type`:

  ```ts
  // The default store (omit `store`): users live in a Cognito user pool.
  const auth = new Auth(scope, "auth", {
    providers: {
      google: {
        type: "google",
        clientId: "your-google-client-id",
        clientSecret: googleSecret,
      },
      entra: {
        type: "oidc",
        issuer: "https://login.microsoftonline.com/<tenant>/v2.0",
        clientId: "entra-client-id",
        clientSecret: entraSecret,
      },
      corp: {
        type: "saml",
        metadataUrl: "https://idp.example.com/saml/metadata",
      },
    },
  });

  // store: 'builtin': no user pool; your backend verifies each provider itself.
  const sso = new Auth(scope, "sso", {
    store: "builtin",
    providers: {
      okta: {
        type: "oidc",
        issuer: "https://dev-12345.okta.com",
        clientId: "0oa-your-client-id",
      },
      github: github({ clientId: "Iv1.abc", clientSecret: githubSecret }),
    },
    // Both blocks have providers, so this one gets its own sign-in routes.
    redirects: {
      callbackPath: "/aws-blocks/auth/sso/callback",
      signOutPath: "/aws-blocks/auth/sso/signout",
    },
  });
  ```

  - **`store: 'cognito'`** (the default, so `new Auth(scope, 'auth')` needs no options): email + password, `mfa`, `passkeys`, `admin`, `userPool`, `email`, and `providers` of `type: 'google' | 'facebook' | 'amazon' | 'apple' | 'saml' | 'oidc'`. A `type: 'oidc'` entry federates through Cognito and requires `clientSecret`. A social entry is keyed by its type (`google: { type: 'google', … }`).
  - **`store: 'builtin'`**: no user pool. Users live at their identity provider, and the block keeps only its session table. `providers` of `type: 'oidc'` (`clientSecret` optional, so public PKCE-only clients work), `github()` / `customOauth2()` (`type: 'oauth2'`) and `stubIdp()` (`type: 'stub'`). `users` takes only `groups`, `allowBearerAuth: true` accepts the provider's access token, and `validateUser` runs at sign-in only. `emailPassword` (other than `false`), `mfa`, `passkeys`, `admin`, `userPool` and `codeDelivery` don't apply, and the signed-in user's `signInProvider` is one of the block's provider ids (never `'password'`).
  - **One block holds one kind of user.** A block cannot mix email + password users with backend-verified OIDC users. Use two `Auth` blocks, each with its own session cookie and `createApi()`, and let the frontend pick one per sign-in. When both have `providers`, give the second its own `redirects.callbackPath` / `signOutPath`, as `sso` above does.
  - **Checked at compile time, and again at runtime.** A wrong combination is a compile error. Most name the fix in their type, such as `ERROR_needs_store_cognito<'emailPassword'>` under `store: 'builtin'`. `stubIdp()`, `github()` or `customOauth2()` on the default store is a compile error too (`'"stub"' is not assignable to '"oidc"'`): add `store: 'builtin'`. The constructor rejects the same combinations with a readable message in `npm run dev`, at synth and in Lambda. It also rejects what the compiler can't see, such as options built from JSON, a `providers` value that isn't an object of provider entries, or a social entry keyed differently from its type. A default-store block with `emailPassword: false` and no provider fails in `npm run dev`, at synth and in Lambda.
  - **Editor help on a `'builtin'` block.** The options it refuses (`mfa`, `admin`, `userPool`, `users.signInWith`, …) are marked `@deprecated`, so completions list them last and struck through; `emailPassword` stays unmarked, since `false` is allowed. `allowBearerAuth: { clientIds }` there names the fix (`ERROR_needs_store_cognito<'allowBearerAuth (object form)'>`). A `providers` map picked per environment (`isProd ? { okta: … } : { local: stubIdp() }`) keeps both provider ids narrow for `getSignInUrl()` and `requireRole()`.
  - **Checked at synth.** On both stores, synth checks `redirects` (`callbackPath` / `signOutPath` must be explicit paths under `/aws-blocks/auth/`, not the bare prefix) and `postSignInPath` / `postSignOutPath`, and rejects a provider id containing `/`. Two blocks of one backend that would mount the same sign-in or sign-out routes (both with `providers` on the default `redirects`), or two `stubIdp()` providers under the same key, fail synth naming both blocks, and at runtime the stub case names the fix rather than a bare `DuplicateRouteException`. A plain string as a `'builtin'` provider's `clientSecret` is refused at construction. On the default store, a `type: 'oidc'` entry with an empty or falsy `clientSecret` (`''`, `0`, `false`), or an `attributesRequestMethod` other than `'GET'` / `'POST'`, is refused at construction in `npm run dev`, at synth and in Lambda.
  - **Docs and messages.** `allowBearerAuth` and `validateUser` say that a bearer token is verified per request and does not run `validateUser`, so gate per request when you rely on it. An option error never echoes a string value longer than 8 characters, including a `store` or a provider `type` (a misplaced token prints as `a string (40 characters)`). A provider whose id names an `Object.prototype` member (such as `constructor`) gets the default label "Sign in with Constructor".
  - **`bb-auth migrate`** rewrites `AuthBasic`, `AuthCognito` and `AuthOIDC` blocks to this shape. A block constructed from a class the app re-exports through its own module (`export { AuthBasic } from '@aws-blocks/bb-auth-basic'`, `export *` of an old package) gets the same option mapping, kept defaults and TODOs as a direct import. `AuthBasic` blocks keep their password policy: each character class it left unset is written as `false` (`Auth` requires all four by default). A local `export { AuthCognitoErrors }` of a renamed import becomes `export { AuthErrors as AuthCognitoErrors }`. An `AuthOIDC` `providers` array with a spread is kept as is, with a TODO. Each moved `stubIdp()` gets a TODO that `Auth` refuses it on a production deployment, and `stubIdp({ name: 'dev' })` becomes `stubIdp()`. A provider factory called outside the block, a `require()` of an old package, and an `AuthBasicUser` import in a project that never reads `createdAt` get accurate TODOs (none, for the last). `migrate <path>` with a path that doesn't exist exits 2.
  - **Stable identifiers.** Construct ids, user-id formats (`userId` / `userSub` for pool users, `` `${issuer}:${sub}` `` for `'builtin'` users), the session format, and the client-side provider ids and routes (`getSignInUrl(context, '<id>')`, `signIn:<id>`) depend on the provider keys and block ids, not on how the options are written. An `AuthCognito` app keeps its construct ids, so nothing deployed is replaced.

  Also updated: the umbrella README's sign-in method guide (`@aws-blocks/blocks`), the `Auth` snippet and RLS notes in the generated `MIGRATION_GUIDE.md` from `db pull` (`@aws-blocks/bb-data`), the `Secret` README's provider-secret note (`@aws-blocks/bb-secret`), the scaffolded `AGENTS.md` (`@aws-blocks/create-blocks-app`), and the `AuthAction.unavailable` example (`@aws-blocks/auth-common`), whose hint reads "…or use stubIdp() in a store: 'builtin' block locally."

- 5f55dac: Fixes made to `AuthCognito`, `AuthOIDC` and `AuthBasic` since their last release (`bb-auth-cognito` 0.2.0, `bb-auth-oidc` 0.3.0, `bb-auth-basic` 0.2.0) ship in `Auth`, which replaces them in this release. If you upgrade an `AuthCognito`, `AuthOIDC` or `AuthBasic` app to `Auth`, this is what changes for you compared with those versions.

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

  **Released in those versions (#840, #903, #887)**

  - `AuthBasic` gained server-side revocation of a signed-out session token (#840) and an opt-in per-username sign-in lockout (#903). Neither ships in `Auth`, which replaces `AuthBasic`: `Auth`'s `signOut()` deletes the session row, so a replayed cookie is already rejected, and Cognito applies its own sign-in throttling to repeated failed password attempts.
  - `AuthOIDC`'s signed state and session cookies use Node's built-in `base64url` (#887). `Auth` already encodes its state envelope and cookies that way, so nothing changes for you.

  **Released in those versions (#949, #827, #510, #1032, #1042, browser error constants)**

  - `AuthBasic` capped failed guesses against one verification code at 5 (#949). `Auth`'s sign-up and password-reset codes are Amazon Cognito's, which limits repeated failed code attempts itself; the local mock does not cap them.
  - `AuthOIDC`'s `cdk` and `aws-runtime` entries gained the `OIDCClient` type (#827). `Auth` has no `OIDCClient` (federated sign-in buttons come from `getAuthState()`), and every `Auth` entry exports the same types.
  - `AuthBasic`'s same-origin session cookie dropped `Secure` behind a plain-HTTP front door such as a TLS-less ALB (#510). So does `Auth`, which reads the front door's scheme from `BLOCKS_PUBLIC_ORIGIN`, never from a request header.
  - `AuthBasic` and `AuthCognito`'s browser stubs no longer imported `ApiNamespace`, so their error constants could be imported in frontend code. `Auth`'s browser entry never imported it: `import { AuthErrors } from '@aws-blocks/bb-auth'` bundles for the browser.
  - `AuthOIDC`'s mock cookie secret became random per project (#1032). `Auth`'s local session secret already was. `Auth`'s mock entry also fails closed on deployed compute, like every Building Block's.
  - `AuthOIDC` limited `stubIdp()` to local development and sandbox deployments (#1042). So does `Auth` (see the `stubIdp()` changeset).

  **Released in those versions (#1050)**

  - `AuthOIDC`'s `cognitoFederated()` app client registered only an `https://localhost` placeholder callback URL, so Cognito answered `redirect_mismatch` for a deployed app (#1050 fixed it and added `additionalCallbackUrls` / `additionalLogoutUrls`). `Auth`'s hosted-UI app client registers the backend's API URL and the public origin `Hosting` registers as its callback and sign-out URLs, so a deployed `Auth` app signs in through Cognito. `Auth` has no `additionalCallbackUrls` / `additionalLogoutUrls` options.

  **Released in those versions (#1120)**

  - `AuthBasic`'s browser entry gained the `AuthActionInput` type, which its server entry and README already had (#1120). `Auth` does not re-export `@aws-blocks/auth-common`'s types from any entry: import `AuthActionInput` from `@aws-blocks/blocks` (the migrate codemod says so). Every `Auth` entry, the browser one included, exports the same types, including the options-narrowed `AuthActionInputOf<O>`.

  **From `main` after those releases (#1085, #1253, #1257, #1296, #1288, #1203)**

  - `AuthBasic` invalidates every outstanding session when a user resets their password (#1085). So does `Auth`, which replaces `AuthBasic`: a completed `confirmResetPassword` signs the user out everywhere, locally and on AWS (see the `bb-auth` changeset on password resets).

  - `AuthBasic` reads its session cookie by exact name (#1253): a cookie whose name only ends with the session cookie's name can no longer supply or shadow it, and the scope id is matched literally. `Auth` already reads every cookie this way (anchored to a cookie boundary, name regex-escaped).

  - `AuthBasic` and `AuthCognito` no longer let a request header decide whether the session cookie is `Secure` (#1257): on a deployed stack, a request that sent `Origin: http://localhost` got a cookie without `Secure` (and, with `crossDomain: true`, without `Partitioned`). `Auth` decides it the same way, from deploy configuration, for every cookie it sets (see the `bb-auth` changeset on the `Secure` cookie flag).

  - `AuthBasic` can emit sign-in metrics you can alarm on (#1296): with a `Metrics` instance as its `metrics` option, every `signIn` emits a `SignInSuccess`, `SignInFailure` or `SignInLocked` count with an `AuthBlock` dimension. This is not yet in `Auth`, which replaces `AuthBasic`: `Auth` has no `metrics` option, and emits no sign-in metrics. `Auth`'s sign-in can take more than one step (an MFA or passkey challenge, `autoSignIn`, a federated callback), and lockout is Amazon Cognito's rather than the block's, so what each metric counts is still to be decided.

  - `AuthCognito`'s `DESIGN.md` gave its session cookie as `SameSite=None; Partitioned` (#1288); it is `SameSite=Lax` by default, and `SameSite=None; Partitioned` only with `crossDomain: true`. `Auth`'s `DESIGN.md` already describes its cookie that way (D-007), with the opt-in at `session: { crossDomain: true }`.

  - `AuthOIDC`'s docs name the `cdk-blocks secret` CLI (#1203) when they say it does not manage the SSM SecureString behind a `secret: true` `AppSetting`. `Auth`'s README already says how to set each kind of provider secret: `npm run secret` (an alias of `cdk-blocks secret`) for a `Secret`, and `aws ssm put-parameter` for an `AppSetting`.

  **From `main` after those releases (#1314, #1312, #1337, #1362, #885, #1401, #1414)**

  - `AuthCognito` makes its session refresh writes conditional on the record each request read (#1314). So does `Auth` (see the `bb-auth` changeset on session refresh): a refresh that finishes after sign-out no longer restores the session, and overlapping refreshes no longer delete or overwrite each other. `Auth` already kept a session through a transient refresh failure (throttling, a Cognito 5xx, a network error) and ended it only when Cognito rejected the refresh token or the user.

  - `AuthOIDC` reports `SignOutIncompleteException` (503) when sign-out cannot delete the session row (#1312). So does `Auth`, for every session it issues: `AuthErrors.SignOutIncomplete`, on `signOut()`, on `setAuthState({ action: 'signOut' })` and on the sign-out route (see the `bb-auth` changeset on sign-out).

  - `AuthBasic`'s docs now describe local development correctly (#1337): its users, codes and secret live in `.bb-data/` and survive a dev server restart. `Auth`'s README already says its local user pool lives in `.bb-data/<fullId>/state.json`, so its users survive a restart.

  - `AuthBasic`'s lockout window test was stabilized (#1362). `Auth` has no per-username lockout (Amazon Cognito throttles repeated failed sign-ins itself), so there is no such test.

  - `AuthBasic`, `AuthCognito` and `AuthOIDC` stopped sending the raw text of an unexpected error to the client (#885). `Auth` already reported such an error as `InternalErrorException` with a fixed message (and withholds an `ApiError` message that names AWS resources), in `setAuthState()`, the RPC methods and the sign-in routes, including an error thrown by a `codeDelivery` or `onSignIn` hook; an `ApiError` thrown by a hook keeps its status, name and message.

  - `defaults.permissionsBoundary` coverage gained a synth test for `AuthOIDC` (#1401). `Auth` has the same test, on both stores: every IAM role a `store: 'builtin'` block or a Cognito-store block with a federated provider creates carries the boundary and is listed in the stack's IAM report.

  - `AuthOIDC` loads its stub IdP engine only in sandbox deployments (#1414). `Auth` already did: its AWS entry imports the stub engine dynamically, only for a `stubIdp()` provider on a sandbox deployment, and serves no stub routes on any other deployment; a new test checks that the AWS entry has no static import path to the engine. `Auth` has no `getClient()`, so the rest of that change does not apply.

  **Docs (from `AuthOIDC`)**

  - Federating a provider through Cognito does not add MFA, adaptive authentication or brute-force protection to its sign-in: for federated users, Amazon Cognito delegates authentication to the identity provider and offers no extra authentication factors, device tracking or threat protection. The `Auth` README says so and tells you to enforce MFA at the IdP (for example Google 2-Step Verification, or your Okta / Microsoft Entra ID MFA policy). `AuthOIDC`'s docs had claimed otherwise.
  - `@aws-blocks/auth-common`: the error-name mapping table in `DESIGN.md` lists the AWS credential and IAM error names that `Auth` (like `AuthCognito`) can report.

  **Internal**

  - The tests that pinned what `AuthCognito` deploys — the CloudFormation identity of its user pool, app client, groups, session table and session secret, its config keys and its session cookie name, plus `AuthOIDC`'s deployed resources — and the offline tests of the Cognito runtime against a stubbed client (sign-in, sign-up, sign-out, refresh, cookie verification, error mapping, live group checks) now run against `Auth`, with `AuthCognito`'s side frozen from its final source. No runtime or infrastructure change.

- 5f55dac: Docs and editor hover text now point at `Auth`, the single authentication Building Block, instead of the removed `AuthBasic`, `AuthCognito` and `AuthOIDC`. The `@aws-blocks/blocks` README adds a "Choosing a sign-in method" table comparing email + password, social, OIDC verified by your backend (`store: 'builtin'`), OIDC through Cognito, and SAML by Cognito free tier, offline support and user-pool features. The `hasAuthError` example in `@aws-blocks/core` now matches `AuthErrors.NotAuthorized`.
- Updated dependencies [5f55dac]
- Updated dependencies [2eb62fa]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [6297d5a]
- Updated dependencies [b2eb306]
- Updated dependencies [a5e754b]
- Updated dependencies [f133ff8]
- Updated dependencies [9ebf67a]
- Updated dependencies [76fd75c]
- Updated dependencies [3ae8592]
- Updated dependencies [e5822ed]
- Updated dependencies [3ae8592]
- Updated dependencies [9059918]
- Updated dependencies [5f55dac]
- Updated dependencies [c1fabce]
- Updated dependencies [b2eb306]
- Updated dependencies [0cf1aa2]
- Updated dependencies [15e65b4]
- Updated dependencies [5f55dac]
- Updated dependencies [c1fabce]
- Updated dependencies [c045273]
- Updated dependencies [369b175]
- Updated dependencies [d7f62f3]
- Updated dependencies [3be61fa]
- Updated dependencies [36888a1]
- Updated dependencies [fcf087d]
- Updated dependencies [2c9005f]
- Updated dependencies [6151940]
- Updated dependencies [b7c262c]
- Updated dependencies [ebfe2ed]
- Updated dependencies [c1fabce]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [44c7377]
- Updated dependencies [2a358ff]
- Updated dependencies [1ec956f]
- Updated dependencies [c1fabce]
- Updated dependencies [072c3ff]
- Updated dependencies [5f55dac]
- Updated dependencies [afad513]
- Updated dependencies [ba80bbd]
- Updated dependencies [05a88e1]
- Updated dependencies [f32185c]
- Updated dependencies [f32185c]
- Updated dependencies [9801a5b]
- Updated dependencies [a86bccb]
- Updated dependencies [b2eb306]
- Updated dependencies [df25d97]
- Updated dependencies [201e59e]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [60360c1]
- Updated dependencies [8ece10a]
- Updated dependencies [c607deb]
- Updated dependencies [4e92168]
- Updated dependencies [bfdd06f]
- Updated dependencies [2095f31]
- Updated dependencies [80ce128]
- Updated dependencies [d354055]
- Updated dependencies [58817b0]
- Updated dependencies [e286b16]
- Updated dependencies [c00ab16]
- Updated dependencies [58980c7]
  - @aws-blocks/core@0.9.0

## 0.3.0

### Minor Changes

- aaa90b6: AuthBasic now revokes the session token server-side on sign-out. Each session
  JWT carries a unique `jti`; `signOut` records that id on a revocation list (in
  the existing codes store, expiring with the token) so a replayed cookie is
  rejected even though the JWT is still unexpired and signature-valid. The
  umbrella `@aws-blocks/blocks` is bumped because the bundled `bb-auth-basic`
  README/DESIGN docs it mirrors have changed.

  This is a `minor` (not `patch`) bump because it adds exported error constants —
  `AuthBasicErrors.SessionRevoked` (`SessionRevokedException`, thrown by
  `requireAuth` for a signed-out/revoked session, vs `SessionExpiredException` for
  an absent/aged-out one) and `AuthBasicErrors.SignOutIncomplete`
  (`SignOutIncompleteException`, 503, thrown when the revocation write fails) —
  and documents a new throwable name on the shared `BlocksAuth.requireAuth`
  contract in `@aws-blocks/auth-common`.

  `signOut` always clears the local cookie (so sign-out on this device never
  leaves the user stuck signed in), even when the server-side revocation write
  fails; in that case it throws a stable `SignOutIncompleteException` rather than
  the raw SDK error, so no `$metadata`/ARNs leak to the client.

  Legacy-surface behavior change: the deprecated `buildApi().signOut` previously
  always resolved to `{ success: true }`; it now awaits `signOut` and so can
  reject with `SignOutIncompleteException` (503) when the revocation write fails.
  Only direct `buildApi` callers are affected — the `createApi()` state machine
  catches it into the `AuthState.error` field.

  Operator note: the `codes` store gains `{ ttl: true }`. For an already-deployed
  AuthBasic app this is an in-place DynamoDB TimeToLive enablement (an `UpdateTable`)
  on the next `cdk deploy` — no data migration, and correctness does not depend on
  the reaper (reads filter expired items regardless). Caveat: DynamoDB rejects
  another `UpdateTimeToLive` on the same table for ~1 hour after a change, so if an
  unrelated resource fails in the same deploy, CloudFormation rollback (which
  disables TTL) — or a deploy → rollback → redeploy within that hour — can land in
  `UPDATE_ROLLBACK_FAILED`. Deploy AuthBasic apps with this in mind.

- dde6340: feat(hosting): swappable front doors, and bring-your-own doors written as one function

  `Hosting` no longer hard-codes CloudFront. The optional `frontDoor` prop picks
  the public entry point. Omit it and nothing changes: you get the same CloudFront
  distribution as before.

  - `'cloudfront'` (default): the global CloudFront CDN.
  - `{ kind: 'alb', vpc?, internal?, certificate? }`: a regional Application Load
    Balancer, with no CDN. Server-rendered responses are buffered. With
    `certificate` and `features.domain` it serves HTTPS (TLS 1.2+) at your domain,
    with a port 80 → 443 redirect and Route 53 alias records.
  - `{ kind: 'apiGateway', api?: 'http' | 'rest', certificate? }`: Amazon API
    Gateway, with no CDN, no VPC, and scale-to-zero. `'http'` (the default)
    buffers server-rendered responses; `'rest'` streams them. `'rest'` needs a
    custom `domain`: its own URL carries the `/prod` stage, which the app's
    root-relative links miss, so synth fails without one
    (`RestFrontDoorNeedsDomainError`).
  - `{ kind: 'stacked', edge: 'cloudfront', router: 'alb', vpc?, internal?, certificate? }`:
    a CloudFront edge in front of a full ALB router. The edge serves the app's
    static routes straight from the private S3 bucket (origin access control);
    the API and the dynamic routes go through the ALB. The ALB admits only the
    edge: every listener rule requires a secret header the edge sends (otherwise
    403), whose value Secrets Manager generates once per stack and both sides
    read through a CloudFormation dynamic reference; its security group admits
    only the CloudFront origin-facing managed prefix list, or, with
    `internal: true`, only the CloudFront VPC origin the edge reaches it through.
    With a router `certificate` and `features.router.domain`, the edge reaches
    the router over HTTPS on port 443; otherwise that hop is plain HTTP, and an
    internet-facing router warns at synth (`StackedRouterPlainHttp`).
  - `'none'`: no front door. A static site or SPA is served straight from an S3
    website bucket over HTTP. An app with a server fails synth.
  - `{ kind: 'custom', door, wiringCheck? }`: your own door.

  Every door serves the API on the app's own origin (except `'none'`, where the
  browser calls the API cross-origin): `/aws-blocks/*` (RPC and sign-in) and each
  of the backend's raw routes. Only a CloudFront-backed door (the default, or
  the stacked door's edge) claims the backend's API front-door role, so
  `apiFrontDoor: 'cloudfront'` builds no second distribution there. Behind the
  ALB, API Gateway or a bring-your-own door, the API keeps the distribution
  `apiFrontDoor: 'cloudfront'` asks for, and `ApiUrl` stays on it for native
  clients. A plain-HTTP door warns at synth (`PlainHttpFrontDoor`). The backend's trusted origin
  (`BLOCKS_PUBLIC_ORIGIN`, where the OIDC callback lands and whose scheme sets
  the session cookie's `Secure`) belongs to the door that serves `/aws-blocks/*`
  to browsers: a managed `cloudfront` API distribution built beside such a door
  doesn't overwrite it. `'none'` publishes none (the bucket serves no
  `/aws-blocks/*`), and its `config.json` names the same API URL as `ApiUrl`.

  Each door kind takes the settings the app asks it for as `features`, typed for
  that kind: a setting the chosen door doesn't implement does not compile.
  `{ features }` with no `kind` is the CloudFront default with settings.

  - CloudFront: `domain`, `waf`, `logging`, `monitoring`, `skewProtection`,
    `geoRestriction`, `priceClass`, `contentSecurityPolicy`, `ssrDefaultTtl`,
    `cacheKeyCookies`, `cacheKeyHeaders`, `responseHeadersPolicy`, `quotas`.
  - ALB: `domain` (without `wwwRedirect`), `waf` (a REGIONAL web ACL), `logging`,
    `monitoring` (`enabled` only). The ALB's own access logs are off unless
    set; its alarms are on unless `monitoring: { enabled: false }`, as on the
    CloudFront door.
  - API Gateway (HTTP and REST): `domain` (without `wwwRedirect`).
  - Stacked: per layer, `edge: { waf: { webAclArn }, contentSecurityPolicy }` (a
    CLOUDFRONT-scoped web ACL) and `router: { domain, waf, logging, monitoring }`
    (a REGIONAL web ACL; the domain is the name the edge connects to).
  - Custom: `domain`, `waf`, `logging`, `monitoring`, `geoRestriction`,
    `skewProtection`, handed to the door as `input.features`.
  - `'none'`: no settings.

  `geoRestriction.type` takes `'allowlist'` or `'denylist'`; the legacy
  `'whitelist'` / `'blacklist'` mean the same, and any other value fails synth.
  `frontDoor` is validated at synth: an unknown door, an option the kind doesn't
  take, a value of the wrong shape, or an unknown key inside a `features` setting
  fails with `UnsupportedFrontDoorError`, `InvalidFrontDoorOptionError` or
  `InvalidFrontDoorSettingError`, naming it.

  **Deprecated (still supported):** the top-level settings props. On `Hosting`
  (`@aws-blocks/core`): `domain`, `waf`, `logging`, `monitoring`,
  `skewProtection`, `contentSecurityPolicy`, `priceClass`, `geoRestriction`,
  `quotas`, `ssrDefaultTtl`, `cacheKeyCookies`, `cacheKeyHeaders`. On
  `HostingConstruct` (`@aws-blocks/hosting`): `domain`, `waf`, `logging`,
  `monitoring`, `skewProtection` and `cdn` (each `cdn.<x>` is
  `frontDoor.features.<x>`; `cdn.webAclArn` is `frontDoor.features.waf.webAclArn`).
  Use `frontDoor.features.<x>` instead: the names are the same, so migrating is a
  straight move. The aliases are merged into `frontDoor.features` at
  construction, and an app that sets them with no `frontDoor` (or `'cloudfront'`)
  synthesizes the same template, with one exception for JavaScript callers of
  `geoRestriction` (TypeScript only accepted `'whitelist'` / `'blacklist'`): any
  type other than `'whitelist'` used to deny the listed countries, so
  `'allowlist'` now allows them as its name says, and a missing or unknown type
  (e.g. `'Whitelist'`) now fails synth instead of denying. Setting a setting both ways fails synth with
  `FrontDoorSettingConflictError`, naming both; a top-level prop the chosen kind
  doesn't implement fails synth with `UnsupportedFrontDoorSettingError`, naming
  the kind and the prop.

  The ALB and API Gateway doors serve static files through an asset-proxy Lambda
  that answers like the CloudFront door: a missing file returns 404 (the SPA
  fallback applies only to paths without an extension), and each file is served
  with the `Cache-Control` it was uploaded with. It decodes the request path,
  gzips compressible files, answers conditional requests with 304, and adds
  baseline security headers. It switches to a new build only after the build's
  uploads (and the runtime config) have landed. The proxies apply the app's
  redirects (wildcard tail spliced, exact status, never a protocol-relative
  target), per-pattern response headers and error pages with the CloudFront
  door's semantics; synth names what they can't reach (server-rendered and image
  responses, and API Gateway's natively proxied API) with the warning
  `@aws-blocks/hosting:DoorRulesNotApplied`. A file is returned base64-encoded in
  the Lambda response, so it is capped at about 750 KB (gzipped when
  compressible) behind the ALB (1 MB response) and 4.5 MB behind API Gateway
  (Lambda's 6 MB response); synth lists every larger build asset
  (`@aws-blocks/hosting:AssetExceedsProxyLimit`). ALB listener rules are packed
  within the per-rule limits (five condition values, six wildcards; a pattern
  with more wildcards fails synth with `UnsupportedRoutePatternError`), and synth
  warns past the default 100 (`AlbRuleLimit`). Past CloudFront's 25
  cache behaviors, the stacked door's edge serves the remaining static routes
  through the ALB and warns (`@aws-blocks/hosting:StackedEdgeBehaviorLimit`).

  Some apps need the CloudFront door. `compute: { type: 'web-function' }` fails
  synth with `UnsupportedComputeFrontDoorError` behind any other door, and an app
  with Next.js middleware with `MiddlewareNeedsCloudFrontDoorError` (only the
  CloudFront door runs it). A streaming server (Next.js through OpenNext, or
  Nitro with `awsLambda.streaming: true`) fails synth with
  `StreamingServerNeedsStreamingDoorError` behind a door that invokes it without
  streaming (the ALB, the stacked door, the API Gateway HTTP API, or a custom
  door with `serverResponse: 'buffered'`): it would deploy and no page would
  answer. Each built-in door declares what it can serve (streaming, wildcard
  routes, the app's rules on every response, and whether it sets
  `x-forwarded-host`), and the synth checks read those declarations.

  The server is built for the door in front of it. Behind a door that invokes it
  without streaming (the ALB, the stacked door's ALB router, the API Gateway HTTP
  API), a Lambda Web Adapter server (Astro, Nuxt, SvelteKit) answers buffered.
  Serve Next.js through CloudFront, the `'rest'` door, or a door that streams. Behind
  the ALB, the server answers with multi-value headers (so every `Set-Cookie`
  survives), and a native handler server (Nitro's `aws-lambda` preset) runs
  behind a small ALB event shim that maps the ALB event to the API Gateway REST
  shape (method, decoded query, base64 body) and the response back.

  The CloudFront door and the stacked door's edge set `x-forwarded-host` from
  the viewer's `Host`. Behind the ALB and API Gateway doors, a native handler
  server gets it from `Host` through a small shim (a streaming handler stays
  streaming), and a Lambda Web Adapter server that reads its host from
  `x-forwarded-host` through `HOST_HEADER` (SvelteKit) reads `host` instead. Any
  other Lambda Web Adapter server (Astro's Node adapter, Nitro's `node-server`)
  receives the request's headers as sent, so it shouldn't trust
  `x-forwarded-host` behind those doors.

  Redirects behave the same on every door. A wildcard tail spliced onto a
  root-relative destination keeps one leading slash on the CloudFront door too,
  so `/old//evil.example` never answers a protocol-relative `Location`; an
  absolute destination (`https://example.org/moved`) is kept as written. On the
  API Gateway door, a redirect source with a wildcard inside a segment has no
  route, so on an app with a server it warns
  (`@aws-blocks/hosting:RedirectNotExpressible`). The regional doors never route
  the backend's catch-all raw route (`/*`) to the API, which would take every
  page and asset, and warn (`@aws-blocks/hosting:CatchAllApiPathNotRouted`). The
  stacked edge serves the framework build's own 404 page, as the other doors do.
  On the CloudFront door and the stacked door's edge, the app's header rules
  match the path the viewer asked for, as on the regional doors: the
  viewer-response function sees the URI rewritten to the build prefix, so the
  viewer-request function records the viewer's URI for it (`x-blocks-viewer-uri`,
  trusted only on a rewritten URI), and a rule such as `/assets/*` applies.
  Nuxt image optimization (`@nuxt/image` through the IPX Lambda) works under an
  `app.baseURL` behind every door: the ALB and API Gateway doors route the full
  `/<baseURL>/_ipx/...` path to the image Lambda, which now strips the base path
  before IPX's own prefix (`IPX_APP_BASE_URL`).
  The stacked door emits `HostingInvalidationId`, so the post-deploy liveness
  poll waits for the edge's invalidation.

  `HostingConstruct.securityHeadersPolicy` (the CloudFront door's security-headers
  policy, which `Hosting` reuses on the API and auth behaviors) is `undefined`
  behind a door with no CloudFront distribution here; the stacked door's edge
  carries its own policy on every behavior, the API's included.

  `HostingConstruct` exposes the resolved door as `frontDoorKind`, and takes the
  backend API to proxy same-origin as `backendApi: { url, paths? }` (the core
  `Hosting` sets it from `api`).

  A bring-your-own door is one function:
  `defineFrontDoor({ service, serverResponse?, build(scope, input) })` from
  `@aws-blocks/hosting/constructs`. `Hosting` calls `build` once at synth, after it
  has created the bucket, compute and API and before it declares the asset
  uploads. A door that invokes the server without streaming sets
  `serverResponse: 'buffered'` (the default is `'streaming'`). The door receives
  a `DoorInput`:

  - `app`: the build id, base path, Next.js asset prefix, SPA fallback, routes
    already joined to their origins, redirects, headers and error pages.
  - `origins`: the assets bucket and build prefix, the server and image Lambdas
    with their Function URLs (the server's `streaming` says whether it streams,
    and its Function URL uses the matching invoke mode), and the API with every
    path that must reach it.
    The API paths are `/aws-blocks/*` (RPC and sign-in) plus the backend's raw
    routes. `app.errorPages` is the app's `errorPages`, else the 404 and 500
    pages the framework build shipped.
  - `features`: the door's `frontDoor.features`, under the same names and shapes
    (`domain`, `waf`, `logging`, `monitoring`, `geoRestriction`,
    `skewProtection`). A field is present only when the app asked for that
    feature; skew protection is on by default.

  The door returns `{ url, originHandle?, publicBucket?, onUpload?, cutover? }`.

  - `url` is required. It becomes `HostingUrl`, `Hosting.url`,
    `BLOCKS_PUBLIC_ORIGIN` and an allowed CORS origin (a trailing slash is
    removed). A missing `url` fails synth with `MissingFrontDoorUrlError`.
  - `originHandle` is derived from `url` when the door doesn't return one.
  - `onUpload` runs after the asset uploads are declared, so the door can add
    something that runs after them, such as a cache invalidation. What it adds
    under the door's scope also waits for the runtime `config.json` upload.
  - `cutover` names the constructs that switch traffic to the new build; each
    waits for every upload.

  The `cf.*` helpers (`cf.origin`, `cf.behaviors`, `cf.apiBehaviors`,
  `cf.redirects`, `cf.headers`, `cf.errorPages`, `cf.invalidate`) build
  CloudFront origins, behaviors, functions and error responses from the input
  and record what they wired. `cf.redirects` and `cf.headers` run the same
  matcher as the built-in CloudFront door; `cf.errorPages` returns the same error
  responses. From that record, synth fails if nothing reaches the
  static assets (`ServeStaticAsset`). It also fails if the app has an API and
  none of its paths were wired (`ProxySameOriginApi`). Unwired API paths, app
  redirects, headers or error pages the door didn't wire, and more behaviors than
  a distribution allows by default, are synth warnings. A door that wires with
  raw CDK declares it with `cf.recordWired(...)`, or turns the check off with
  `wiringCheck: false`. `assertDoorConformance(door)` runs the same checks in a
  door's own tests.

  The built-in doors (`cloudFrontDoor`, `albDoor`, `apiGatewayDoor`,
  `s3WebsiteDoor`, `cloudFrontEdgeDoor`) are written the same way. The pieces they
  share are exported for your own doors: `generateAlbAssetProxyCode` and
  `generateApiGwAssetProxyCode` (with `AssetProxyOptions`: the app's redirects,
  headers and error pages, and `assetProxyEnvironment()` for the function's
  environment), `generateAlbApiProxyCode`, `backendBaseUrl`, `coalesceRoutes`,
  `routeSpecificity`, `createSecurityHeadersPolicy`, and `ORIGIN_VERIFY_HEADER` /
  `CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST` for a door that stacks CloudFront over
  its own ALB.

  The framework-injected CORS hosting origin matches case-insensitively (an
  ALB's DNS name is case-preserving, the browser's `Origin` is lower case); the
  app's own `CORS_ALLOWED_ORIGINS` patterns keep their case sensitivity.

  `bb-auth-basic` sessions work behind a TLS-less ALB: its same-origin session
  cookie drops `Secure` when the deployed front door serves over plain HTTP
  (`isInsecurePublicOrigin()` and `plainHttpOrigin` in
  `@aws-blocks/auth-common/cookies`). The other auth Building Blocks still set
  `Secure`, so use an HTTPS door with them. Behind `'none'` (an HTTP S3 website
  calling a cross-site API), auth needs `crossDomain: true`; that cookie keeps
  `Secure` and `Partitioned`.

- f704a68: feat(auth-common): add the `StatusMessage` UI primitive

  Adds `StatusMessage` to `@aws-blocks/auth-common/ui` (re-exported from `@aws-blocks/blocks/ui`) — a themed, accessible status line for the loading / success / error affordance the starter templates otherwise hand-roll with inline styles.

  - `StatusMessage(options?)` returns a `StatusMessageHandle` (`{ element, set }`): mount `element`, then drive it with `set(kind, text)` as an async operation progresses.
  - Four lifecycle states (`StatusKind`): `idle` (muted), `loading` (muted + spinner), `success` (green), `error` (red) — all driven by the existing `--bb-*` semantic tokens, so the message matches the active light/dark theme.
  - The root is a polite ARIA live region (`role="status"`, `aria-live="polite"`); the `loading` spinner is decorative (`aria-hidden`) and holds still under `prefers-reduced-motion`.
  - Adds the `.bb-status*` / `.bb-spinner` classes and a reduced-motion-aware `bb-spin` keyframe to the shared theme CSS.
  - The `auth-cognito` template now renders its status lines through `StatusMessage` instead of a hand-built classed span.

  No breaking changes — purely additive.

### Patch Changes

- 33edca2: Add `submitAuthAction(api, input)` — a browser-only helper that calls `setAuthState` and then drives the local auth notification so `onAuthChange` subscribers and `AuthenticatedContent` re-render on a real signed-in/signed-out transition. This closes the `setAuthState` → `onAuthChange` reactivity gap where a custom auth UI stayed stale unless it also called `broadcastAuthChange` by hand. The framework's own `Authenticator` now routes every action through `submitAuthAction` as the single notifier, so there is no double-fire; challenge/retriable states are not broadcast. Fixes #185.
- d366907: chore: manual dependency bump (2026-10-19)
- Updated dependencies [0765f84]
- Updated dependencies [5572341]
- Updated dependencies [88747f5]
- Updated dependencies [1076ccc]
- Updated dependencies [928c48a]
- Updated dependencies [4d5ea86]
- Updated dependencies [90c1b12]
- Updated dependencies [50b8c94]
- Updated dependencies [ce5dfa9]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [9a32674]
- Updated dependencies [48c35f6]
- Updated dependencies [8c73a24]
- Updated dependencies [48c35f6]
- Updated dependencies [4553866]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [54e9443]
- Updated dependencies [48c35f6]
- Updated dependencies [d366907]
- Updated dependencies [91ed1fc]
- Updated dependencies [48c35f6]
- Updated dependencies [d062eeb]
- Updated dependencies [c22eeee]
- Updated dependencies [1546160]
- Updated dependencies [9c96135]
- Updated dependencies [63b154f]
- Updated dependencies [8565ef7]
- Updated dependencies [ce5dfa9]
- Updated dependencies [515089c]
- Updated dependencies [dde6340]
- Updated dependencies [7477b6e]
- Updated dependencies [d79a0bd]
- Updated dependencies [d79a0bd]
- Updated dependencies [6a53068]
- Updated dependencies [dd5e807]
- Updated dependencies [db15b5e]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [72e3259]
- Updated dependencies [d79a0bd]
- Updated dependencies [48c35f6]
- Updated dependencies [8565ef7]
- Updated dependencies [48c35f6]
- Updated dependencies [0d4ede3]
- Updated dependencies [63b154f]
- Updated dependencies [b6b8ade]
- Updated dependencies [82ea78a]
- Updated dependencies [e44ac0c]
- Updated dependencies [33e8d73]
- Updated dependencies [b003705]
- Updated dependencies [48c35f6]
  - @aws-blocks/core@0.8.0

## 0.2.0

### Minor Changes

- 8ca3692: feat: shared, framework-neutral `ui-theme` design-token layer

  Introduce a design-token layer for the Blocks UI so the shared Auth
  components and the starter templates share one consistent, polished look
  with no new runtime framework dependency.

  - `@aws-blocks/auth-common` ships a new theme module: CSS custom
    properties (`--bb-*` for color, spacing, radius, typography, elevation)
    on `:root`, a light and dark palette driven by `prefers-color-scheme`
    with a `data-bb-theme` override hook, and base `.bb-*` component
    classes. The palette declares `color-scheme` so UA-drawn widgets
    (checkboxes, `<select>`, scrollbars, `::placeholder`, autofill) follow
    the active palette, and `.bb-button` has a `:disabled` state. A new
    idempotent, SSR-safe `injectTheme()` adds the stylesheet to the document
    once. The shared `Authenticator`, `AccountMenuBar`, and
    `AuthenticatedContent` now render against these token classes instead
    of inline styles and inject the theme themselves, so the themed look
    travels with the component into any host (lit-html, vanilla, React,
    Next.js) with zero wiring. Every `data-testid` is preserved.
  - `@aws-blocks/blocks` re-exports `injectTheme`, `THEME_CSS`, and
    `THEME_STYLE_ID` from `@aws-blocks/blocks/ui`, and adds a lean
    `@aws-blocks/blocks/theme` subpath that re-exports ONLY the token layer
    (no `Authenticator`/WebAuthn surface) for non-auth hosts. `@aws-blocks/auth-common`
    is marked `sideEffects: false` so a bundler can drop the unused UI
    surface; `@aws-blocks/blocks` is not, because as an aggregator that
    re-exports side-effecting building blocks it is not side-effect-free.
  - `@aws-blocks/create-blocks-app` templates (`default`, `react`,
    `nextjs`, `demo`, `auth-cognito`) adopt the tokens for their own page
    chrome and todo UI, so the whole page is themed and dark-mode-aware;
    the `bare` template stays deliberately minimal. The static templates
    inline the first-paint palette and the `nextjs` template server-renders
    the token `<style>` so a dark-mode user never sees a white flash before
    the bundle runs. A `--bb-color-success` token keeps success messages
    from reading as accent blue.

  Focus states use a real `outline` ring (preserved under forced-colors /
  Windows high-contrast mode) rather than an `outline: none` + `box-shadow`
  ring, which such modes drop.

  Additive and non-breaking.

### Patch Changes

- Updated dependencies [ec7eebe]
- Updated dependencies [e682ba7]
- Updated dependencies [e7e96e6]
- Updated dependencies [9ebda66]
- Updated dependencies [78f4396]
- Updated dependencies [440ecce]
- Updated dependencies [1a5c18e]
- Updated dependencies [4ae500e]
- Updated dependencies [6d764f7]
- Updated dependencies [5d6656a]
- Updated dependencies [60616b1]
- Updated dependencies [a50fb46]
- Updated dependencies [8a1a4a9]
- Updated dependencies [38ce80c]
- Updated dependencies [94a914a]
- Updated dependencies [cb0ec01]
- Updated dependencies [005c095]
- Updated dependencies [b8649dc]
- Updated dependencies [2da2fd4]
- Updated dependencies [66f4be2]
- Updated dependencies [32a4b73]
- Updated dependencies [da6d4c7]
- Updated dependencies [e3e5e22]
- Updated dependencies [e9241b5]
- Updated dependencies [f1eb149]
- Updated dependencies [122c49c]
- Updated dependencies [7c19c4f]
  - @aws-blocks/core@0.7.0

## 0.1.9

### Patch Changes

- 4456fd7: Document the full `AuthState` shape returned by `getAuthState()`/`setAuthState()` (`errorName`, `retriable`, and the `confirmingSignIn` state) in the auth READMEs, and note that `bb-auth-cognito` / `bb-auth-oidc` consumers import the type from `@aws-blocks/auth-common`.
- fac0e75: fix(auth-common): Enter submits the Authenticator form from any field, not just the last

  The rendered auth form isn't a native `<form>`, so submit-on-Enter is wired
  explicitly — but the handler was bound only to the _last_ visible input. In any
  multi-field form, pressing Enter in an earlier field did nothing: the username in
  a username+password sign-in, or the verification code in a code+newPassword
  confirm-reset form. Enter now submits from every visible field, matching native
  form behavior.

- Updated dependencies [5501cb6]
- Updated dependencies [b58f248]
- Updated dependencies [39628cb]
- Updated dependencies [d4b32f2]
- Updated dependencies [a649895]
- Updated dependencies [27646ac]
- Updated dependencies [5515483]
- Updated dependencies [757d4a9]
- Updated dependencies [a23b8d8]
- Updated dependencies [9e02b82]
- Updated dependencies [465a002]
  - @aws-blocks/core@0.6.0

## 0.1.8

### Patch Changes

- 5eee114: Add npm keywords for discoverability via `npm search keywords:aws-blocks`

  Every published package now carries an npm `keywords` array: the shared `aws-blocks`
  discovery tag plus 2–5 functional keywords describing the package's domain and the
  AWS services it uses (e.g. `realtime`, `websocket`, `pubsub` for `bb-realtime`;
  `ci-cd`, `pipelines`, `deployment` for `pipeline`). Metadata only — no runtime,
  API, or behavior change.

- Updated dependencies [2806ae2]
- Updated dependencies [f552ebe]
- Updated dependencies [9aa0814]
- Updated dependencies [012cd89]
- Updated dependencies [5eee114]
- Updated dependencies [d7312f9]
- Updated dependencies [21443ba]
- Updated dependencies [acd1628]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [302090a]
  - @aws-blocks/core@0.5.0

## 0.1.7

### Patch Changes

- Updated dependencies [df667c5]
- Updated dependencies [df667c5]
- Updated dependencies [64ddd74]
- Updated dependencies [df667c5]
- Updated dependencies [646614b]
- Updated dependencies [c45eb92]
- Updated dependencies [4a830a6]
- Updated dependencies [f2f186c]
- Updated dependencies [46b7c89]
- Updated dependencies [1da58fd]
  - @aws-blocks/core@0.4.0

## 0.1.6

### Patch Changes

- Updated dependencies [5798492]
- Updated dependencies [f00adb0]
- Updated dependencies [f00adb0]
- Updated dependencies [08ab129]
- Updated dependencies [9d4ccea]
- Updated dependencies [5bfae0a]
- Updated dependencies [0ac3879]
- Updated dependencies [e4dac4a]
  - @aws-blocks/core@0.3.0

## 0.1.5

### Patch Changes

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0

## 0.1.4

### Patch Changes

- 75f5446: Add optional `fallback` parameter to `AuthenticatedContent` for rendering alternative content when the user is not authenticated.
- 2ed4177: Add stable `data-testid` hooks to the auth UI components so e2e suites can target the shipped `Authenticator` instead of forking it. Covers every interactive element (field inputs, hidden ones included, and submit buttons) plus the containers worth asserting against: the root, per-action wrappers, heading, error, the signed-in marker, `AuthenticatedContent`, and `AccountMenuBar`. Presentational markup such as hint text and layout wrappers stays unhooked. The full selector contract, including the `<action>:<provider>` form federated actions produce, is documented in CUSTOMIZING-AUTH-UI.md.

  The `@aws-blocks/blocks` umbrella package receives a `patch` because it re-exports these components from `@aws-blocks/auth-common/ui`. Sibling patch releases stay inside the umbrella's caret ranges, so `changeset version` never bumps it on its own (#212), and it is republished explicitly to stay in step with the components it hands to consumers.

- 58f77dd: Document four things people were reverse-engineering from compiled output.

  - **Runtime config resolution.** The client config is served at the dotted path `/.blocks-sandbox/config.json`; `/config.json` is not a route, so a 404 there means nothing. `{"_placeholder":true}` in the frontend build output is the Hosting construct's synth-time stub (the real `apiUrl` is still an unresolved CloudFormation token), so it is expected pre-deploy rather than a broken config. Covers the resolution order, what each environment should actually return, and what a genuine failure looks like.
  - **`RawRoute`.** Full section in the core README: constructor signature, a `GET` example that sets status, `Content-Type` and body, what you can read off `ctx.request` and write to `ctx.response`, path/parameter/wildcard syntax, and the registration rules (reserved paths, duplicate routes, register-during-load). Also added a "serve a raw HTTP endpoint" entry to the block catalog decision tree, which had no pointer to it.
  - **Server-initiated OIDC sign-in.** New section in the `bb-auth-oidc` README for `GET /aws-blocks/auth/signin/<provider>`: the redirect chain through the IdP and the callback, the pending-auth and session cookies, the JSON error shape, a runnable `curl` walkthrough, when to use it instead of the client PKCE API, and a pointer to the integration tests that assert each response. One route is mounted per configured provider, so an undeclared provider name 404s instead of reporting `ProviderNotConfiguredException`, which comes from `getSignInUrl()`.
  - **Error and RPC semantics.** `ApiError`'s constructor arguments (including `cause` staying server-side and `retriable`), how its `status` becomes the JSON-RPC error code and decodes back into an `ApiError` on the client, `hasAuthError`'s signature and when it applies instead of `isBlocksError`, how `params` is read as positional args vs a named object, that a top-level JSON array body (a batch) is rejected with `-32600`, and that `broadcastAuthChange` comes from `@aws-blocks/blocks/ui` rather than the package root.

  Docs only, plus tests locking in the documented `ApiError`, `params` and batch-rejection behaviour, and the documented `404`s on the OIDC sign-in and sign-out routes.

- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [2d3dfdc]
  - @aws-blocks/core@0.1.17

## 0.1.3

### Patch Changes

- 1da34f1: fix(auth): propagate the structured error name through `setAuthState()`

  The recommended client auth path is `createApi()` → `setAuthState()`. When an
  action failed, `setAuthState()` caught the thrown `ApiError` and returned an
  `AuthState` carrying only `error: e.message`, discarding the structured
  `e.name` (e.g. `'InvalidCredentialsException'`). Because `AuthState` had no
  field for an error name, a hand-rolled client could not branch on error type
  (e.g. "try sign-in, fall back to sign-up for a brand-new user") without
  brittle string-matching the human-facing message.

  `AuthState` now carries an optional `errorName`, and the `bb-auth-basic` and
  `bb-auth-cognito` `setAuthState` implementations populate it from the thrown
  `ApiError.name` (skipping the generic `'ApiError'` default). A new
  `hasAuthError(state, name)` type guard in `@aws-blocks/core` lets clients
  branch on the returned state — `isBlocksError` only matches thrown `Error`
  instances, so it cannot be used on the plain `AuthState` object. Rule of
  thumb: throw path → `isBlocksError`; returned `AuthState` → `hasAuthError`.

- Updated dependencies [f42c604]
- Updated dependencies [1da34f1]
  - @aws-blocks/core@0.1.6

## 0.1.2

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- d4a1390: Fix `onAuthChange` and `Authenticator` to paint a synchronous first frame.

  Both previously deferred their initial emit/render behind the async
  `ensureState().then(...)`, so a signed-out UI never painted synchronously on
  subscribe — leaving a blank first frame and causing non-deterministic timeouts
  in CI harnesses (and contradicting `onAuthChange`'s documented "calls callback
  immediately" contract). `onAuthChange` now emits the last-known user from the
  shared cache synchronously, then refreshes from the async hydration — with a
  dedupe to avoid a spurious `null → user` flash and a `.catch` so a rejected
  `getAuthState()` never strands the UI. `Authenticator` does the same synchronous
  first paint from the cache and gains the same `.catch` hardening.

## 0.1.1

### Patch Changes

- 270c049: docs: scrub and port documentation from internal staging repo
- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1

## 0.1.0

Initial version
