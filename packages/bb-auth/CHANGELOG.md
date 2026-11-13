# @aws-blocks/bb-auth

## 0.2.0

### Minor Changes

- 5f55dac: A web frontend served from another origin than its API can sign in with a federated provider. `createAuthClient()` from the new `@aws-blocks/bb-auth/browser-client` entry (also exported from `@aws-blocks/blocks/ui`) replaces `AuthOIDC`'s `getClient()` browser client:

  ```typescript
  import { createAuthClient } from "@aws-blocks/bb-auth/browser-client";

  const auth = createAuthClient({
    baseUrl: "https://api.example.com",
    redirectUri: "https://app.example.com/return",
  });
  await auth.signInWithRedirect({ provider: "okta" }); // on the sign-in button
  const result = await auth.handleSignInRedirect(); // on the return page
  const session = await auth.fetchAuthSession(); // { signedIn, user? }
  await auth.signOut();
  ```

  It signs in through the block's existing routes with PKCE and a signed, CSRF-bound `state`. The provider returns to the block's own callback, which sends the one-time code only to a return page on an origin in `redirects.allowedRelayOrigins` (loopback `http://127.0.0.1` is always allowed, for local development). The session stays in the block's `HttpOnly` cookie: no token is stored in JavaScript or put in a URL. The method names follow Amplify JS v6; the user and the error names are the block's own.

  Two of the block's routes back it:

  - `GET /aws-blocks/auth/session` returns the signed-in user (the same fields `getAuthState()` sends) or `401 NotAuthenticatedException`.
  - `POST <signOutPath>?format=json` answers `200 { logoutUrl? }`. Without the parameter it answers `204`, as the native SDKs expect.

  `handleSignInRedirect()` asks the exchange for no bearer tokens (`tokens: false` in the body, honoured with `allowBearerAuth`), so a refresh token never reaches a JavaScript-readable response. It also confirms the session cookie comes back to the API: when it does not (a frontend on another registrable domain without `session.crossDomain: true` or the CORS allowlist, or a browser blocking third-party cookies), it rejects with `InternalErrorException` and a message naming those settings, instead of reporting a user that the next `fetchAuthSession()` calls signed out.

  See the README section "Frontend on a different origin" for the backend settings: `allowedRelayOrigins`, the stack's CORS allowlist, and `session.crossDomain` for different registrable domains.

