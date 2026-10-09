# What changed: the auth unification, in plain words

**For:** the project lead. **Branch:** `refactor/auth-blocks` (local only, not pushed). **Compared with:** `origin/main` (merge-base `b58f2487`).

This note says what changed, what app developers and their end users will notice, and what still needs a decision. Every claim comes from the code, the `bb-auth` docs (`README.md`, `DESIGN.md`, `MIGRATION.md`), the changesets on the branch, or the design docs in this folder. Words in *italics* the first time are explained in the [Glossary](#9-glossary).

---

## 1. The one-paragraph version

AWS Blocks had three sign-in blocks: `AuthBasic` (its own password store), `AuthCognito` (Amazon Cognito) and `AuthOIDC` (Google, Okta and similar). People couldn't tell which to pick, and the three disagreed on error names, on what `userId` means, and on the UI. They are now one block, `Auth`, configured with one options object. Email + password, social, OIDC and SAML sign-in are sibling keys. The old three packages are removed in the same release. `AuthCognito` apps upgrade in place and keep their users and sessions (proven on real AWS). `AuthOIDC` users sign in once more. `AuthBasic` users must sign up again. A codemod does most of the code rewrite.

---

## 2. Before vs after, at a glance

| | `AuthBasic` (before) | `AuthCognito` (before) | `AuthOIDC` (before) | `Auth` (after) |
|---|---|---|---|---|
| Package | `@aws-blocks/bb-auth-basic` | `@aws-blocks/bb-auth-cognito` | `@aws-blocks/bb-auth-oidc` | `@aws-blocks/bb-auth` (also from `@aws-blocks/blocks`) |
| Class | `AuthBasic` | `AuthCognito` | `AuthOIDC` | `Auth` |
| Config | flat options (`sessionDuration`, `passwordPolicy`, `codeDelivery`) | flat options (`selfSignUp`, `signInWith`, `groups`, `mfa`, …) | `providers: [google(), customOidc(), cognitoFederated(), …]` array | grouped options: `emailPassword`, `users`, `session`, `mfa`, `passkeys`, `admin`, `redirects`, plus `socialProviders` / `oidcProviders` / `samlProviders` records keyed by provider id |
| Sign-in methods | username + password | email/username + password, MFA, passkeys, passwordless codes | OIDC / OAuth 2.0 providers, optionally through a Cognito pool | all of these in one block, mixed freely |
| Where users live | DynamoDB tables the block owned (bcrypt hashes) | a Cognito *user pool* | at the IdP (direct), or a separate Cognito pool (`cognitoFederated()`) | a Cognito user pool for password, social, SAML and Cognito-federated OIDC users; at the IdP for direct OIDC users (no pool is created if those are the only ones) |
| Sessions | a JWT in cookie `auth_<fullId>` | a session row in DynamoDB, cookie `auth_<fullId>` | its own `oidc_…` cookie and SSM secret | `AuthCognito`'s session layer, unchanged: same cookie, table and secret |
| Error names | `AuthBasicErrors` (`InvalidCredentialsException`, `SessionExpiredException`, …) | `AuthCognitoErrors` (Cognito names) | `AuthOIDCErrors` | one shared list, `AuthErrors`, with `isAuthError()` |
| Client UI | shared `Authenticator` | shared `Authenticator` + typed `cognitoOverrides()` | a separate browser client from `authApi.getClient()` | shared `Authenticator` for everything; federated providers show as "Sign in with …" buttons; typed `authOverrides()`; new reactive store |
| Runs offline (`npm run dev`) | yes | yes (local mock) | yes, with the stub IdP | yes for email + password and direct OIDC (including the stub IdP); social, SAML and Cognito-federated OIDC need a deployed stack |

---

## 3. What app developers will notice

In the snippets, `scope` is the app's `Scope`. Every `After` snippet imports from `@aws-blocks/blocks`; `@aws-blocks/bb-auth` exports the same names.

### 3.1 Set up email + password

One line, as before. What differs is the shape of the options and a few defaults.

```ts
// Before (AuthBasic)
const auth = new AuthBasic(scope, 'auth', {
  sessionDuration: 86_400,
  passwordPolicy: { minLength: 8, requireSpecialChars: true },
  codeDelivery: async (username, code) => sendEmail(username, code),
});

// Before (AuthCognito)
const auth = new AuthCognito(scope, 'auth', {
  selfSignUp: true,
  signInWith: 'email',
  passwordPolicy: { minLength: 12 },
});
```

```ts
// After (Auth)
import { Auth } from '@aws-blocks/blocks';

const auth = new Auth(scope, 'auth', {
  emailPassword: { selfSignUp: true, passwordPolicy: { minLength: 12, requireSymbols: true } },
  users: { signInWith: ['email'] },          // always an array now
  session: { ttlSeconds: 86_400 },            // default is 400 days
  // Local dev only: Cognito sends the codes on AWS. Three arguments now.
  codeDelivery: async (username, code, purpose) => console.log(`[auth] ${purpose} code for ${username}: ${code}`),
});
export const authApi = auth.createApi();
```

Things to know:

- **Email + password is on by default.** `new Auth(scope, 'auth')` gives you a Cognito user pool. Turn it off with `emailPassword: false`.
- **Sign-up always needs the emailed code.** There is no instant sign-up any more. With `emailPassword.autoSignIn` (on by default) the user is signed in as soon as they enter the code, without retyping the password.
- **Stricter password defaults.** `Auth` requires upper case, lower case, digits and symbols unless you turn them off. `AuthBasic` required none. `requireSpecialChars` is now `requireSymbols`.
- **Cognito's default email sender sends at most 50 emails a day** (sign-up, reset and email-MFA codes all count). Fine for development, not for production. `Auth` can't configure Amazon SES yet; for volume, set SES up on a pool you manage and wrap it with `userPool: Auth.fromExisting(userPoolId, clientId)`.
- **Misspelled options are errors.** `{ emailPasword: false }` or a top-level `preferredChallenge` used to compile and do nothing. Now the constructor throws in `npm run dev`, at synth and in Lambda, naming the path and a suggestion (`did you mean users.preferredChallenge?`). Boolean options must be real booleans: `selfSignUp: 0` from untyped code used to turn sign-up **on**.
- **Methods your configuration can't use don't compile.** With `emailPassword: false`, calling `auth.signUp(...)` is a compile error whose message names the cause (`ERROR_emailPassword_is_disabled_on_this_Auth_instance`). The same applies to MFA, passkey, admin and federated methods (see the README's "Mode gates"). Pass options inline so the compiler can see them.
- **`validateUser`** is one hook for "may this person sign up or sign in", for every method. Throw to refuse. On AWS it also installs a Cognito PreSignUp trigger, so it also guards users created outside your app (the console, CLI, a first social sign-in). Cognito gives the trigger 5 seconds, cold start included.

### 3.2 Add Google or another social provider

Before, social sign-in through Cognito meant `AuthOIDC` with `cognitoFederated()`, a domain name and a region. Now it is a key.

```ts
// Before (AuthOIDC)
const auth = new AuthOIDC(app, 'auth', {
  providers: [
    cognitoFederated({
      name: 'google', identityProvider: 'Google',
      cognitoDomain: 'myapp', region: 'us-east-1',
      clientId: googleClientId, clientSecret: googleSecret,
    }),
  ],
});
```

```ts
// After (Auth)
const googleSecret = new AppSetting(scope, 'google-secret', { secret: true });
const auth = new Auth(scope, 'auth', {
  socialProviders: { google: { clientId: 'your-google-client-id', clientSecret: googleSecret } },
});
```

- Supported: `google`, `apple`, `facebook`, `amazon`. Email + password stays on next to it unless you set `emailPassword: false`.
- `clientId` is a plain string. `clientSecret` must be an `AppSetting` created with `secret: true`, never a string.
- The CDK layer creates the Cognito domain, a hosted-UI app client and the IdP registration. In the IdP's console you register `https://<cognito domain>/oauth2/idpresponse`.
- Social users become ordinary user-pool users: `requireRole()` and `auth.admin` work for them. They cost the same as password users.
- **Local dev:** social sign-in answers with a clear `501` ("unavailable locally"). Test it on a sandbox, or use a direct OIDC provider or `stubIdp()` offline.
- **MFA is the provider's.** Cognito never challenges a federated user, so enforce MFA at the IdP. `AuthOIDC`'s docs had claimed Cognito federation added MFA; that was wrong and is corrected.
- Sign-out also ends Cognito's managed-login session, so the next "Sign in with Google" really asks Google again.

### 3.3 Add a generic OIDC provider (Okta, Entra ID, Auth0, GitHub, …)

An `oidcProviders` entry can be federated two ways. You choose per provider with `federateVia`.

```ts
// Before (AuthOIDC)
providers: [
  customOidc({ name: 'okta', issuerUrl: 'https://dev-123.okta.com', clientId: 'okta-id', clientSecret: () => oktaSecret.get() }),
  github({ clientId: 'gh-id', clientSecret: () => githubSecret.get() }),
],
```

```ts
// After (Auth)
oidcProviders: {
  // Direct (the default): your backend talks to the IdP and verifies its tokens.
  okta: { issuer: 'https://dev-123.okta.com', clientId: 'okta-id', clientSecret: oktaSecret },
  github: github({ clientId: 'gh-id', clientSecret: githubSecret }),
  // Through Cognito: the user lands in your user pool. A client secret is required.
  entra: {
    federateVia: 'cognito',
    issuer: 'https://login.microsoftonline.com/<tenant>/v2.0',
    clientId: 'entra-id',
    clientSecret: entraSecret,
  },
},
```

`google()` and `customOidc()` are gone; a generic provider is a plain `{ issuer, clientId, clientSecret? }` object. `github()`, `customOauth2()` and `stubIdp()` stay.

**When to pick which:**

| | `federateVia: 'direct'` (default) | `federateVia: 'cognito'` |
|---|---|---|
| Cognito cost | none: these users never touch Cognito | separate meter: 50 free monthly active users, then $0.015 each (price read 4 Oct 2026) |
| Works offline | yes, with `stubIdp()` | no (`501` locally) |
| Public, *PKCE*-only clients (no secret) | yes | no: Cognito requires a client secret |
| Cognito groups, `auth.admin`, Cognito-issued tokens | no; `requireRole()` reads groups from the provider's `groupsClaim` | yes, the user is a pool user |
| `userId` | `` `${issuer}:${sub}` `` (same as `AuthOIDC`) | the Cognito username (`<Provider>_<sub>`) |

Pick **direct** unless you need those users inside your user pool. A configuration with only direct providers and `emailPassword: false` creates no Cognito resources at all.

Register `<your origin>/aws-blocks/auth/callback` with the IdP for a direct provider.

**The stub IdP.** `stubIdp()` is a real OIDC provider served by the dev server, with an account picker. It is now **local-only by default**: synth fails with "`stubIdp()` is local-only". A test stack can opt in with `stubIdp({ users, unsafeAllowDeployed: true })`, and synth then warns, because a deployed stub lets anyone sign in as any of its users. There is no built-in "stub locally, real IdP when deployed" switch yet; the app picks the provider by environment (see [section 8](#8-things-that-still-need-a-decision), L44).

### 3.4 SAML

There was no SAML option before. Now:

```ts
// After (Auth)
const auth = new Auth(scope, 'auth', {
  samlProviders: { corp: { metadataUrl: 'https://idp.example.com/saml/metadata' } },
});
```

It always goes through Cognito: same 50-free-users meter as `federateVia: 'cognito'`, a `501` locally, and the IdP registers `https://<cognito domain>/saml2/idpresponse`. `metadataFile` and `signRequest` are the other options. Use it only for an IdP that doesn't speak OIDC.

### 3.5 MFA and passkeys

These carry over from `AuthCognito`, with grouped options and camel-case method names.

```ts
// Before (AuthCognito)
new AuthCognito(scope, 'auth', {
  mfa: 'optional',
  mfaTypes: ['TOTP'],
  enablePasskeys: true,
  webAuthnRelyingParty: { id: 'example.com', origins: ['https://example.com'] },
  authFlowType: 'USER_AUTH',
});
await auth.setUpTOTP(context);
const pref = await auth.fetchMFAPreference(context);
```

```ts
// After (Auth)
new Auth(scope, 'auth', {
  mfa: { mode: 'optional', types: ['TOTP'] },
  passkeys: { relyingPartyId: 'example.com', origins: ['https://example.com'] },
  users: { authFlow: 'USER_AUTH' },
});
await auth.setUpTotp(context);
const pref = await auth.getMfaPreference(context);
```

- **Default factors changed.** With MFA on and no `types`, `AuthCognito` enabled SMS only; `Auth` defaults to `['SMS', 'TOTP']`. The codemod writes `types: ['SMS']` so an upgrade doesn't quietly add authenticator-app MFA.
- `passkeys.userVerification` accepts `'required'` or `'preferred'`. `'discouraged'` is gone (`AuthCognito` silently used `'preferred'` for it anyway).
- MFA and passkey methods are compile errors unless the options turn them on.
- MFA applies to email + password users only. Federated users get their IdP's MFA.
- `rememberDevice` still throws `501` on AWS, as in `AuthCognito`. `scanDevices` (was `fetchDevices`) and `forgetDevice` work.
- `preferredChallenge: 'EMAIL_OTP'` (passwordless email codes) needs Amazon SES, so on a pool the block creates synth fails. See [section 5.1](#51-from-authcognito-the-safe-path) for the upgrade trap.
- **New:** `requireAuth(context, { fresh: true })` demands a recent sign-in (default 15 minutes, `session.freshAgeSeconds`) before a sensitive action, and throws `ReauthenticationRequiredException` otherwise.

### 3.6 Groups and roles (`requireAuth`, `requireRole`)

The guards look the same and work the same for every sign-in method.

```ts
// Before and after: same calls
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async profile() {
    const user = await auth.requireAuth(context);      // 401 NotAuthenticatedException if signed out
    return { id: user.userSub, email: user.attributes.email };
  },
  async adminOnly() {
    await auth.requireRole(context, 'admins');         // 403 NotAuthorizedException if not in the group
  },
}));
```

```ts
// Groups move under `users`
// Before (AuthCognito): { groups: ['admins', 'editors'] }
// After (Auth):         { users: { groups: ['admins', 'editors'] } }
```

What changed:

- **`requireRole` reads group membership live** on each guarded request (one extra Cognito call, shared within a request). Adding or removing a user from a group takes effect on their next request, with no re-login. Older `AuthCognito` releases read the token's snapshot. A deleted user fails closed with `403`. The `groups` on `requireAuth()`'s user is still the snapshot from sign-in.
- `requireRole`'s `role` is typed as the declared group names, so a typo is a compile error.
- **`requireRole` now works for direct OIDC users too**, from the provider's `groupsClaim`. `AuthOIDC` and `AuthBasic` had no roles at all.
- **One user type, `AuthenticatedUser`**, replaces `CognitoUser`, `OIDCUser` and `AuthBasicUser`. Fields: `userId`, `username`, `userSub`, `groups`, `attributes`, `signInProvider` (`'password'` or the provider id), and `claims` (direct OIDC users only, server-side only).
- **Key your data on `userSub`.** It is the stable id. `userId` is the Cognito username for pool users (a generated UUID when users sign in with email), and `` `${issuer}:${sub}` `` for direct OIDC users.
- `BlocksAuth.requireRole` is now a required member of the shared `BlocksAuth` interface. Only matters if you implement that interface yourself.
- `auth.admin` (opt-in with `admin: {}`) is unchanged in spirit, and `admin.revokeUserSessions` now also deletes the user's session rows, so revocation is immediate.

### 3.7 Errors: the new names, and how to check them

There is one list, `AuthErrors`, shared by server and browser. Errors cross the wire by **name**, so match on names, never on message text.

```ts
// Before (AuthBasic)
if (isBlocksError(e, AuthBasicErrors.InvalidCredentials)) { /* … */ }

// After (Auth), on a thrown error
import { AuthErrors, isAuthError } from '@aws-blocks/blocks';
if (isAuthError(e, AuthErrors.NotAuthorized)) { /* wrong username or password */ }

// After (Auth), on a returned AuthState (the Authenticator / setAuthState path)
import { hasAuthError } from '@aws-blocks/core';
const next = await authApi.setAuthState({ action: 'signIn', username, password });
if (hasAuthError(next, AuthErrors.NotAuthorized)) { /* … */ }
```

`isAuthError` only accepts real `AuthErrors` names, so a misspelled name is a compile error.

| Old name | New name |
|---|---|
| `InvalidCredentialsException` (`AuthBasic`) | `NotAuthorizedException` (`AuthErrors.NotAuthorized`) |
| `UserAlreadyExistsException` (`AuthBasic`) | `UsernameExistsException` (`AuthErrors.UserAlreadyExists`) |
| `SessionExpiredException` (`AuthBasic`) | `NotAuthenticatedException` (`AuthErrors.NotAuthenticated`) |
| `InvalidCodeException` (`AuthBasic`) | **split:** `CodeMismatchException` (wrong code) and `ExpiredCodeException` (expired or missing) |
| `AuthOIDCEngineError` (`cognitoFederated()`) | **split:** `ProviderNotConfiguredException`, `InvalidStateException`, `InvalidCallbackException`, `IdpErrorException`, `TokenExpiredException` |
| every `AuthCognitoErrors` and `AuthOIDCErrors` name | unchanged |

**Watch out:** a renamed error doesn't break the build when you compare with a string. The check just stops matching. The codemod marks every auth error check for review.

Behaviour changes in what clients receive:

- **No account enumeration by default.** A wrong password and an unknown user get the same `NotAuthorizedException` ("Incorrect username or password"). Sign-up through the UI answers an existing account like a new one, and the confirm, resend and reset steps hide whether an account exists or is confirmed. Set `emailPassword.revealExistingUsers: true` for the informative errors. Only `auth.admin` returns `UserNotFoundException`.
- **An unrecognised Cognito error** reaches the client as `InternalErrorException` (500, retriable), not under its raw Cognito name. The real name is logged on the server.
- **No AWS identifiers leak.** An IAM error that names your role ARN or account id now reaches the client as a generic 500.
- Attribute writes get the same error locally and on AWS, in a fixed order (a non-string value, then a value over 2,048 characters, then a `*_verified` flag, then an unknown or immutable attribute).

### 3.8 The sign-in UI and the reactive store

The server side of the UI is still two RPC methods, `getAuthState` and `setAuthState`, from `auth.createApi()`. Every action and field name is carried over from `AuthCognito`, so `data-testid` hooks in existing e2e suites keep working.

```ts
// Before (AuthCognito)
import { Authenticator } from '@aws-blocks/auth-common/ui';
import { cognitoOverrides } from '@aws-blocks/bb-auth-cognito/ui';
document.body.appendChild(Authenticator(authApi, cognitoOverrides({ hideActions: ['signUp'] })));

// Before (AuthOIDC): a separate browser client
const client = await authApi.getClient();
button.onclick = () => client.signIn('google');
// ...and on the return page: await client.handleRedirectCallback();
```

```ts
// After (Auth): one Authenticator for every sign-in method
import { Authenticator, authOverrides } from '@aws-blocks/blocks/ui';
import { authApi } from 'aws-blocks';
document.body.appendChild(Authenticator(authApi, authOverrides({ hideActions: ['signUp'] })));
```

- **Federated providers are buttons, not code.** Each provider appears in `getAuthState()` as a `signIn:<id>` action that carries a `url` (`/aws-blocks/auth/signin/<id>`). The `Authenticator` renders it as "Sign in with …", and the browser follows the link. The server handles the callback and sets the cookie.
- **`getClient()` and `AuthOIDC`'s browser client are gone**, with `handleRedirectCallback()`, `onAuthStateChange()` and the `/middleware` import. A plain link works too: `<a href="/aws-blocks/auth/signin/google">`.
- **Renamed UI types:** `cognitoOverrides` → `authOverrides`, `CognitoActionName` → `AuthActionName`, and so on.
- **The signed-in name is readable.** On email sign-in pools Cognito's username is a UUID, so the UI used to show "Signed in as: 815424a9-…". `AuthState.user` now has a `displayName` (the email, else the phone, skipping unverified ones, else `preferred_username`, else the username), and the `Authenticator` and `AccountMenuBar` show it. It is for display only; key data on `userSub`.
- **Confirm-code forms carry the username as a hidden field**, filled in from the previous step, so users never retype it. (`AuthBasic`'s forms showed an empty field.)

**The reactive store (new).** Before, a custom form that called `authApi.setAuthState(...)` directly changed the session but told nothing else on the page, so `onAuthChange`, `AuthenticatedContent` and `AccountMenuBar` showed stale state until a reload. Three new functions in `@aws-blocks/blocks/ui` fix that:

```ts
import { submitAuthAction, subscribeAuthState, getAuthStateSnapshot } from '@aws-blocks/blocks/ui';

// Submit an action and notify every auth subscriber, in this tab and other tabs, exactly once.
const state = await submitAuthAction(authApi, { action: 'signOut' });

// React: the shared auth state as a store, including mid-flow steps.
const authState = useSyncExternalStore(
  (cb) => subscribeAuthState(authApi, cb),
  () => getAuthStateSnapshot(authApi),
  () => null,
);
```

The built-in components now submit through `submitAuthAction` too. Side effects users will see: mid-flow steps (such as "enter the code") no longer flash a signed-out state to listeners, a failed automatic sign-in after sign-up shows its error, and a sign-in in another tab triggers one refetch however many `Authenticator`s are mounted.

### 3.9 The native SDKs (Swift, Kotlin, Dart)

The native clients are generated from the backend's API, so they pick up `Auth`'s API shape automatically. What customers see:

- **Sign-in with OIDC no longer fetches a descriptor.** `Auth` has no `getClient()`; its routes are at fixed paths under `/aws-blocks/auth/`.
  - Kotlin adds `OidcClient.forAuth(blocksClient, providers, relayTo)`:
    ```kotlin
    val oidc = OidcClient.forAuth(BlocksClient(Servers.local), providers = listOf("google"), relayTo = "com.example.app://auth/callback")
    val user = oidc.signIn("google")
    ```
  - Swift builds its `OIDCClient` with its public `init(exchangePath:refreshPath:signOutPath:providers:…)` and the fixed paths.
  - Dart's `OidcClient` defaults were wrong (`/auth/callback` with no `/aws-blocks` prefix, a route no block served). They are now `/aws-blocks/auth/authorize-params` and `/aws-blocks/auth/callback`.
- **Token refresh works on Swift and Dart.** They called `/aws-blocks/auth/exchange/refresh`, which `AuthOIDC` never served, so their bearer refresh silently failed. `Auth` serves it.
- **Error names are reachable in Swift.** `RPCError` now has `name` (for example `NotAuthenticatedException`) and `code`. Kotlin and Dart already exposed the name.
- **Custom sign-up attributes are actually sent.** In Kotlin and Swift, `attributes = ["email": …]` on the `signUp` action was sent nested under an `"attributes"` key, so the server got the wrong thing. Now each attribute is its own JSON key. Dart couldn't send them at all and now can (`additionalProperties`).
- **Optional arguments stay in their slot.** In all three SDKs, leaving out an optional argument before a set one shifted later arguments into the wrong parameter on the server (`send("a", c = "c")` arrived as `b = "c"`). Calls now send `null` in the gap, as the TypeScript client does.
- **Kotlin's `confirmSignIn` action is sent flat**; the server used to reject it. Swift's `updateUserAttributes` result decoded a boolean as a string and threw on every call; fixed.
- **Generated-code changes you may have to touch** (all fixes, some visible):
  - Swift: inline-object types are nested (`Meta` → `Invoice.Meta`); `format: date` is now a `String`; union cases that held nothing now carry their value; every struct has a `public init`; dates cross the wire as ISO 8601 strings.
  - Kotlin: union arms carry a `value`; `unknown` is `JsonElement`; a `format: uuid` value needs `@OptIn(ExperimentalUuidApi::class)` at your call site.
  - Dart: `BlocksClient.call` takes a `List` or `Map`; models holding an OIDC client take the client in `fromJson(json, client)`; models compare lists and maps by value. `blocks_runtime` and `blocks_codegen` must be released together.
- **User-agent attribution:** native clients send `x-blocks-user-agent`, which core now forwards into the AWS SDK user agent (Kotlin first; Swift and Dart follow).

### 3.10 Local dev and the mock

`npm run dev` still needs no AWS account. Email + password runs end to end against a local user pool in `.bb-data/<fullId>/state.json`, **the same file `AuthCognito`'s mock wrote**, so local users and local sessions survive the switch. Every code (sign-up, reset, MFA) is written to `.bb-data/<fullId>/last-code.json` and passed to the optional `codeDelivery` hook; no email is sent.

The *mock* now behaves much more like real Cognito. That is good, but code that only worked locally may now fail locally (which is the point). The changes:

| Area | Before (`AuthCognito` mock) | Now (`Auth` mock, same as Cognito) |
|---|---|---|
| `selfSignUp: false` | sign-up still worked | `NotAuthorizedException` |
| Tokens | lasted 400 days, never refreshed | last 1 hour and refresh, so the refresh path is exercised |
| Attributes written | anything was stored | checked against the pool's schema: unknown names, non-strings, over 2,048 characters, `*_verified` flags and immutable attributes are refused |
| `requireAuth().attributes` | included `email_verified`, `phone_number_verified`, `updated_at`, `address` as strings | doesn't (Cognito's ID token carries them as booleans, a number and an object); read them with `getUserAttributes()` |
| Confirming sign-up | marked both email and phone verified | verifies only the contact the code went to |
| Password-reset code | to the email, verified or not | to a verified phone first, then a verified email, never to the user's MFA contact |
| Email / phone uniqueness | two users could verify the same email | one verified owner only (`AliasExistsException`), as Cognito does |
| `admin.resetUserPassword` | forced a new password | sign-in fails with `PasswordResetRequiredException` until reset |
| Account-state answers | raw | the same masking as on AWS |
| Masked phone numbers | lost the `+` | keep it (`+*******0100`) |

Still different from AWS, by design (documented in `DESIGN.md`): any 6-digit TOTP code is accepted, passkey signatures aren't checked, passwords are stored in plain text in the git-ignored `.bb-data/`, and social / SAML / Cognito-federated OIDC answer `501`. There is no fake hosted UI: it would pass locally what fails on AWS.

Users in an old local file that `AuthCognito`'s mock keyed by email are kept as they are (one warning per load), so their sessions keep working.

### 3.11 Deploying

`Auth` deploys the same resources as `AuthCognito`, under the same construct ids (`pool`, `client`, `sessions`, `session-secret`, `group-<name>`). What's new:

- **No pool unless something needs it.** A configuration with only direct OIDC providers creates no Cognito resources.
- **Deletion policy follows the stack preset.** `AuthCognito`'s pool was deleted with the stack unless you set `removalPolicy: 'retain'`, even in production. `Auth` follows `BlocksPresets`: `production` retains and turns on deletion protection, `sandbox` deletes. So a production-preset upgrade gets one intended change on its first deploy.
- **The immutability guard.** Cognito can't change some pool settings after creation (sign-in attributes, username case sensitivity, required attributes, existing custom attributes). Before, CDK synthesized such a change and the deploy rolled back. Now the first synth writes a *baseline* file, `aws-blocks/baselines/<stack>/<fullId>.auth-pool.json`, which you commit. Later synths refuse a change to those settings, and a deploy-time check refuses it again before the pool is touched.
- **Rename and removal guard.** Synth also fails if a committed baseline belongs to a block that no longer exists, because CloudFormation would delete its pool and every user in it. This check now lives in core, for every block that keeps baselines. To remove one on purpose: set `removalPolicy: 'retain'`, deploy, then run synth with `BLOCKS_AUTH_REBASELINE=<fullId>` and commit the deleted file.
- **First-synth warning.** An app coming from `AuthCognito` has no baseline yet. If its first `Auth` configuration has no pool of its own, synth warns (`@aws-blocks/bb-auth:FirstBaselineWithoutPool`), because that deploy would delete the pool. Hence the rule in [section 5](#5-upgrading-an-existing-app): deploy the codemod's output unchanged first.
- **CI caveat.** If only CI deploys, CI must commit the baselines its synth writes, or the guard never sees anything.
- Federated providers add a Cognito domain, a hosted-UI app client and one IdP registration per provider. Secrets stay in SSM and never enter the template. (Every federated deploy re-registers the IdPs; see L18.)
- `getSdkIdentifiers(auth)` returns `{ userPoolId?, clientId?, … }`; the fields are optional because a pool-less `Auth` registers none.
- Vendorized apps (`npm run vendorize -- Auth`) synthesize; the deploy-time Lambdas are bundled from the vendorized source.

### 3.12 The templates (`create-blocks-app`)

- Every template that signs users in (`default`, `react`, `demo`, `api-only`, `sql`, `auth`) now uses `Auth` from `@aws-blocks/blocks`, with the id `'auth'`. They used `AuthBasic` or `AuthCognito`.
- **Sign-up now needs the emailed code** in every template. Locally the code is printed in the `npm run dev` terminal; each template's e2e reads it from `.bb-data/`.
- **The `auth-cognito` template is now `auth`.** `--template auth-cognito` still works and scaffolds `auth`. It signs in with email + password instead of a passwordless email code (that needs SES), and shows groups with `requireRole`, profile attributes, password change and global sign-out.
- **Per-user data is keyed on `userSub`** (the todo field `userId` is renamed `userSub`).
- **Security fix:** `updateTodo` (`demo`, `auth`) spread the caller's input over the stored todo, so a crafted request could write into another user's list. It now copies only `completed`, `priority` and `title`. Apps already scaffolded from these templates should make the same change. Each template's e2e now checks that a second user can't read or change the first user's items.
- The `amplify` overlay's verifier implements `BlocksAuth` with the same error names, and its `requireGroup()` is now `requireRole()`.
- The scaffolded `AGENTS.md` explains how to configure `Auth` and gate methods.

---

## 4. What end users will notice

These are the people who sign in to apps built with AWS Blocks.

- **Sign-up always asks for an emailed code.** No app on `Auth` can offer "sign up and you're in" any more. After the code, the user is signed in without typing the password again. For apps that used `AuthBasic` this is a new step.
- **Codes can run out on a busy day.** Until the app configures SES, Cognito's default sender stops at 50 emails a day, so sign-up and reset codes may not arrive.
- **Stronger passwords** on apps that keep the defaults (upper, lower, digit and symbol).
- **A readable name in the menu bar.** "Signed in as alice@example.com", not a UUID.
- **Less information to attackers.** A wrong password and an unknown account give the same message. Signing up with an email that already has an account looks like a normal sign-up (and the real owner keeps their account). The reset and resend steps don't say whether an account exists. Honest users see slightly vaguer messages; for example "wrong code" also covers an expired code.
- **Sessions after the upgrade:**
  - from `AuthCognito`: still signed in, nothing to do;
  - from `AuthOIDC` with direct providers: sign in once more, same account;
  - from `AuthOIDC` with `cognitoFederated()`: sign in once more; the app sees them as a new user unless the developer re-keys data;
  - from `AuthBasic`: signed out, and must **sign up again** (their old account can't be moved).
- **Session length:** `AuthBasic` apps that didn't set a duration go from 24 hours to 400 days.
- **Fewer surprise sign-outs.** If Cognito has a brief problem while refreshing a session, the session is kept and the request can be retried. `AuthCognito` signed the user out.
- **Group changes apply at once.** Being added to or removed from a group takes effect on the next request, without signing out and in.
- **Social sign-out is real.** Signing out also ends Cognito's managed-login session, so the next "Sign in with Google" asks Google again instead of silently signing back in.
- **A disabled or deleted user** is noticed at the next session refresh (within the access-token lifetime, an hour by default), as before. `requireRole` notices a deleted user at once.

---

## 5. Upgrading an existing app

### 5.1 From `AuthCognito` (the safe path)

Same pool, same users, same passwords, same groups, **and signed-in sessions stay valid**. This was proven on real AWS: an app on `@aws-blocks/bb-auth-cognito@0.1.10` was switched to `Auth` in place. `cdk diff` showed no replacement, the update completed, the pool id, client, sessions table, secret and `userSub` were unchanged, and the pre-upgrade session cookie still worked.

```ts
// Before
const auth = new AuthCognito(scope, 'auth', { selfSignUp: true, signInWith: 'email', groups: ['admins'], mfa: 'optional' });
const attrs = await auth.fetchUserAttributes(context);

// After (what the codemod writes)
const auth = new Auth(scope, 'auth', {
  emailPassword: { selfSignUp: true },
  users: { signInWith: ['email'], groups: ['admins'] },
  mfa: { mode: 'optional', types: ['SMS'] },
});
const attrs = await auth.getUserAttributes(context);
```

Steps, in this order:

1. Run the codemod and resolve its TODOs.
2. **Deploy the result unchanged** and commit the baseline file it writes. Add `removalPolicy: 'retain'` for any pool with real users.
3. Check `cdk diff`: it must show **no replacement** of `AWS::Cognito::UserPool` or `UserPoolClient`. If it does, stop: an id changed.
4. Only then change the configuration.

**The trap step 2 avoids.** Two configurations drop the block's own pool from the template: `emailPassword: false` with only direct OIDC providers, and `userPool: Auth.fromExisting(<the block's own pool id>)`. On a first `Auth` deploy there is no baseline to refuse them, so CloudFormation applies the old template's policy, which for `AuthCognito` was "delete". Synth only warns. The codemod flags `preferredChallenge: 'EMAIL_OTP'`, the setting most likely to tempt someone into the second one.

### 5.2 From `AuthOIDC`

**Direct providers** (`google()`, `customOidc()`, `github()`, `customOauth2()`, `stubIdp()`): nothing in AWS is destroyed, no pool is created, and `userId` stays `` `${iss}:${sub}` ``. The old cookie is ignored, so each user signs in once more. The old cookie-secret SSM parameter is deleted. The codemod adds `emailPassword: false` (otherwise `Auth` would add a password pool), turns `providers` into keyed records, moves redirect options under `redirects`, and keeps each `stubIdp()` deployable with `unsafeAllowDeployed: true` plus a TODO explaining the risk.

The user object changes: `user.email` / `user.name` become `user.attributes.email` / `.name`, `user.provider` becomes `user.signInProvider`, and `iss` / `sub` are gone (`user.claims?.sub` has the raw provider `sub`). Postgres row-level security (`db.crud()`, `supabaseCrud()`) still sees the provider's raw `sub` for these users, so existing policies keep returning rows.

**`cognitoFederated()` providers:** this is the one `AuthOIDC` setup that loses resources. Its own pool (`cognito-pool`) is **deleted** and replaced by `Auth`'s `pool`, with these consequences:
- Each user signs in once more and gets a **new `userId`** (the Cognito username, `Google_1098…`, instead of `https://accounts.google.com:1098…`). Data keyed on the old id must be re-keyed; `MIGRATION.md` has an `onSignIn` recipe that does it lazily.
- The Cognito domain prefix changes by default, so the redirect URI must be re-registered in every IdP console. Keeping the old prefix takes two deploys (remove the old federation first, then add `hostedUi: { domainPrefix }`).

### 5.3 From `AuthBasic`

**There is no migration path for users.** Cognito can't import `AuthBasic`'s bcrypt password hashes, so every user must sign up again. The codemod rewrites the code but marks every `AuthBasic` block with a TODO, because switching is the developer's decision.

On the first deploy a new pool is created. `AuthBasic`'s `users` / `codes` tables and JWT secret leave the stack: **kept** (orphaned) under the production preset, **deleted** under the sandbox preset. Export users first if you need them (`MIGRATION.md` gives a read-only `aws dynamodb scan`). Old session cookies are rejected and cleared, never an error.

Code changes besides the rename: `signIn()` returns `{ status: 'signedIn', user }` or `{ status: 'continueSignIn', nextStep }`; `buildApi()` is gone (use `createApi()`); the user has no `createdAt`; `codeDelivery` runs locally only and takes a third `purpose` argument.

### 5.4 The codemod: `npx @aws-blocks/bb-auth migrate`

```bash
npx @aws-blocks/bb-auth migrate --dry-run    # print a diff, write nothing
npx @aws-blocks/bb-auth migrate              # rewrite the files
```

**It does:** rewrite imports (including `/ui` and `@aws-blocks/blocks` namespace imports), rename classes, types, methods and error constants, map each old options object onto `Auth`'s shape (including `AuthOIDC`'s `providers` array), rewrite `() => setting.get()` secrets to `setting`, and leave a `// TODO(aws-blocks-auth-migrate): …` wherever a person must decide. It never edits a block's scope or id, refuses to write a file if they would change, keeps comments and formatting, only writes files that change, and is safe to run twice.

**It doesn't:** edit `package.json` (swap the dependencies yourself), move `AuthBasic` users, choose the `cognitoFederated()` domain plan or re-key data, see options passed by variable or spread in, convert literal secrets, follow dynamic `import()`s, or replace `AuthOIDC` members that have no equivalent (`getClient()`, `handleCallback`, …). It marks all of these.

### 5.5 The one rule: never change the block id

`new AuthCognito(scope, 'auth', …)` becomes `new Auth(scope, 'auth', …)` with **the same scope and the same `'auth'`**. The class name isn't part of any AWS resource name, so changing it changes nothing in AWS. The id is part of every resource name. Change it, or move the block under another scope, and CloudFormation creates a new user pool and **deletes the old one with every user in it**. The session table and secret are replaced too, signing everyone out. The codemod never touches the id, and leaves a TODO if the id expression mentions the old class name (for example `AuthCognito.name`, which would now evaluate to a different string).

---

## 6. Breaking changes, as a checklist

The changesets mark these as minor releases (the repo forbids majors while on 0.x; at 0.x a minor is already a breaking boundary for `^` ranges).

**Packages and exports**
- [ ] `@aws-blocks/bb-auth-basic`, `@aws-blocks/bb-auth-cognito` and `@aws-blocks/bb-auth-oidc` are removed. No compatibility layer. They get `npm deprecate` after publishing.
- [ ] `@aws-blocks/blocks` no longer exports `AuthBasic`, `AuthBasicErrors`, `AuthCognito`, `AuthCognitoErrors`, `AuthOIDC`, `AuthOIDCErrors`, `cognitoFederated`, `customOidc`, `google`, or the types `AuthBasicOptions`, `AuthBasicUser`, `AuthCognitoOptions`, `AuthFlowType`, `CognitoUser`, `MFAPreference`, `AuthOIDCErrorName`, `OIDCUser`.
- [ ] Names that stay exported from `@aws-blocks/blocks` but now mean `Auth`'s version: `stubIdp`, `github`, `customOauth2`, `relayOrigin`, `RelayOrigin`, `MappedClaims`, `PasswordPolicy`, and about 25 `AuthCognito` types (`SignInResult`, `SignInNextStep`, `AdminUser`, `DeviceRecord`, …; full list in `.changeset/auth-unified-block.md`).
- [ ] Gone with no replacement: `makeExternalUserPoolRef` (use `Auth.fromExisting`), `envVarNames`, `isRetriableAuthError`, `SignInWith`, `ConfirmSignInResponse`, `OIDCClient`, `SessionStore`, `SessionRecord`.
- [ ] `getSdkIdentifiers(auth)` has no `AuthCognito` / `AuthOIDC` overloads; it returns optional `{ userPoolId, clientId, … }`.
- [ ] `BlocksAuth.requireRole` is required (for your own `BlocksAuth` implementations).

**Options**
- [ ] Options are grouped: `emailPassword.*`, `users.*`, `session.*`, `mfa: { mode, types }`, `passkeys: { relyingPartyId, … }`, `redirects.*`. Full table in `MIGRATION.md`.
- [ ] `signInWith` is an array; `authFlowType` → `users.authFlow`; `sessionTtlSeconds` / `sessionDuration` → `session.ttlSeconds`; `crossDomain` → `session.crossDomain`; `requireSpecialChars` → `requireSymbols`.
- [ ] `AuthOIDC`'s `providers` array → `oidcProviders` / `socialProviders` records; `customOauth2()` takes `endpoints: { authorization, token, userInfo }`; `stubIdp()` takes no `name`.
- [ ] Provider secrets must be `AppSetting` references, not strings or functions; `clientId` is a plain string.
- [ ] `passkeys.userVerification: 'discouraged'` is rejected.
- [ ] Unknown options and non-boolean values for boolean options throw at construction.

**Methods**
- [ ] `fetchAuthSession` → `getAuthSession`, `fetchUserAttributes` → `getUserAttributes`, `fetchMFAPreference` → `getMfaPreference`, `fetchDevices` → `scanDevices`, `setUpTOTP` / `verifyTOTPSetup` / `updateMFAPreference` → `setUpTotp` / `verifyTotpSetup` / `updateMfaPreference`.
- [ ] `updateUserAttribute(ctx, name, value)` → `updateUserAttributes(ctx, { [name]: value })`, which returns a record keyed by attribute name.
- [ ] `confirmSignIn(session, { code }, ctx)` → `confirmSignIn(session, code, ctx)`.
- [ ] `signUp()` no longer takes `autoSignIn` (now `emailPassword.autoSignIn`); `signIn()` no longer takes `cognitoSession`.
- [ ] `AuthBasic`: `signIn()` returns a result object, not the user; `buildApi()` is gone.
- [ ] `AuthOIDC`: `getClient()`, the browser client and `/middleware` / `/client` imports, `handleCallback*`, `handleExchange`, `getAuthorizeParams`, `refreshBearerTokens` and the route getters are gone. `Auth` serves those routes itself.
- [ ] Methods a configuration doesn't support are compile errors (mode gates).

**User object and identity**
- [ ] One `AuthenticatedUser` type. `OIDCUser.email` / `name` / `provider` / `iss` / `sub` are gone (use `attributes`, `signInProvider`, `claims`); `AuthBasicUser.createdAt` is gone.
- [ ] `cognitoFederated()` users get a new `userId`.
- [ ] `requireAuth().attributes` no longer holds `email_verified`, `phone_number_verified`, `updated_at` or `address` locally (it never did on AWS).

**Errors**
- [ ] `AuthBasic` and `cognitoFederated()` error names change (table in [section 3.7](#37-errors-the-new-names-and-how-to-check-them)); `InvalidCodeException` and `AuthOIDCEngineError` split.
- [ ] Unrecognised Cognito errors arrive as `InternalErrorException`.
- [ ] Enumeration masking is on by default: `UsernameExistsException` doesn't reach the UI sign-up path, public flows never return `UserNotFoundException`, and confirm / resend / reset hide account state.

**Behaviour**
- [ ] Sign-up always confirms an email with a code (no instant sign-up).
- [ ] `stubIdp()` is local-only unless `unsafeAllowDeployed: true`.
- [ ] Default MFA factors are `['SMS', 'TOTP']` (were SMS only).
- [ ] The pool's deletion policy follows the stack preset.
- [ ] Synth refuses immutable pool changes and the removal of a baselined block.
- [ ] Sessions: `AuthOIDC` and `AuthBasic` users are signed out once.
- [ ] Core: exported Building Block instances (and inherited members such as `constructor`) can no longer be called over RPC; they return `-32601`. Wrap what you want to expose in an `ApiNamespace`. (Already on `main` as #725; this branch adds two smaller cases, R98.)
- [ ] Core: `registerLambdaEventHandler()` throws on a duplicate registration instead of silently replacing the first.
- [ ] Core: an error response only forwards cookies that delete a cookie.
- [ ] Templates: `auth-cognito` renamed `auth` (old name still accepted); data keyed on `userSub`.
- [ ] Native: generated Swift, Kotlin and Dart types change shape in places ([section 3.9](#39-the-native-sdks-swift-kotlin-dart)).

---

## 7. Other improvements that ride along

These aren't about auth, but ship in the same release.

- **Node client resends once on a stale keep-alive socket** (core). A Node app (CLI, SSR server, script) could fail with `fetch failed` after a few idle seconds when the deployed API had closed the pooled connection. The typed client now resends once, only when the failure came before any response byte. Trade-off: if a server crashes after reading a request, a method could run twice, so keep state-changing methods idempotent. Browsers are unchanged.
- **`npm run deploy` no longer hangs** (core). Production `deploy()` loaded the local mocks while generating the client, and a local `Database` or `CronJob` kept the process alive after "Deployment complete!". It doesn't load mocks now, so it also no longer writes to or migrates the local `.bb-data/` database.
- **Short-lived scripts with a local `Database` exit** (bb-data). Seed scripts and tests used to hang after their last query, and the next start logged `Removed stale postmaster.pid`.
- **RPC dispatch hardening, L37** (core). A call could reach any exported Building Block (for example `realtime.publish`) or inherited members like `constructor`. Now only an `ApiNamespace`'s methods (or a plain exported object's) can be called. Generated clients never made such calls. `main` shipped the same fix as #725; after the merge (R98) there is one implementation, `main`'s, plus two extra cases from this branch: a property hidden with `Object.defineProperty`, and the methods of a Building Block a handler returns.
- **Cookies on error responses, L9** (core). A method that throws can now also clear a cookie in the same response (so `requireAuth` can answer 401 and clear a dead session). Only real deletions are forwarded, so a method that signs someone in and then throws never hands out a live session. Malformed `Max-Age` / `Expires` values no longer count as deletions.
- **Multiple cookies on AWS** (core). When a method set more than one cookie, only one reached the browser on AWS. All now arrive, including on the HTTP API / Function URL event format.
- **Long `FileBucket` names** (bb-file-bucket). A derived bucket name over S3's 63-character limit used to fail synth (common with long production stack names, and inside `Agent`). It is now shortened to a stable prefix plus an 8-character hash. Names that fit are unchanged. A follow-up fix makes `Agent` write to the shortened name.
- **Same exports from every entry point.** Several blocks were missing names in their `cdk` or `browser` entries (for example `AgentErrors` in the browser), which failed at import time. A test now checks every entry both ways.
- **Sandbox telemetry** now reports which blocks an app uses (it always reported none), and the sandbox generates the client before deploying, so backend errors appear earlier.
- **Native codegen fixes** across Kotlin, Swift and Dart: dozens of specs that didn't compile now do (name collisions, inline objects, transferables in lists, maps and models, `unknown` values, unions with value arms, dates, escaping). The ones customers will feel most are in [section 3.9](#39-the-native-sdks-swift-kotlin-dart).
- **`AppSetting`'s CDK construct** exposes `parameterName` and `secret`, so another block can use a secret with a custom name.
- **Vendorized apps** using `DistributedTable` with an index, `Database` with migrations, or `DistributedDatabase` now synthesize.
- **Test infrastructure:** old `AuthCognito` deploy-identity and runtime tests now run against `Auth`; mock-versus-AWS parity tests per behaviour; an upgrade-in-place harness; compile checks for every native codegen fixture (Kotlin, Swift, Dart) in CI; a template e2e that checks users can't see each other's data; and the hosting e2e deploys once per run instead of timing out in a test hook.

---

## 8. Things that still need a decision

The full list, with my lean on each, is in [`FINAL-STATUS.md`](./FINAL-STATUS.md) ("Decisions waiting for you"); the reasoning is in [`LATER-DISCUSSION.md`](./LATER-DISCUSSION.md). The ones that change what users get:

- 🔴 **L7: a last patch of the old packages first?** As built, `AuthCognito`'s three security fixes (auto-sign-in cookie not cleared, ARN and account-id leak, account-existence leak on imported pools) reach users only when they move to `Auth`. Option (a) ships them to the old packages first; it means reverting commit `a188cdef`.
- 🟡 **L51:** the codemod makes every migrated `stubIdp()` deployable. Safer alternative: refuse `unsafeAllowDeployed` under the production preset.
- 🟡 **L44:** no built-in "stub IdP locally, real IdP deployed" switch.
- 🟡 **L64:** the RPC server reads by-name params by position; reject object params loudly?
- 🟡 **L41:** `AuthState.user` sends more fields than its type declares.
- 🟡 **L45:** account-existence signals masking can't remove; say so in the release notes.
- 🟡 **L43:** deployed email + password e2e coverage is narrower than `AuthBasic`'s was.
- 🟡 **L54:** `FileBucket` name shortening overturns that block's earlier "error, never truncate" decision.
- 🟡 **L55–L65:** the visible Swift, Kotlin and Dart generated-code changes; Dart's two packages must release together.
- 🟡 **R88 / R89:** release-note the Node client resend and the deploy no longer touching `.bb-data/`.
- 🟡 **L35:** grant the CI role SSM read for the hosting test secret.

**Release actions:** one release with no Version Packages merge in between; `npm deprecate` the three old packages after publishing; release Dart's `blocks_runtime` and `blocks_codegen` together.

**One gap I noticed that isn't in `FINAL-STATUS.md`:** `AuthOIDC` offered a browser-side PKCE client (`getClient()`, `signIn('google')`, `handleRedirectCallback()`), which its README called *required* when a web frontend and its API are on different origins. `Auth` has no browser helper: web sign-in is server-initiated (a link to `/aws-blocks/auth/signin/<id>`), and `DESIGN.md` lists the browser PKCE helper as "not built". The `/exchange` route that such a client would call still exists (the native SDKs use it), but neither `README.md` nor `MIGRATION.md` tells a cross-origin SPA what to do instead. Worth a decision, or at least a line in `MIGRATION.md`.

---

## 9. Glossary

- **Block (Building Block):** one AWS Blocks component (here `Auth`) that bundles the AWS infrastructure, the runtime code and a local mock behind one API.
- **Block id / `fullId`:** the second constructor argument (`'auth'`) and its scoped full form. AWS resource names come from it, so changing it replaces resources.
- **User pool:** Amazon Cognito's user directory: accounts, passwords, groups, attributes.
- **Cognito:** Amazon's managed sign-in service. `Auth` uses it for every user who has a pool record.
- **IdP (identity provider):** the service that actually checks the user's identity: Google, Okta, Entra ID, your SAML server.
- **OIDC (OpenID Connect):** the standard most IdPs use to tell an app who signed in. OAuth 2.0 is the older layer below it, without a standard identity token (GitHub is OAuth 2.0 only).
- **SAML:** an older enterprise sign-in standard, still common for workforce IdPs.
- **Federation:** letting an outside IdP sign users in to your app. *Direct* federation: your backend talks to the IdP. *Through Cognito*: Cognito talks to the IdP and your app gets Cognito tokens.
- **Hosted UI / managed login:** Cognito's own sign-in web pages. `Auth` uses them only as a pass-through to the IdP for social, SAML and Cognito-federated OIDC sign-in.
- **PKCE:** a one-time secret the app makes for each sign-in, so a stolen sign-in code is useless to anyone else. Lets apps with no client secret sign in safely.
- **Session cookie:** the HTTP-only cookie (`auth_<fullId>`) that identifies a signed-in browser; it points to a session row in DynamoDB.
- **Bearer token:** an access token sent as `Authorization: Bearer …`, used by native and CLI clients instead of a cookie (`allowBearerAuth: true`).
- **Mock:** the local stand-in that runs under `npm run dev` and in tests, with data in `.bb-data/`.
- **Stub IdP:** a fake but real-protocol OIDC provider with an account picker, for offline testing (`stubIdp()`).
- **Enumeration:** finding out which emails have accounts by watching an app's error messages. "Masking" means giving the same answer either way.
- **Mode gate:** a compile-time check that makes a method unusable when the configuration doesn't support it.
- **Baseline:** a committed JSON file recording the pool settings Cognito can't change later, so synth can refuse a change that would fail or delete the pool.
- **Synth:** CDK turning the app into a CloudFormation template (`--conditions=cdk`), before deploy.
- **Preset (`BlocksPresets.production` / `sandbox`):** stack-wide defaults, such as whether data is kept or deleted with the stack.
- **Transferable:** a server value that the client turns back into a live object (a realtime channel, a file handle, an OIDC client).
- **Codegen:** generating the typed Swift, Kotlin or Dart client from the backend's API description.
- **Codemod:** a tool that rewrites source code automatically (`npx @aws-blocks/bb-auth migrate`).
- **Changeset:** a small Markdown file per change that becomes the public changelog entry when packages are released.
- **MAU:** monthly active user, the unit Cognito bills by.