- 5f55dac: `Auth` can share its user pool with a frontend that signs in directly against Cognito, such as one built with the Amplify client libraries. All three options are opt-in.

  - **`users.caseSensitive`.** Set `false` to match usernames, and the email or phone a user signs in with, ignoring case (Cognito's `UsernameConfiguration.CaseSensitive`, the setting Amplify Gen 2 pools use). Cognito fixes it when the pool is created, so the block refuses a later change at synth and again at deploy. Unset keeps Cognito's default, case-sensitive. The local user pool in `npm run dev` matches names the same way.
  - **`allowBearerAuth: { clientIds }`.** Besides `true`, `allowBearerAuth` takes an object whose `clientIds` lists other app clients of the same pool. The guards then accept the access tokens those clients issue, fully verified (signature, issuer, `token_use: access`, expiry, client). The client id given to `Auth.fromExisting(userPoolId, clientId)` is accepted the same way once `allowBearerAuth` is on. An id can be a literal or a CDK token, such as the app client Amplify Gen 2 creates in the same CDK app: the block forwards the list through its deployed config, so a token resolves at deploy time. The frontend sends the access token, never the ID token (with Amplify JS, `(await fetchAuthSession()).tokens?.accessToken`).
  - **`user.federatedIdentity`.** A federated user carries `{ providerId, sub }`: the provider's key in your options and the provider's own subject for the user. It is the same whether the provider is verified by your backend (`store: 'builtin'`) or federated through Cognito (the default store), so data keyed on it survives moving a provider between the two. It is server-side only and never sent to the browser.

  The README has a section, "Planning to use Amplify client libraries?", covering the pool shape, which store an OIDC provider belongs on, `userSub` (Amplify's `userId`), adding an app client for the Amplify app, and the sign-in hooks. `phase: 'signIn'`, `onSignIn` and `onSignOut` run only for sign-ins that go through the block, and their docs say so.

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

- 5f55dac: The local user pool can check authenticator-app (TOTP) codes as Cognito does. With the new local-only option `totpVerification: 'rfc6238'`, `verifyTotpSetup`, the sign-in TOTP challenge and the mid-sign-in TOTP setup accept only the RFC 6238 code of the user's shared secret (HMAC-SHA-1, 6 digits, 30-second steps, one step of clock skew), so a wrong secret or `otpauth://` URI fails locally instead of only on a deployed pool. The default, `'any'`, accepts any six digits; the AWS runtime ignores the option. An unknown value is an error at construction. As on Cognito, a new `setUpTotp` secret replaces an enrolled authenticator only once `verifyTotpSetup` accepts it, so an abandoned replacement keeps the working one.

  `totpCodeFor(sharedSecret, time?)` from `@aws-blocks/blocks/utils` (also `@aws-blocks/bb-auth/testing`) computes the code an authenticator app would show, so tests answer TOTP setup and challenges without a phone (Node.js only, `node:crypto`, no new dependency). Like the rest of `@aws-blocks/blocks/utils` it has no browser build: Node test suites that run with the browser condition (`tsx -C browser`) still get it, and the browser entries never import it.

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

- 5f55dac: `Auth` has `protect()`, for an API namespace that is deny by default. `auth.protect(scope, 'notesApi', { public: (context) => ({ ...methods }), methods: (context, user) => ({ ...methods }) })` returns an ordinary `ApiNamespace`. For each call to one of its `methods`, the session is checked first, and only then is the `methods` factory called, once, with the signed-in user, typed by the block's options (`AuthenticatedUser<O>`). So nothing in it runs for a signed-out caller, and a forgotten guard, or one called without `await`, can't leave a method open. A signed-out call to any name that isn't a `public` method gets 401 `NotAuthenticatedException`, whether or not the method exists, so the protected methods can't be listed without a session; a signed-in caller gets "method not found" for an unknown name. `public` methods (optional) run as in a plain `ApiNamespace`. A name defined in both is a compile error. With `{ role: 'admin' }` as the last argument, every protected method also requires that group, as `requireRole` does (401 first, then 403 `NotAuthorizedException`); `compute` and every other `ApiNamespace` option go in the same object and are passed on to the namespace. It works the same locally and on AWS, and the frontend calls every method like any other namespace. Existing `ApiNamespace` code is unchanged.

  The OpenRPC spec (`blocks-generate-spec`) describes every method of a `protect()` namespace, public and protected, and warns, naming the namespace, if it can't list them. It also now describes the parameters of a namespace typed through a mapped type, such as one returned by a factory, by name and type, instead of as a single `args` parameter.

  The `Auth` README has a "Protect every method" recipe. The `ApiNamespace` docs and the scaffolded `AGENTS.md` now recommend `auth.protect` for namespaces with signed-in methods, and say that a guard which isn't awaited protects nothing. The templates don't add a floating-promise lint rule: Biome's `noFloatingPromises` doesn't flag an un-awaited `requireAuth` / `requireRole` call, so `protect` is the safeguard.

- 5f55dac: feat(bb-auth): accept a `Secret` as a provider client secret

  A provider's `clientSecret` (and Sign in with Apple's `privateKey`) accepts a string-valued `Secret` (AWS Secrets Manager) as well as an `AppSetting` created with `secret: true`, so a value set with `npm run secret` reaches the provider:

  ```ts
  const googleSecret = new Secret(scope, "google-client-secret", {
    name: "my-app/GOOGLE_CLIENT_SECRET",
    generate: true, // a placeholder value, so the first deploy can register the provider
  });
  new Auth(scope, "auth", {
    providers: {
      google: {
        type: "google",
        clientId: "your-client-id.apps.googleusercontent.com",
        clientSecret: googleSecret,
      },
    },
  });
  ```

  After the first deploy, set the real value with `npm run secret -- set GOOGLE_CLIENT_SECRET --prefix my-app` and deploy again. For a provider that federates through Cognito (social, or `type: 'oidc'` on the default store), the deploy-time provider registration reads the secret from Secrets Manager, with a grant scoped to that secret's ARN (plus `kms:Decrypt` via Secrets Manager). As with any `Secret`, the app's execution role can read it too. A provider of a `store: 'builtin'` block reads it at request time through the `Secret`, and locally from the `Secret`'s local value. A `Secret` with a `schema` is refused by the type. Synth warns (using a new internal flag on the `Secret` CDK construct) when a hosted-UI provider's secret is a stack-managed `Secret` created with no value (no `generate: true`), which would fail the first deploy, and says how to recover. The `SecretRef` and `ProviderSecretRef` types name the accepted references. The `Secret` README describes using a `Secret` as an `Auth` provider secret and setting a named secret with `npm run secret`.

- 5f55dac: `Auth` can send its user pool's email through your own Amazon SES identity, with the `email` option: `email: { fromAddress: 'no-reply@example.com', fromName?, replyTo?, sesRegion?, sesVerifiedDomain?, configurationSetName? }`. Cognito's default sender is capped at 50 emails a day, so set this before real users sign up.

  - **Prerequisites:**
    - `fromAddress` (or `sesVerifiedDomain`) must be a verified SES identity. It defaults to the pool's Region; set `sesRegion` otherwise.
    - New SES accounts start in the sandbox, so request production access before launch.
    - Cognito creates its email service-linked role on the first deploy, so the deploying role needs `iam:CreateServiceLinkedRole`.
  - **It also allows the email factors on a pool `Auth` creates:** email MFA (`mfa.types` including `'EMAIL'`) and `users.preferredChallenge: 'EMAIL_OTP'`. Cognito sends those codes only through SES, so synth refuses them without `email`.
  - **Safe to add to a deployed pool:** the pool is updated in place, and its users, sessions and tokens are unaffected.
  - **Refused at synth with the reason:**
    - on a pool wrapped with `Auth.fromExisting`, whose email configuration belongs to its owner;
    - on a configuration that creates no user pool;
    - for a malformed address or Region;
    - for a `sesVerifiedDomain` that isn't the domain of `fromAddress`.
  - **Local development** (`npm run dev`) delivers codes locally, without SES.

  The migration codemod recommends `email: { fromAddress }` for `preferredChallenge: 'EMAIL_OTP'`, rather than wrapping the pool.

- 5f55dac: feat(bb-auth): a sandbox deployment serves the stub IdP

  `stubIdp()` runs in local development and sandbox deployments only, as `AuthOIDC`'s stub does. `npm run dev` serves it, and so does a sandbox (`npm run sandbox`, CDK context `sandboxMode`): the deployed backend serves the stub IdP under `/aws-blocks/auth/idp/<id>/`, and synth emits a `@aws-blocks/bb-auth:StubIdpDeployed` warning. Synthesizing any other deployment with a `stubIdp()` provider fails, and deployed compute that is not a sandbox (as `getDeploymentType()` reports it from the deployed config) answers its sign-in with an actionable error. To keep the stub for local and sandbox while deploying a real provider elsewhere, select providers by deployment type:

  ```ts
  import { Auth, getDeploymentType, stubIdp } from "@aws-blocks/blocks";

  const corp =
    getDeploymentType() === "production"
      ? ({
          type: "oidc",
          issuer: "https://login.example.com",
          clientId: "my-client-id",
        } as const)
      : stubIdp();

  new Auth(app, "auth", { store: "builtin", providers: { corp } });
  ```

  A sandbox stub signs users in without credentials: anyone who can reach the sandbox can sign in as any of the stub's users, with their claims and groups.

  On AWS the stub's signing keys are derived from the block's session secret, so every Lambda instance publishes the same keys and a token minted by one instance verifies on another. Its issuer is the API Gateway URL (`https://<api-id>.execute-api.<region>.amazonaws.com/<stage>/aws-blocks/auth/idp/<id>`), the same issuer `AuthOIDC`'s deployed stub used, so its users keep their `userId`. Like a real identity provider, it checks the PKCE verifier, client id and redirect URI in constant time. A deployment that is not a sandbox never loads the stub's code.

  `bb-auth migrate` moves an `AuthOIDC` `stubIdp(…)` across unchanged: both blocks limit the stub to local development and sandbox deployments. The codemod also maps old error-constant keys in every form it can see — `typeof AuthBasicErrors.InvalidCode`, `AuthBasicErrors['InvalidCode']` and `const { InvalidCode } = AuthBasicErrors`, through a named import or `import * as blocks from '@aws-blocks/blocks'` alike — to their `AuthErrors` keys, with a `TODO(aws-blocks-auth-migrate)` where a name split in two.

  Migration for a sandbox: restart `npm run sandbox` once after upgrading. Its initial full deploy writes `BLOCKS_DEPLOYMENT_TYPE` into the deployed config; a `cdk watch` hotswap alone does not, and the stub IdP's sign-in answers the actionable error until that full deploy runs.

- 5f55dac: Add auth test helpers to `@aws-blocks/blocks/utils`. Both are Node-only and are not reachable from any browser entry.

  - `getLastAuthCode(username, { block?, purpose?, cwd? })` returns the verification code the local pool sent to a user, for e2e tests of sign-up, password-reset, MFA and attribute-verification flows. It finds the block's data under `.bb-data/` itself, so renaming the scope or the block doesn't break the test. It reads the codes the pool still holds, so a user's code is still found after another user's code was sent. When there is nothing to read, it throws an error that names what each local block last sent. It is also exported from `@aws-blocks/bb-auth/testing`.
  - `createTestClient(clients)` returns the app's typed clients (for example `createTestClient(await import('aws-blocks'))`) with a cookie jar of their own. A test can now act as two users at once, such as an owner and an intruder, without signing out between steps. The shared jar from `installCookieJar()` is never involved.

  To support this, the generated API client (`ApiNamespaceClient`) now sends a call with the `fetch` that the call's async context supplies, when there is one. Nothing changes for an app that doesn't use `createTestClient`.

  `installCookieJar()` now keeps request headers passed as a `Headers` instance or an entry list; it used to send only its `cookie` header for those.

- 5f55dac: A signed-in user can enrol an authenticator app (TOTP) through `auth.createApi()`, with no backend code: `setAuthState` takes `setUpTotp`, `verifyTotpSetup`, `getMfaPreference` and `updateMfaPreference` actions. `setUpTotp` returns a state whose `verifyTotpSetup` action carries the shared secret (`sharedSecret`) and an `otpauth://` URI (`otpauthUri`, the QR code's content) as hidden fields; the other actions return the user's MFA settings, one `updateMfaPreference` action per change they can make. A wrong code is `retriable`; a caller who is not signed in gets the `NotAuthenticatedException` state. Replacing an enrolled authenticator and setting a factor `'DISABLED'` need a recent sign-in (`session.freshAgeSeconds`); a stale session gets the `ReauthenticationRequiredException` state, so a stolen session cookie cannot swap the authenticator or turn MFA off. The actions follow the block's options, in the frontend too: `setUpTotp` / `verifyTotpSetup` need `mfa` on with `'TOTP'` in `mfa.types` (`TotpEnabled<O>`), the preference actions need `mfa` on and take only the factors in `mfa.types`; untyped callers get `MfaNotEnabledException` or `InvalidParameterException`. The new `mfa.totpIssuer` option sets the issuer authenticator apps show (default: the root `Scope` id).

  `MfaSettings(authApi, options?)` (from `@aws-blocks/blocks/ui`, `@aws-blocks/bb-auth/ui` or `@aws-blocks/auth-common/ui`) is the enrolment panel for an account page: the setup key, an `otpauth://` link and, with `renderQrCode`, a QR code from the library of your choice, then the code form and the preference buttons, each a `<form>` with stable `mfa-settings-*` test hooks. It leaves the shared auth-state store alone, so a mounted `Authenticator` is unaffected; the `Authenticator`'s signed-in card does not change.

  Native clients: the `setAuthState` input union gains the four actions (additive). Code that matches exhaustively over that input needs the new cases: an exhaustive Swift `switch` over the `Input` enum, a Kotlin `when` over the sealed input class used as an expression, and a Dart `switch` over the sealed input class.

  Dev-server logs redact `otpauth` fields (`otpauthUri` embeds the TOTP secret).

- 5f55dac: Add `Auth` (`@aws-blocks/bb-auth`), the single authentication Building Block, exported from `@aws-blocks/blocks`. One options object configures email + password (backed by a Cognito user pool, with MFA, passkeys, groups and `requireRole`), social and SAML sign-in federated through Cognito, and OIDC / OAuth 2.0 providers verified by your backend (`store: 'builtin'`) — no user pool needed. Methods your configuration doesn't support don't compile. Everything runs locally with no AWS account, and `stubIdp()` gives you an offline identity provider for development.

  ```ts
  import { Auth, Scope } from "@aws-blocks/blocks";

  const scope = new Scope("app");
  const auth = new Auth(scope, "auth"); // email + password
  export const authApi = auth.createApi();
  ```

  `Auth` replaces `AuthBasic`, `AuthCognito` and `AuthOIDC`. An `AuthCognito` app that switches to `Auth` with the same block id keeps its user pool, its users and their sessions. See `MIGRATION.md` in `@aws-blocks/bb-auth` for the per-block steps and the `npx @aws-blocks/bb-auth migrate` codemod.

  `@aws-blocks/blocks` now also exports `AuthErrors`, `isAuthError`, the provider helpers `github()`, `customOauth2()`, `stubIdp()` and `relayOrigin()`, and every `Auth` type, and `@aws-blocks/blocks/ui` adds `Auth`'s typed UI helpers (`authOverrides`, `AuthActionName`, …). `getSdkIdentifiers(auth)` returns the user pool's `{ userPoolId, clientId }` (optional fields: an `Auth` with no user pool registers none).

  **Breaking:** these names exported from `@aws-blocks/blocks` now refer to `Auth`'s versions instead of the old blocks': `stubIdp`, `github`, `customOauth2`, `relayOrigin`, `RelayOrigin`, `MappedClaims` (were `AuthOIDC`'s), `PasswordPolicy` (was `AuthBasic`'s), and `AdminAction`, `AdminActionGate`, `AdminCreateInit`, `AdminDisabled`, `AdminGetterOf`, `AdminGrants`, `AdminOptions`, `AdminSurface`, `AdminUser`, `AdminUserFilter`, `CodeDeliveryDetails`, `CodeDeliveryFn`, `ConfirmSignInOptions`, `DeviceRecord`, `ExternalUserPoolRef`, `GroupAdmin`, `LifecycleAdmin`, `ResetPasswordResult`, `SetPasswordOptions`, `SignInNextStep`, `SignInOptions`, `SignInResult`, `SignUpOptions`, `SignUpResult`, `UpdateAttributeOutcome`, `UserAttribute` (were `AuthCognito`'s). Move to `Auth`'s versions: the old blocks and their packages are removed in this release (see `MIGRATION.md`).

- 5f55dac: Add `npx @aws-blocks/bb-auth users`, a supported way to make the first admin. `users add-to-group <user> <group>` puts a user into one of the groups the `Auth` block declares in `users.groups`; `remove-from-group` and `list-groups` are also available.

  ```sh
  npx @aws-blocks/bb-auth users add-to-group you@example.com admin                    # the local pool in .bb-data/
  npx @aws-blocks/bb-auth users add-to-group you@example.com admin --stage prod --yes # the deployed pool
  ```

  - Without `--stage` or `--stack`, the command edits the local pool. It refuses while the dev server is running, because the server would write its in-memory copy back over the change.
  - With `--stage sandbox|prod` (or `--stack <name>`), it calls Cognito on the pool the block owns in that stack, using your AWS credentials (`--profile`, `--region`). It finds the pool and its groups in the stack's template.
  - It refuses a group the block doesn't declare, a user the pool doesn't have, and an email or phone number the pool hasn't verified. It also refuses a value that is one user's username and another user's verified email (anyone can register the username `boss@example.com` on a pool that signs in with usernames). `--username <name>` and `--email <address>` name the user outright.
  - On a deployed stage it prints the AWS account and Region your credentials point at with the pool, so a wrong `--profile` shows before `--yes`.
  - Every write to a deployed pool needs `--yes`. Without it, the command checks everything, prints what it would do, and changes nothing.

  The README's first-admin recipe uses the command, with the `onSignIn` recipe as an alternative, with its security notes.

- 5f55dac: feat(bb-auth): `validateUser` also guards users created outside your app, through a Cognito PreSignUp trigger

  When you set `validateUser` and `Auth` creates the user pool, the pool gets a Cognito PreSignUp trigger that runs your `validateUser` in your backend Lambda. It checks every user Cognito is about to create, including the ones your app never sees: a `SignUp` sent straight to Cognito with the app client id, an `AdminCreateUser` from the console or CLI, and the first sign-in of a social, SAML or Cognito-federated OIDC user (a `providers` entry on the default store).

  - `auth.signUp()` runs `validateUser` first, in your request, and the trigger recognises that sign-up, so the check runs once. `auth.admin.createUser()` runs it too (`phase: 'signUp'`, `provider: 'password'`).
  - A rejection in the trigger reaches the client with the same `AuthErrors` name and message you threw, masked the same way as in-process. The trigger never confirms or verifies a user.
  - Without `validateUser`, no trigger is added. Adding or removing the option later updates the pool in place. On a pool wrapped with `userPool: Auth.fromExisting(...)`, no trigger is attached and synth warns.
  - Cognito waits at most 5 seconds for the trigger, and a cold start of your Lambda counts, so keep `validateUser` fast.

- fc57730: The `session-secret` (the HMAC key that signs session cookies and sign-in challenges) now follows `defaults.secretsStore`. Sandbox stacks keep the SSM SecureString, and their template does not change.

  **Behavior change for production stacks, including apps switching from `AuthCognito`:** with `BlocksPresets.production`, the key moves to a new Secrets Manager secret with a new value, so every signed-in user is signed out once and sign-ins in progress start again. Users and passwords are not affected. To keep existing sessions, set `secretsStore: 'ssm'` in `defaults` before you deploy this version; synth then emits the `@aws-blocks/bb-secret:SsmSecretsStoreOutsideSandbox` warning.

### Patch Changes

- 6eba38b: fix(bb-auth): never serve the `auth.admin` handle over RPC

  The `auth.admin` handle now carries its block's identity, so the RPC dispatcher
  treats it like a Building Block instance: exporting it, or returning it from an
  `ApiNamespace` handler, answers _method not found_. Methods you write that call
  `auth.admin` work as before and still need their own caller check.

- 5f55dac: `admin.scan` checks its filter before it reaches Cognito's `ListUsers`, in the local pool and on AWS alike: the attribute must be one Cognito can search on (`username`, `email`, `phone_number`, `name`, `given_name`, `family_name`, `preferred_username`, `cognito:user_status`, `status` or `sub`), and a value containing a double quote, a backslash or a control character is refused with `InvalidParameterException` (400). Cognito does not honour the `\"` escape its reference documents (against a real user pool, an escaped quote still ends the value and the rest runs as filter syntax), and it documents no escape for a backslash. The filter is checked once, when `scan` is called, and the pages are fetched with that checked copy, so changing the filter object afterwards has no effect. A filter longer than Cognito's 256-character limit is refused the same way, and the local pool filters `status` and `cognito:user_status` on each account's state, as Cognito does.
- 5f55dac: `Auth` gives the same error for the same invalid sign-up or attribute update under `npm run dev` and on AWS.

  - On a pool with `emailPassword: { selfSignUp: false }`, `signUp` always fails with `401 NotAuthorizedException`, whatever attributes it was sent, and on AWS makes no Amazon Cognito call.
  - When one write to `signUp`, `updateUserAttributes`, `admin.createUser` or the new-password step of `confirmSignIn` breaks several attribute rules, both runtimes report the same one, whatever order the attributes are in: a value that isn't a string, then a value longer than 2,048 characters (both `400 InvalidParameterException`), then `email_verified` / `phone_number_verified` set through a client call (`401 NotAuthorizedException`), then an attribute your user pool doesn't have, `sub`, or an immutable attribute (`400 InvalidParameterException`). For example, `{ 'custom:undeclared': 'x', email_verified: 'true' }` on `signUp` is `401 NotAuthorizedException` on both.

- 5f55dac: The `Authenticator` renders each action as a `<form>`, so browsers and password managers see the username and password fields together (Chrome no longer warns that the password inputs are not in a form). Enter in any field or a click on the button submits it once, and it never reloads the page; native validation is off, so the server's error is the one shown. Inputs carry `autocomplete` hints by default: `username`, `current-password` (`new-password` on sign-up and for a new password), `one-time-code` for codes, `email` for an email field and `tel` for `phone_number`. A field override's `autocomplete` still wins. Because each action is a form, a `<button>` without a `type` inside a field's `render` override now submits the action (the HTML default, `type="submit"`); give a button that should not submit `type="button"`. The `data-testid` hooks are unchanged; `authenticator-action-<action>` is now the `<form>` element.
- 5f55dac: On AWS, `Auth` checks user-attribute values itself before it calls Amazon Cognito, so a client that sends a value that isn't a string gets the same `400 InvalidParameterException` it gets under `npm run dev`. A JSON-RPC or native client can send any JSON, and the AWS SDK passes a number, boolean, object, array or `null` to Cognito as-is, which Cognito answers with `500 InternalErrorException`. `signUp`, `updateUserAttributes`, `admin.createUser` and the new-password step of `confirmSignIn` apply these rules first, and a rejected write makes no Cognito call: the value must be a string of at most 2,048 characters (`InvalidParameterException`), `sub` can't be written (`InvalidParameterException`), and `email_verified` / `phone_number_verified` can't be set through `signUp`, `updateUserAttributes` or `confirmSignIn` (`NotAuthorizedException`). `admin.createUser` can set them. Cognito checks attribute names and immutable attributes against your deployed user pool.
- 5f55dac: When synth refuses a change against the user-pool immutability baseline, the error names the case it cannot tell apart from a deployed change: one that was synthesized but never deployed. The baseline is rewritten on every passing synth, not after a deploy. So if you synthesize a new custom attribute or `users.caseSensitive` setting and then undo it, synth refuses the undo even though no pool ever had the setting.

  - For a change to a user-pool property Cognito cannot change, the error lists what is wrong, then gives the re-baseline command for a change that was never deployed (`If this was never deployed, re-baseline: BLOCKS_AUTH_REBASELINE=<fullId> …`), then the revert advice for a deployed pool.
  - For a change that removes the user pool, the error starts with the danger: if the pool was ever deployed, the next deploy deletes it and every user in it, and nothing at deploy time stops that. It then tells you to check your deployed stack, and only after that gives the re-baseline command for a pool that was never deployed.

- 5f55dac: `Auth` checks the values of its boolean options at construction, in `npm run dev`, at synth and in Lambda alike. A non-boolean `selfSignUp` is rejected at construction, so `emailPassword: { selfSignUp: 0 }` from untyped code can't turn self-service sign-up **on** (only `false` disables it). The same applies to every other boolean option (`autoSignIn`, `revealExistingUsers`, the `passwordPolicy.require*` flags, `deletionProtection`, `session.crossDomain`, `users.deviceTracking`, `users.attributes[].mutable` / `required`, `users.caseSensitive`, and a SAML provider's `signRequest`), and `emailPassword`, `passkeys` and `allowBearerAuth` must be a boolean or an options object. The error names each option and the value it got, for example ``- `emailPassword.selfSignUp` must be `true` or `false`, got the number 0``. TypeScript code that compiles is unaffected.
- 5f55dac: A federated sign-in callback checks `state` before it shows an error. Error callbacks (`error`, `error_description`) are honoured only when they carry the `state` of the sign-in in progress, so a crafted link to `/aws-blocks/auth/callback` can't make your app answer with an error name, status or message of an attacker's choosing while a user signs in with a social, SAML or OIDC provider. Anything else gets the same `InvalidStateException` as a forged success callback. Genuine provider errors, including `validateUser` rejections on a first federated sign-in, are reported to the user.
- 5f55dac: Auth broadcasts are tagged per API, so `onAuthChange` for one API no longer receives another API's user. With two auth blocks on one page, signing in to one no longer hands its user to the other's listener (typed as the other's user), in this window or in another tab, and the other block's store no longer refetches.

  `submitAuthAction` tags its sign-in and sign-out messages with the RPC namespace of the API it ran on (a generated client now answers `Symbol.for('aws-blocks.apiNamespace')` with it), and `broadcastAuthChange(user, api)` takes an optional `api` to do the same. An untagged message still reaches every API's listeners: `broadcastAuthChange(user)` without an `api`, and a message from a tab running an older `@aws-blocks/auth-common`. An API that is not a generated client (a hand-written `AuthStateApi`) has no namespace: `submitAuthAction` on it sends untagged broadcasts, and its listeners and store receive every message, tagged or untagged. The message format (the `blocks-auth` channel and the `blocks-auth-change` window event, `{ type: 'auth-change', user }`) only gains the optional `api` field, so tabs running an older bundle keep working.

- 5f55dac: Federated sign-in callbacks compare the returned `state`, and the ID token's `nonce`, in constant time, so response timing reveals nothing about a guessed value. A `state` or `nonce` of the wrong length or encoding is rejected with the usual `InvalidStateException` or `IdpErrorException`.
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

- 5f55dac: `Auth` warns at synth when a block's first baseline records no user pool of its own (a configuration without a pool-backed sign-in method, or `userPool: Auth.fromExisting(…)`). An app moving from `AuthCognito` has no baseline yet, so its first `Auth` synth can't refuse a configuration that drops the pool. If the stack already had a pool for that block, the deploy deletes it and every user in it, unless the pool was already deployed with `removalPolicy: 'retain'`. The warning (`@aws-blocks/bb-auth:FirstBaselineWithoutPool`) says so and points to `MIGRATION.md`.

  `MIGRATION.md` starts its checklist with the safe order. First deploy the codemod's output unchanged and commit the baseline it writes. Change the configuration only after that, because from then on synth refuses a change that would remove the pool. For `preferredChallenge: 'EMAIL_OTP'`, the guide and the codemod's TODO and summary warn against wrapping the block's own pool with `Auth.fromExisting`, which deletes it. `DESIGN.md` explains what the deploy-time guard does not cover, and recommends committing baselines from your deploy workflow.

- 5f55dac: Hardening:

  - `Auth`: when account state is hidden (the default), the answers `Auth` withholds from the client on `resendSignUpCode`, `resetPassword`, `confirmSignUp` and `confirmResetPassword` (for example a malformed username, or an expired code reported as a wrong code) are logged at `warn`, so you can see them with a `warn`-level logger. The username is redacted from the logged Cognito message.
  - `Auth`: the "already validated" marker that lets the PreSignUp trigger skip a second `validateUser` call is signed with its own key, derived from the session secret, never with the session secret itself.

- 5f55dac: `Auth` doesn't reveal whether an account exists, or whether it is already confirmed, on the steps after the sign-up form. With `emailPassword.revealExistingUsers` off (the default), an unknown user, an unconfirmed user and an already-confirmed user get identical answers from `confirmSignUp` (the wrong-code error, also for an expired code), `resendSignUpCode` (a silent success; a confirmed user is not sent a code), `resetPassword` (the same delivery details) and `confirmResetPassword` (the wrong-code error). This applies through the sign-in UI and when you call these methods directly. (`AuthCognito` passed Cognito's distinct errors through, so confirming or resending a code for an already-confirmed account let anyone check which accounts exist; an app moving to `Auth` gets the masked answers.) Set `revealExistingUsers: true` to get the informative errors.

  The local runtime answers these steps the way Cognito does. Confirming an already-confirmed user fails, and resending a sign-up code to one sends nothing. A password reset for an unconfirmed or disabled user sends no code. A `USER_AUTH` sign-in for an unknown user gets a first-factor challenge that no answer can pass.

- 5f55dac: `requireAuth().attributes` and `getCurrentUser().attributes` hold the ID token's string claims, the same locally and on AWS, so they don't include `updated_at` or `address`. Amazon Cognito's ID token carries `updated_at` as a number and `address` as an object (`{ formatted }`). `AuthCognito`'s mock reported both as strings there, which a deployed app never saw. The local ID token (`getAuthSession`) and the `claims` passed to `validateUser` carry them in Cognito's shapes. To read either as a string, call `auth.getUserAttributes(context)`, which returns them the same way on both.

  The sign-in UI's `displayName` reads whether an email or phone number is verified from the session's ID token, the same way on both, so it skips an unverified email or phone number. That covers an email the user changed with `updateUserAttributes` and hasn't confirmed yet, once the session's tokens are refreshed. It works the same for a user who signs in directly with an OIDC provider that marks their email unverified, whether the provider sends `email_verified` as a boolean or as a string.

- 5f55dac: A failed federated sign-in never shows the identity provider's own error text to the user.

  When a social, SAML or OIDC provider sends your app back to `/aws-blocks/auth/callback` with an error, the provider's `error` and `error_description` are written by the provider (or by Cognito managed login), and they can quote the request, echo the user's login or name an internal endpoint. So the `IdpErrorException` message — the string the `<Authenticator>` renders — is one fixed message, `The identity provider '<id>' refused the sign-in.`, and the provider's text goes to the server log instead: at `info` for an ordinary refusal such as `access_denied`, and at `error` when the provider reports a fault or its text names AWS resources. The error `name` is `IdpErrorException`, so code matching errors with `isAuthError` works as usual.

  The native / CLI relay is the deliberate exception: there the callback is an OAuth redirect handed back to the app that started the sign-in, so `error` and `error_description` are forwarded to it as the OAuth spec defines, and nothing is rendered to a browser. Server log lines that carry an error message redact the user's login in every case, including errors `Auth` reports as an internal error.

- 5f55dac: `bb-auth migrate` leaves code alone when a name only matches a built-in `Object` member. A string literal such as `'constructor'` or `'toString'`, a call such as `auth.toString()`, and a `cognitoFederated({ identityProvider: 'constructor' })` provider are kept as written.

  A file that both imports and re-exports an old name, such as `import { AuthCognito } …` next to `export { AuthCognito } from '@aws-blocks/bb-auth-cognito'`, keeps the re-export: it is rewritten to `export { Auth } from '@aws-blocks/bb-auth'`.

- 5f55dac: What `bb-auth migrate` does with imports:

  - `@aws-blocks/bb-auth-cognito/ui` imports move to `@aws-blocks/bb-auth/ui`, and their names are renamed to `Auth`'s (`cognitoOverrides` → `authOverrides`, `CognitoActionName` → `AuthActionName`, `CognitoNextStepName` → `AuthNextStepName`, `CognitoActionFields` → `AuthActionFields`, `CognitoActionOverride` → `AuthTypedActionOverride`, `CognitoAuthenticatorOptions` → `AuthTypedAuthenticatorOptions`) along with every place they're used.
  - Names imported from `@aws-blocks/bb-auth-oidc/client` or `/middleware` that `@aws-blocks/bb-auth` also exports move there. The rest (`AuthOIDCClient`, `handle401`, …) stay where they are, with a TODO that names them.
  - `import * as blocks from '@aws-blocks/blocks'` is followed: `new blocks.AuthCognito(…)`, `blocks.AuthCognitoErrors`, `blocks.CognitoUser` and the other old names are rewritten, the options are mapped, and the block id is never changed.
  - Old imports that end up on the same module are merged into one import.
  - An import whose name list would end up empty is left as it is, with a TODO, and the summary lists the file under "needs attention" instead of with the rewritten files.

- 5f55dac: `bb-auth migrate` keeps two old defaults that `Auth` changed, so a migrated app behaves as before:

  - **`AuthCognito` sign-up.** `AuthCognito`'s `signUp()` didn't sign the user in after `confirmSignUp()` unless it passed `autoSignIn: true`. `Auth`'s `emailPassword.autoSignIn` defaults to `true`. Unless the app uses `createApi()` (whose sign-in UI turned auto sign-in on) or `signUp(…, { autoSignIn: true })`, the codemod writes `emailPassword: { autoSignIn: false }`, so `confirmSignUp()` keeps returning `DONE`. If the app does use them, `Auth`'s default stays, and each `signUp()` with a context that relied on the old `false` gets a TODO: `confirmSignUp()` now returns `COMPLETE_AUTO_SIGN_IN` there.
  - **`AuthBasic` session length.** Without `sessionDuration`, `AuthBasic` sessions lasted 24 hours; `Auth`'s last 400 days. The codemod writes `session: { ttlSeconds: 86_400 }`.

  For options passed by variable or spread in, it leaves a TODO to add these instead.

  It also leaves a TODO on the string literals `'SessionRevokedException'`, `'SignOutIncompleteException'` and `'AccountLockedException'`, which `Auth` never returns, and marks error checks on them for review. `MIGRATION.md` documents all of this, notes that `AuthBasic` error-name string literals are rewritten project-wide, and lists the "after it runs" steps in the same order as the codemod's summary.

  `bb-auth migrate` parses its arguments with Node's `parseArgs`. `--` ends the options, and `--help` together with an unknown option exits 2.

- 5f55dac: fix(bb-auth): the local user pool keeps an email / phone unique, as Cognito does

  The local pool follows Cognito's rules, so code that works under `npm run dev`
  behaves the same when deployed:

  - With sign-in aliases (`users.signInWith` with `'username'`, the default), an email
    or phone can be verified on one account only. A second user can still sign up
    with it, but `confirmSignUp` with the right code answers `AliasExistsException`
    (400) and leaves that user unconfirmed. `admin.createUser` answers
    `AliasExistsException` when it marks such an email / phone verified. If a signed-in
    user changes their email to one another account has verified and confirms it with
    `confirmUserAttribute`, the email moves to them and is unverified on the other
    account.
  - When users sign in with their email / phone instead of a username (`signInWith`
    without `'username'`), `updateUserAttributes` to an email / phone another user
    already has answers `AliasExistsException`.

  `AliasExistsException` from `confirmSignUp` is not hidden by
  `revealExistingUsers: false`: only someone who received the code sent to that email
  or phone can get it.

- 5f55dac: Under `npm run dev`, `Auth` checks user attributes against your user pool's schema, as Amazon Cognito does on AWS, so an invalid write fails locally instead of only after you deploy. (`AuthCognito`'s mock stored any attribute it was sent.) `signUp`, `updateUserAttributes` and `admin.createUser` fail with `InvalidParameterException` for an attribute that is neither a standard attribute nor declared in `users.attributes`, a value that isn't a string, or a value longer than 2,048 characters. Updating a custom attribute declared `mutable: false` also fails with `InvalidParameterException`. Setting `email_verified` or `phone_number_verified` through `signUp` or `updateUserAttributes` fails with `NotAuthorizedException`; `admin.createUser` can set them. To store a custom attribute, declare it in `users: { attributes: [{ name: 'team' }] }`, then write it as `team` or `custom:team`.

  A local password reset sends its code the way Cognito does: to a verified phone number first, then to a verified email address, but never to the contact the user has chosen as their preferred MFA factor. A user with no verified contact gets no code. Like any account Cognito can't reset, they get the usual masked "code sent" answer (or `InvalidParameterException` when `emailPassword.revealExistingUsers` is on). `AuthCognito`'s mock sent the code to the email address if the user had one, otherwise the phone number, whether or not it was verified.

- 5f55dac: Under `npm run dev`, confirming a sign-up verifies only the contact the confirmation code was sent to, as Amazon Cognito does: the phone number when the pool auto-verifies phone numbers and the user gave one, otherwise the email address. (`AuthCognito`'s mock marked both the email and the phone number verified.) The default pool (`signInWith: ['username', 'email']`) auto-verifies email only, so a user who signs up with an email and a phone number has an unverified phone number, locally and on AWS.

  This shows up in the display name, in which one-time-code sign-in options (`EMAIL_OTP` / `SMS_OTP`) are offered, in SMS and email MFA, and in `getMfaPreference`. To use the other contact, verify it after sign-in with `auth.sendUserAttributeVerificationCode(context, 'phone_number')` and `auth.confirmUserAttribute(context, 'phone_number', code)`, which work the same locally and on AWS.

- 5f55dac: `requireAuth().attributes` and `getCurrentUser().attributes` don't include `email_verified` or `phone_number_verified`, locally or on AWS. Amazon Cognito's ID token carries these flags as booleans rather than string attributes, so a deployed app never sees them there. `AuthCognito`'s mock reported them as `'true'` / `'false'` strings, so code that read them worked only under `npm run dev`. To check whether a user's email or phone number is verified, call `auth.getUserAttributes(context)`, which returns them as `'true'` / `'false'` on both. The local ID token (`getAuthSession`) and the `claims` passed to `validateUser` carry these flags as booleans, as Cognito's do.
- 5f55dac: A misspelled `Auth` option suggests the key under the same parent first: `mfa: { type: ['TOTP'] }` suggests `mfa.types` rather than the unrelated `users.attributes[].type`, and likewise for `users.attributes[].types`, `allowBearerAuth.clientId` and `providers.<id>.clientIds`. A key with no close sibling still points to where it belongs (`mfa.groups` → `users.groups`).
- 5f55dac: `Auth` rejects `emailPassword: false` combined with `mfa` (other than `'off'`), `passkeys` or `users.deviceTracking` when you construct it, in `npm run dev`, at synth and in Lambda alike: these options apply only to email + password users, and federated users get MFA and passkeys from their identity provider. The error names each conflicting option and `emailPassword: false`, for example ``Auth 'auth': `mfa: 'required'` needs email + password sign-in, which `emailPassword: false` disables.`` `passkeys` without `users.authFlow: 'USER_AUTH'` is refused the same way at construction, as well as at synth, so `npm run dev` and Lambda reject a passkey configuration the pool cannot serve. The README quotes the exact compiler error for a gated call, and recommends keeping options in a variable declared `as const satisfies AuthOptions` (plain `satisfies AuthOptions` widens declared `users.groups` to `string[]`).
- 5f55dac: Only the `Auth` block that owns a user pool's PreSignUp trigger answers it. So when one `Auth` creates a pool with `validateUser` and another wraps that pool with `userPool: Auth.fromExisting(…)` (for example, to use `admin`), the second block can't take over the trigger, and `validateUser` still runs for sign-ups made directly against Cognito.

  Two `Auth` blocks claiming one user pool's PreSignUp trigger fail `cdk synth`, naming the event key and both blocks, like other Building Blocks that would handle the same Lambda event.

- 5f55dac: `Auth`'s deploy-time Lambdas (the user-pool guard and, with social, SAML or Cognito-federated providers, the identity-provider registration) leave no log groups behind after the stack is destroyed. Their roles can't create log groups. They log only to the groups the stack owns, so a last log line written after CloudFormation deleted a group is dropped instead of recreating the group outside the stack.
- 5f55dac: The `Auth` README has a "Recipes" section of complete, compile-checked snippets: MFA with an authenticator app (config, TOTP enrolment through `setUpTotp` / `verifyTotpSetup`, and the challenge the `Authenticator` handles), roles and an admin-only user list (`users.groups`, `requireRole`, `admin: {}`, `auth.admin.scan()`), the first admin (an `onSignIn` hook that calls `auth.admin.addUserToGroup` for an allowlisted email the pool has verified, read with `auth.admin.getUser`, since `user.attributes.email` alone does not prove ownership), and social sign-in (setting the client secret's SSM value and registering the Cognito callback URL). `@aws-blocks/bb-auth` ships its `API.md`.
- 5f55dac: `Auth` rejects options it doesn't recognise, so a misspelled or misplaced setting is never silently ignored. TypeScript does no excess-property check on `Auth`'s inferred options type, so `{ emailPasword: false, session: { … } }` or a top-level `preferredChallenge` (it belongs under `users`) would compile and then have no effect. The constructor checks the options at every nesting level, the same way in `npm run dev`, at synth and in Lambda. It throws an error naming each unknown option's path and the likely intended one:

  ```text
  Auth 'auth': unknown options:
    - `emailPasword`: did you mean `emailPassword`?
    - `preferredChallenge`: it is not an option here; did you mean `users.preferredChallenge`?
  ```

  Provider ids (the keys of `providers`) are yours to choose and are never checked; the settings inside each provider are.

- 5f55dac: `relayOrigin()`'s `RelayConfigError` keeps its name when it crosses the wire, and sign-in failures from an identity provider never carry the provider's raw text.

  `relayOrigin()` rejects a bad `allowedRelayOrigins` entry with a `RelayConfigError`. That error is branded as an intentional Building Block error (as `AuthOIDC`'s was), so `isBlocksError(e, 'RelayConfigError')` matches on the client instead of the error collapsing to a nameless 500. Its message names only your own entry, so forwarding it leaks nothing.

  The engine that verifies a `store: 'builtin'` block's providers keeps a failing provider's response body and a failing client-secret resolver's error off the wire, on a non-enumerable `cause`; tests cover the code exchange, a 5xx token endpoint, a refresh grant and a secret resolver that throws with a role ARN.

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

- 5f55dac: A password reset signs the user out everywhere. Once `confirmResetPassword` (or the `confirmResetPassword` action of `createApi()`) succeeds, every session the user had is rejected from the next request on with 401 `NotAuthenticatedException` and its cookie is cleared, locally and on AWS. A session stolen before the reset doesn't authenticate after it. The user signs in again with the new password.

  - On AWS the reset also revokes the user's Cognito refresh tokens (`AdminUserGlobalSignOut`), so an Amplify or native client calling the API with bearer tokens can't refresh. An access token it already holds stays valid until it expires.
  - The block's role has `cognito-idp:AdminGetUser` and `cognito-idp:AdminUserGlobalSignOut` on its user pool, only when email + password sign-in is on. Neither needs `admin`.
  - Each request with a password session makes one extra read of the sessions table. Session rows carry an optional `issuedAt` field.
  - If the password changed but ending the sessions failed, `confirmResetPassword` throws a 5xx (logged at error), never a wrong-code error. Reset again to end them.
  - `updatePassword` and `auth.admin.setUserPassword` leave other sessions signed in. Call `auth.admin.revokeUserSessions(username)` to end them.

- 5f55dac: feat(bb-auth): same-origin landing paths after sign-in and sign-out, checked against open redirects

  `Auth` sends a user back to your app after federated sign-in (`GET /aws-blocks/auth/signin/<provider>?redirectPath=…`, or `getSignInUrl(…, { redirectPath })`) and after sign-out. Every landing path (`redirectPath`, `redirects.postSignInPath` and `redirects.postSignOutPath`) goes through one check, so a sign-in link on your domain can't send users to another site — including with paths browsers rewrite, such as `/%09/evil.example.com` (a TAB that the browser strips from the `Location` header). A path is accepted only if it starts with a single `/`, contains no control characters (TAB, CR, LF, NUL, DEL) and no backslash, and still resolves to your app's origin after URL parsing, including after dot segments like `/.//` collapse. The redirect always uses that normalised path (path, query and hash), never the raw string. The sign-in route answers an unsafe `redirectPath` with `400` (`InvalidParameter`). An unsafe `postSignInPath` or `postSignOutPath` fails at construction. If a pending sign-in cookie carries an unsafe path, the callback re-checks it and lands on `postSignInPath`. Legitimate paths work, with any query and fragment kept.

  `stubIdp()` providers run in local development and sandbox deployments only: synthesizing any other deployment with one fails (see the `stubIdp()` changeset). Local development (`npm run dev`) always serves the stub. If the same backend module is also deployed to production, select providers with `getDeploymentType()`.

- 5f55dac: `Auth` decides whether its cookies are `Secure` from deploy configuration, never from a request header. It drops `Secure` for a loopback request only when the process itself is local, as reported by `getDeploymentType()`, and behind a plain-HTTP front door (`BLOCKS_PUBLIC_ORIGIN` starting with `http://`). So on a deployed stack, a request that sends `Origin: http://localhost` (or a loopback `Host`) still gets its session, auto-sign-in and pending federated sign-in cookies with `Secure`, and with `crossDomain: true` with `Partitioned`. The local dev server (`npm run dev`) drops `Secure` for its loopback requests. A sandbox (`npm run sandbox`) proxies the API to deployed compute, so its cookies keep `Secure` (and `Partitioned` with `crossDomain: true`) even though the page is on `http://localhost`. The local mock and AWS runtimes share this code path.
- 5f55dac: `Auth` refreshes a session consistently when requests overlap, and reports a sign-out that could not invalidate the server-side session.

  - **Session refresh.** Several requests can refresh one session at once (parallel calls when its access token expires, possibly on different Lambda instances), and `signOut()` can delete it mid-refresh. Both refresh writes are now conditional on the session row the request read. A refresh that completes after `signOut()` no longer restores the session: nothing is written and the cookie is cleared. A request whose own refresh is rejected, or whose write loses to a concurrent refresh, is served the session that refresh wrote, instead of deleting or overwriting it.
  - **Sign-out.** `signOut()` clears the session cookie first, so the device is signed out whatever happens next. If the session row can't then be deleted (a transient session-store failure), or the session secret can't be resolved to identify it, it reports the new `AuthErrors.SignOutIncomplete` (`SignOutIncompleteException`, 503) instead of success, because a copy of the cookie keeps authenticating until the session ends on its own: `auth.signOut(ctx)` rejects with it, `setAuthState({ action: 'signOut' })` returns a signed-out state with `errorName: 'SignOutIncompleteException'`, and `POST /aws-blocks/auth/signout` answers `503 { error, name }` to an API client (a browser form still lands on `postSignOutPath`). The browser redirect client's `signOut()` rejects with that `ApiError`. A failed session read no longer stops the delete; it only skips `onSignOut` and the upstream sign-out. The store error is logged server-side, never sent.
  - `@aws-blocks/auth-common` adds `SignOutIncomplete` to `AuthErrors`.

- 5f55dac: `Auth`'s sign-in results carry only the steps the configuration can produce. `signIn`, `confirmSignIn` and `autoSignIn` return `SignInResult<O>`, whose `nextStep` is `SignInNextStep<O>`: the MFA steps need `mfa` on, and each factor's steps need that factor in `mfa.types`; `CONFIRM_SIGN_IN_WITH_WEB_AUTHN` needs `passkeys`; the first-factor steps need `users.authFlow: 'USER_AUTH'`. With `mfa: 'off'` and no passkeys, a `switch` on `nextStep.name` handles three steps rather than fifteen. Every step is kept for a pool wrapped with `Auth.fromExisting`, for settings the compiler cannot see, and in the plain `SignInNextStep` type. Native clients get every step whatever the options.

  Two compile errors name their cause: calling an `auth.admin` method without `admin` in the options reports the missing `ERROR_admin_is_not_enabled__construct_Auth_with_admin_options` argument, and passing `updateMfaPreference` a factor that `mfa.types` leaves out reports `ERROR_SMS_is_not_in_mfa_types` (or `TOTP` / `EMAIL`).

- 5f55dac: `signIn`, `confirmSignIn` and `autoSignIn` check each step against the block's options at runtime, as `SignInNextStep<O>` does at compile time. A step the options do not enable means the user pool was configured outside the block (the console, another stack, a deploy half-way): the call fails with `InternalErrorException` naming the step, and the server log lists the step and the configured ones, rather than returning a step the caller's narrowed type says cannot happen. A pool wrapped with `Auth.fromExisting` passes every step.

  In `npm run dev`, the local pool offers only the factors `mfa.types` lists, even to a user who enrolled in one while it was listed, as Cognito does.

  Native clients get every sign-in step, every MFA factor in `getMfaPreference` / `updateMfaPreference`, and each block's own user schema, whatever the options.

- 5f55dac: fix(bb-auth): the stub IdP accepts only its registered client and redirect URIs

  The `stubIdp()` provider's authorize endpoint (`/aws-blocks/auth/idp/<id>/authorize`) checks every sign-in request the way a real identity provider does. It accepts only the stub's own `client_id` and a registered `redirect_uri`: your app's sign-in callback (`redirects.callbackPath`) on your app's origin, or on the API Gateway URL when the stub is deployed. So a crafted link can't send a browser, with a sign-in code, to another site. Its token endpoint redeems an authorization code once, as a real provider does: a second redemption gets `400 invalid_grant` (remembered per process, so exact on the dev server and best-effort across Lambda instances). Any other `client_id` or `redirect_uri` gets a `400` error page and no redirect, before the account picker shows or `onAuthorize` runs. Sign-in through `Auth` and the Kotlin, Swift and Dart SDKs sends the registered callback, so it passes these checks.

  A sandbox stack with a stub provider fails synth with a clear error when the block's compute has no API URL, because the deployed stub builds its issuer from that URL.

- 5f55dac: feat(bb-auth): the stub IdP has an end-session endpoint that redirects only to registered URIs

  The `stubIdp()` provider serves an OIDC end-session endpoint (`/aws-blocks/auth/idp/<id>/logout`), so signing out of a stub session walks the same redirect chain as a real identity provider. Like a real one, it redirects only to a registered `post_logout_redirect_uri`: your app's origin plus `redirects.postSignOutPath` or `redirects.signOutPath`, matched exactly, so a link to it can't send a browser to another site. Any other URI, or an unknown `client_id`, gets a `400` error and no redirect. A request without a `post_logout_redirect_uri` shows a signed-out page. Sign-out through `Auth` always sends a registered URI.

- 5f55dac: `Auth`'s signed-in user (`AuthenticatedUser`) has an optional `claims` field: the provider's verified claims for users of a `store: 'builtin'` block (an OIDC, OAuth 2.0 or stub IdP provider verified by your backend), as `AuthOIDC`'s user carried. With `db.crud()` or `db pull`'s `supabaseCrud()` and Postgres row-level security, RLS therefore sees the identity provider's raw `sub` as `request.jwt.claims.sub` for those users, as it did with `AuthOIDC`, so policies that match the raw `sub` keep returning rows after the move to `Auth`. `claims` is absent for user-pool users, whose RLS subject is their `userId`. `claims` is server-side only: `getAuthState()` and the sign-in routes never send it to the browser.

  `@aws-blocks/bb-data`: newly generated `supabaseCrud()` wiring now passes `claims` to RLS explicitly, and the generated `MIGRATION_GUIDE.md` now says which subject RLS sees for each kind of user.

- 5f55dac: `Auth` synthesizes when you vendorize it (`npm run vendorize -- Auth`). A vendorized copy contains only the TypeScript sources, so the handlers of the deploy-time Lambdas `Auth` creates — the user-pool immutability guard (every `Auth` with a user pool) and the identity-provider registration (social, SAML and Cognito-federated OIDC sign-in) — are bundled from the vendorized source at synth, and your edits to them deploy too. Installed (non-vendorized) apps use the pre-built handlers. Bundling uses your app's `esbuild`, which AWS Blocks apps already have as a dev dependency; if it is missing, synth tells you to install it.
- 5f55dac: Error messages sent to clients never include Amazon Cognito's raw text, as in `AuthCognito` 0.1.11.

  Cognito's error messages can quote the request (a username, a rejected value) or name an endpoint, a role or your AWS account. `Auth` sends a fixed message for each error `name` instead (for example `Invalid parameter` for `InvalidParameterException`), from every method, `auth.admin.*` and the `createApi()` Authenticator state, and the same message under `npm run dev` as on AWS. Cognito's own text is written to the server log, with the user's login redacted. Error `name`, HTTP status and `retriable` are not affected, so code that matches errors with `isAuthError` works as usual. If you show `error.message` to users, they see the short fixed message (for example, `Invalid parameter` rather than the attribute Cognito rejected). A weak password is the one exception: its message is written from the password policy you configured, for example `Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number and a symbol.`, the same under `npm run dev` as on AWS. A pool you wrap with `Auth.fromExisting` keeps the fixed `Password does not meet the password policy`, because `Auth` doesn't know its policy. Errors you throw yourself as an `ApiError`, for example from `validateUser`, keep your message.

- 5f55dac: `getSdkIdentifiers(auth)` for an `Auth` block is typed with optional fields (`userPoolId`, `clientId`, `region`, `hostedUiDomain`, `hostedUiClientId`), matching what `Auth` registers. An `Auth` with `store: 'builtin'` has no user pool and registers none of them, so code that reads `userPoolId` must check that it is defined.

  The sign-in pricing tables (`Auth`'s "Which option and why" and the umbrella's "Choosing a sign-in method") note that Cognito's Plus plan has no free tier for email + password and social users ($0.020 per MAU), confirm that SAML / OIDC federated users cost $0.015 per MAU above 50 on every plan, and cite the Cognito pricing page and the date it was read.

- c607deb: Behind a Blocks CloudFront front door, a Lambda handler's `ctx.request.url` is now the URL the client called: the distribution's domain, or the custom domain it was called at (`https://d111.cloudfront.net/aws-blocks/api/orders`, not `https://<id>.execute-api.<region>.amazonaws.com/aws-blocks/api/orders`). Links and redirects a handler builds from it stay on the public domain, where the app's cookies are scoped. A container namespace behind the same door already reported that URL; the two compute types now agree. `getRequestBaseUrl()` is unchanged: it stays the gateway's origin and stage, for code that must reach the gateway directly.

  - Applies to the `apiFrontDoor: 'cloudfront'` distribution and to `Hosting`'s CloudFront door (on either tier). A viewer-request CloudFront Function on their API behaviors to the gateway stamps the viewer's host as `x-blocks-public-host`; each door registers its hosts under the backend's `BLOCKS_PUBLIC_HOSTS` config.
  - A handler takes the stamped host only when it is one of the backend's front-door hosts (for a wildcard alias such as `*.example.com`, a subdomain at any depth, not the apex); any other value is ignored.
  - Requests sent to the `execute-api` URL directly, and requests through `Hosting`'s other doors (ALB, API Gateway, stacked, bring-your-own), keep reporting the gateway's host.
  - The sandbox dev server's loopback `X-Forwarded-Host` still takes precedence, so redirect-based sign-in in a sandbox keeps working through the CloudFront URL. In both the Lambda handler and the container, it now contributes only its host: a query, fragment or userinfo in it no longer reaches `ctx.request.url`, and a request path starting `//` or `/\` can't change the URL's host.
  - A container namespace the gateway proxies to behind a Blocks CloudFront door (on the `apigateway` tier, or when CloudFront can't reach its VPC) also reports the public URL now, instead of the gateway's.
  - `Auth`'s same-origin relay allowance follows: when a sign-in starts, a `relayTo` on the host the client called behind a Blocks CloudFront door counts as same-origin, where the gateway's `execute-api` host did before. When the IdP calls back, the relay re-check accepts a relay to any host the backend serves over HTTPS (each CloudFront door's hosts and the gateway's), so a sign-in that started on one of a door's hosts, or on the `execute-api` URL, still finishes when the callback arrives on another.
  - Each CloudFront door adds one CloudFront Function to the account.

- 8a5726c: test: check `defaults.permissionsBoundary` coverage for Auth, Compute, ContainerCompute, CronJob and Dashboard

  Each of these blocks now has a synth test that sets `defaults.permissionsBoundary`
  and fails if any IAM role in any synthesized template, including custom-resource
  provider roles, the CronJob scheduler role and the container task execution
  role, lacks the boundary or is missing from the `<stack>.blocks-iam.json`
  report. No runtime or synth behavior changes.

- 2095f31: fix(core): `ctx.request.url.pathname` no longer includes the API Gateway stage when deployed

  On AWS, a `RawRoute` handler's `ctx.request.url` had the API Gateway stage in front of the path (`/prod/bench/me`), while `npm run dev` gave the route path (`/bench/me`). A handler that sub-routed on `url.pathname` passed every local test and returned its own 404 for every request after deploy. Behind `Hosting`, the stage wasn't part of the browser's URL either.

  `ctx.request.url.pathname` is now the route path in every environment, on Lambda and on a container compute, which took the stage from the front door's `x-blocks-forwarded-stage` header. The origin is unchanged: on AWS it is still the host the backend received, which behind a front door is the API Gateway host. An HTTP API `$default` stage is no longer prepended either, and a request path starting with `//` no longer changes the URL's host.

  This is a `minor` bump because it changes an existing value. If you build an absolute link from `ctx.request.url.pathname` or `href` while clients call the API Gateway URL directly, add the stage yourself, or build the link from your app's configured origin. The likeliest such code resolves a relative path against the request URL: `new URL('next', ctx.request.url)` used to give `/prod/…/next` and now gives `/…/next`. Building Block authors who need the externally reachable base, stage included, can use the new `getRequestBaseUrl(ctx)` from `@aws-blocks/core/bb-utils`; every transport sets it for every request it dispatches.

  `@aws-blocks/bb-auth` now takes the stage for its fallback callback URL (the direct engine's `redirect_uri` when no public origin is configured) and its stub IdP issuer from `getRequestBaseUrl()`, so those URLs are unchanged.

  The `@aws-blocks/bb-container-compute` design notes now say that the stamped stage goes to `getRequestBaseUrl()`, not to the request path.

- 58817b0: fix(core): add aws:SourceAccount/aws:SourceArn conditions to service-principal trust policies; add synth-time check

  The IAM roles AWS Blocks creates for a backend now scope every service-principal trust to the stack's account:

  - The `KnowledgeBase` Bedrock service role adds `aws:SourceArn` matching `arn:<partition>:bedrock:<region>:<account>:knowledge-base/*` beside its existing `aws:SourceAccount` condition.
  - The waiter state machine roles of the `DistributedTable` index provider and the `Database` migration provider trust `states.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:states:<region>:<account>:stateMachine:*`.
  - The `ContainerCompute` task execution role trusts `ecs-tasks.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:ecs:<region>:<account>:*`, the same scope as its task-role trust.
  - The `Auth` SMS role (created for phone sign-in or SMS MFA) trusts `cognito-idp.amazonaws.com` only with `aws:SourceAccount` and `aws:SourceArn` matching `arn:<partition>:cognito-idp:<region>:<account>:userpool/*`, beside the `sts:ExternalId` it already had.
  - The `@aws-blocks/hosting` API Gateway REST door no longer creates CDK's per-API CloudWatch role and `AWS::ApiGateway::Account` setting; its stage configures no logging.

  Synth now checks the roles AWS Blocks covers for a backend for a service-principal trust with neither an `aws:SourceAccount` nor an `aws:SourceArn` condition. That is the same set of roles `defaults.permissionsBoundary` applies to: for a `BlocksStack` the whole stack, for an embedded `BlocksBackend` its subtree and the stack-level roles created on its behalf. Lambda execution roles (`lambda.amazonaws.com`, `edgelambda.amazonaws.com`) are accepted as they are, as is the `apigateway.amazonaws.com` trust of an API Gateway CloudWatch Logs role: any role an `AWS::ApiGateway::Account` in the same stack names as its `cloudWatchRoleArn`, such as `BlocksApiGatewayCloudWatchRole` (created by `@aws-blocks/core` and `@aws-blocks/hosting` when access logging is on) or the default `cloudWatchRole` of a CDK `RestApi` the app adds. That trust stays unconditioned: API Gateway does not send `aws:SourceAccount` or `aws:SourceArn` when it delivers logs with this role, so a condition stops log delivery.

  - A role AWS Blocks creates (under an AWS Blocks Building Block or a compute, or at stack scope on a block's behalf) fails synth; the error names the role's construct path and the principal.
  - A role the app creates gets a synth warning instead, and synth succeeds: one its backend module adds (on a `BlocksStack` or an embedded `BlocksBackend`, at stack scope, under a `Scope` namespace, or inside a custom block the app writes as a `Scope` subclass), one added to a `BlocksStack` after `create()`, and one a CDK construct creates inside any of these (for example the `EventsRole` of an `events.Rule` targeting a state machine).

  Ownership follows who created the role: AWS Blocks' own blocks, computes and stack-level helpers mark the constructs they create, and every other covered role is the app's.

  To resolve the warning, add both conditions to the role's trust statement. For a role a CDK construct creates with no prop for its trust, set them with `role.node.defaultChild.addPropertyOverride('AssumeRolePolicyDocument.Statement.N.Condition', { ... })`; the warning names `N`. To keep the trust as it is, acknowledge the warning with `Annotations.of(role).acknowledgeWarning('@aws-blocks/core:serviceRoleTrustWithoutSourceCondition')`, or on the stack for every role in it. See "Service-principal trust" in the `@aws-blocks/core` README.

- Updated dependencies [e83d152]
- Updated dependencies [c6a3357]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [2eb62fa]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [1c7e0dd]
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
- Updated dependencies [c672712]
- Updated dependencies [c607deb]
- Updated dependencies [4e92168]
- Updated dependencies [bfdd06f]
- Updated dependencies [2095f31]
- Updated dependencies [80ce128]
- Updated dependencies [da7eb93]
- Updated dependencies [3259d83]
- Updated dependencies [70ea280]
- Updated dependencies [d354055]
- Updated dependencies [d354055]
- Updated dependencies [58817b0]
- Updated dependencies [e286b16]
- Updated dependencies [c00ab16]
- Updated dependencies [58980c7]
  - @aws-blocks/bb-app-setting@0.4.1
  - @aws-blocks/auth-common@0.4.0
  - @aws-blocks/core@0.9.0
  - @aws-blocks/bb-secret@0.4.0
  - @aws-blocks/bb-kv-store@0.5.0
  - @aws-blocks/bb-logger@0.4.0
