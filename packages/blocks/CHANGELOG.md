# @aws-blocks/blocks

## 0.10.0

### Minor Changes

- be8864c: fix(bb-agent): check conversation ownership in `stream()`, `resume()`, `getConversation()` and `getPendingInterrupts()`, and scope `getChannel()` to the caller

  `stream()` and `resume()` accepted any `conversationId` alongside a `userId` and never checked that the conversation belonged to that user. A caller who knew another user's conversation ID could add turns to it, or approve (and `trust`) that user's pending tool call, which then ran with the agent's IAM role. The same ID also let a caller read the conversation's history, and listen to or push chunks onto its live Realtime channel (the default `channelId` is the conversation ID).

  - **`stream()` and `resume()`** now throw `AgentErrors.ConversationNotFound` unless `options.conversationId` was created by `createConversationId(userId)` for the same `options.userId`. The check runs before anything is persisted or dispatched, and reads the conversation record with a strongly consistent read, so a `stream()` right after `createConversationId()` is not rejected on AWS.
  - **A turn without a `conversationId`** no longer runs in a conversation's session on AWS. Its AgentCore session id was the caller-chosen `channelId`, and the AgentCore entry used that as the conversation, so `stream({ channelId: <another user's conversation id> })` skipped the ownership check. It now gets its own session and, as in the local mock, no persisted conversation. **Breaking (AWS only):** a deployed agent that relied on reusing a `channelId` without a `conversationId` to keep memory across turns loses it; pass a `conversationId` instead (`createConversationId()` for persistence agents, a server-chosen key for `inferenceOnly` agents).
  - **`getPendingInterrupts(conversationId, { userId })`** now requires an options object with the caller's `userId` and returns `[]` for a conversation that user doesn't own. **Breaking:** `getPendingInterrupts(id)` becomes `getPendingInterrupts(id, { userId })`.
  - **`getConversation(id, { userId, limit? })`** now requires the caller's `userId` in its existing options object and returns `[]` for a conversation that user doesn't own. **Breaking:** `getConversation(id)` / `getConversation(id, { limit })` become `getConversation(id, { userId })` / `getConversation(id, { userId, limit })`.
  - **`getChannel(channelId, { userId })`** now requires an options object with the caller's `userId`. With persistence enabled, a turn's chunks are published on a channel scoped to the user who started it, so a caller can't listen to, or push chunks onto, another user's channel, whatever `channelId` they pass. **Breaking:** `getChannel(channelId)` becomes `getChannel(channelId, { userId })`, with the same `userId` you pass to `stream()`/`resume()`. `inferenceOnly` agents ignore the value but still take `{ userId }`: pass the session's `userId` as for persistence agents, not a placeholder, so the call stays correct if persistence is turned on later; their channels are not user-scoped.
  - There is no backward-compatible form: the old calls carry no `userId`, so they could only keep returning another user's data or change behaviour. With persistence enabled, `getConversation()`, `getPendingInterrupts()` and `getChannel()` throw `AgentErrors.InvalidUsage` naming the new signature when the options object or its `userId` is missing, instead of returning data. Build the options from the session's `userId`; don't spread a caller-supplied object into them.

  Agents with `inferenceOnly: true` keep no conversation records, so these checks don't apply to them: a `conversationId` passed to one is a shared session key, so don't let callers choose it.

  The channel key changes with persistence enabled, so reload chat sessions that were open across the upgrade (including turns that were running while the deploy rolled out); a subscription made before it no longer receives chunks.

  If you pass a `conversationId` that was never created with `createConversationId()`, `stream()` now rejects it; create the conversation first. Pass a `userId` taken from the authenticated session, never from a request parameter. The README's Authorization section and End-to-End example (which now includes the `getPendingInterrupts` and `resume` handlers) show this.

- 4457ea4: feat(bb-agent): add `sessionScope: 'user'` to isolate `inferenceOnly` sessions per user

  An `inferenceOnly` agent keeps no conversation records, so it can't check that a `conversationId` belongs to the caller: by default the id is a shared session key, and anyone who passes it continues that session and receives its channel. The new `sessionScope` option lets such an agent isolate sessions per user instead:

  - `sessionScope: 'user'` keys the session by the `userId` together with the `conversationId`, and scopes the Realtime channel to the `userId`. A caller who passes another user's `conversationId` gets a separate, empty session and never receives the other user's chunks. On AWS, the two users also run in different AgentCore runtime sessions.
  - With `'user'`, `stream()`, `resume()` and `getChannel()` require a non-empty string `options.userId` (take it from the authenticated session) and throw `AgentErrors.InvalidUsage` without one. A runtime invocation that arrives without a `userId` is refused rather than run as `'anonymous'`.
  - The default stays `'shared'`, so existing agents behave as before. Switching an existing agent to `'user'` starts new sessions: sessions stored under the bare `conversationId` are not resumed.
  - The option is ignored when persistence is enabled; those agents already check conversation ownership.

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

- 5f55dac: Add auth test helpers to `@aws-blocks/blocks/utils`. Both are Node-only and are not reachable from any browser entry.

  - `getLastAuthCode(username, { block?, purpose?, cwd? })` returns the verification code the local pool sent to a user, for e2e tests of sign-up, password-reset, MFA and attribute-verification flows. It finds the block's data under `.bb-data/` itself, so renaming the scope or the block doesn't break the test. It reads the codes the pool still holds, so a user's code is still found after another user's code was sent. When there is nothing to read, it throws an error that names what each local block last sent. It is also exported from `@aws-blocks/bb-auth/testing`.
  - `createTestClient(clients)` returns the app's typed clients (for example `createTestClient(await import('aws-blocks'))`) with a cookie jar of their own. A test can now act as two users at once, such as an owner and an intruder, without signing out between steps. The shared jar from `installCookieJar()` is never involved.

  To support this, the generated API client (`ApiNamespaceClient`) now sends a call with the `fetch` that the call's async context supplies, when there is one. Nothing changes for an app that doesn't use `createTestClient`.

  `installCookieJar()` now keeps request headers passed as a `Headers` instance or an entry list; it used to send only its `cookie` header for those.

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

- 49b68af: feat(bb-data): load Postgres extensions (PostGIS, pgvector) in local dev

  Adds an `extensions` option to `DatabaseOptions` so a Database Block can declare
  the Postgres extensions it uses (e.g. `['postgis']`, `['pgvector']`) and have them
  load in the **local PGlite engine**, restoring local/production parity for spatial
  and vector workloads. Previously `CREATE EXTENSION postgis` worked once deployed to
  Aurora but failed in local dev, forcing a sandbox deploy for every spatial/vector
  iteration.

  - **Local-only, mirroring `postgresVersion`.** The option is read only by the local
    PGlite implementation and is a no-op on AWS, where Aurora PostgreSQL supports
    these extensions natively. Application code is unchanged across environments, and
    PGlite never leaks into app code.
  - **Opt-in install.** Each supported extension ships as its own package, declared as
    an **optional peer dependency** and loaded by dynamic import, so only projects
    that declare an extension install it: `postgis` → `@electric-sql/pglite-postgis`,
    `pgvector` → `@electric-sql/pglite-pgvector`. A declared extension whose package is
    missing (or an unknown name) fails on the first database interaction with an
    actionable error — the exact `npm install` command, or the list of supported names.
  - You still run `CREATE EXTENSION <name>` in a migration — the option only makes the
    extension available for `CREATE EXTENSION` to succeed locally.

  Both extension packages are experimental upstream; the opt-in install keeps that
  risk with the consuming app rather than every `bb-data` consumer. No change to the
  AWS/CDK path. Non-breaking and additive: a `Database` with no `extensions` behaves
  exactly as before.

  The two extension packages are pinned to exact versions (`@electric-sql/pglite-postgis`
  `0.2.11`, `@electric-sql/pglite-pgvector` `0.0.12`) to match the exact-pinned
  `@electric-sql/pglite` `0.5.11` they peer-depend on. A caret range let a newer extension
  release (whose `pglite` peer had moved on) float in and produce an unresolvable peer tree.

- 6297d5a: `Database` now rotates its auto-generated `postgres` credentials secret every 30 days under the `production` preset, using AWS's PostgreSQL single-user rotation function (a Serverless Application Repository app: an AWS-maintained Lambda placed in the cluster's VPC): it generates a new password, sets it on the cluster and makes it the secret's current version. The secret keeps its ARN and the app never reads the password itself (the RDS Data API reads the secret for it), so a rotation needs no redeploy.

  Rotation is off under the `sandbox` preset, where a teardown would wait on the rotation Lambda's network interfaces and the stack would pay for an interface endpoint it never benefits from. Set `secretRotation: true` to opt in.

  - A `secretRotation` option turns rotation on (`true`), sets the interval (`{ intervalDays: n }`, 1–1000 days) or turns it off (`false`), and always wins over the stack-wide `defaults.secretRotation`. It is ignored, with a synth warning, for `fromExisting()` databases.
  - In the Database's own VPC (isolated subnets, no NAT) a Secrets Manager interface endpoint is added so the rotation Lambda can reach the Secrets Manager API (billed hourly in each of its two AZs, about $7.20 per AZ per month in us-east-1). A dedicated security group admits only the rotation Lambda on 443, and the cluster security group admits only the rotation Lambda on the Postgres port.
  - In a shared VPC (`defaults.vpc`) the rotation Lambda reuses the endpoint Blocks already provisions. With `provisionEndpoints: false` your own Secrets Manager endpoint's security group must admit the rotation Lambda's security group on 443; synth warns (`blocks:vpc:endpoint-client-unadmitted`) with the group to admit.
  - With a `storageEncryptionKeyArn`, the rotation Lambda is granted `kms:Decrypt`, `kms:DescribeKey` and `kms:GenerateDataKey` on the key; the imported key's policy must allow the account's IAM principals to use it, which the default key policy does. If the key policy enumerates principals instead of delegating to the account root, the rotation Lambda's role must be among them; its ARN is only known after the first deploy.

  `BlocksDefaults` gains an optional `secretRotation`, so no existing literal needs changing: both presets set it, and an absent value means off.

  Two deploy-time requirements come with it, because the rotation function is an AWS Serverless Application Repository app: the CloudFormation execution role needs `serverlessrepo:GetApplication` and `serverlessrepo:CreateCloudFormationTemplate`, and rotation only deploys in the `aws`, `aws-cn` and `aws-us-gov` partitions (a concrete region outside them fails at synth). An app on the `production` preset gets rotation by upgrading, so a least-privilege bootstrap role or another partition needs `secretRotation: false`.

  Existing stacks upgrade in place: rotation only adds resources; the cluster, its writer and the secret synthesize identically before and after this change, so there is no cluster replacement. The stack gains the `AWS::Serverless-2016-10-31` transform, and the first rotation runs during the deploy, after the writer is available and migrations have run; the deploy waits (up to five minutes) for it to finish.

  Every rotation, scheduled ones included, has a window in which the cluster already accepts the new password while the secret still holds the old one, usually 1-3 seconds and occasionally up to about 18; a query in that window is refused, so the Data API engine now classifies that refusal as a connection failure and retries the statement for up to nine seconds (it is refused before it runs, so a retry cannot apply it twice). A statement inside a transaction is not retried, since every attempt would reuse one transaction id; the refusal surfaces so the caller can retry the whole transaction.

  CDK also attaches a resource policy to the secret that denies `secretsmanager:DeleteSecret` to the account while rotation is on. `cdk destroy` still deletes the secret; an out-of-band `delete-secret` is refused.

  Also fixed: with a `storageEncryptionKeyArn`, the app runtime and the migration Lambda were never granted `kms:Decrypt` on the key, so every Data API call, the first migration included, failed. The app runtime and the migration Lambda are now granted `kms:Decrypt` on the key, scoped to use through Secrets Manager.

  In `@aws-blocks/core`, `VpcRequirements` gains `endpointClientSecurityGroups`, letting a Building Block register security groups of compute it provisions itself (such as the rotation Lambda) so they are admitted on the Blocks-managed interface-endpoint security group, and `endpointClientDependents`, so a construct that must not be created before that compute can reach the endpoints is ordered after them. When `provisionEndpoints: false` leaves the endpoints to you, Blocks warns for each registered group instead.

- 7c23ab9: feat(bb-file-bucket): signed upload constraints, opt-in download disposition, stricter key validation and 400 for invalid input

  - **Presigned uploads always sign a `Content-Type`.** `putUrl()` and `createUploadHandle()` now sign the `contentType` you pass, or `application/octet-stream` when you pass none, so the upload must send exactly that header (S3 answers `403 SignatureDoesNotMatch` otherwise). `createUploadHandle().upload()` and its hydrated client handle always send it. **Breaking:** an upload to a `putUrl()` URL created without `contentType` must now send `Content-Type: application/octet-stream`; pass the `contentType` the client will send. `createUploadHandle()` without `contentType` now stores `application/octet-stream` instead of the browser's file type; pass `contentType: file.type` to keep it. Browser uploads now always send `Content-Type`, so `corsRules` must allow it in `allowedHeaders`. `put()` without `contentType` now stores `application/octet-stream` on AWS too, matching local dev.
  - **`contentType` must be a single media type.** `put()`, `putUrl()` and `createUploadHandle()` reject (400 `ValidationFailed`) a `contentType` that is not `type/subtype` with optional `; name=value` parameters — for example a comma-separated list, non-ASCII or control characters, or an empty value.
  - **`contentType` is signed and stored in canonical form.** Parameters are rendered as `; name=value`, with one space after `;` and none around `=` (`text/plain;charset=utf-8` becomes `text/plain; charset=utf-8`); a quoted value is written bare when its content is a token (`charset="utf-8"` becomes `charset=utf-8`) and otherwise stays quoted. HTTP clients that re-render a parsed `Content-Type`, such as the native Kotlin client, then send exactly the signed value.
  - **New `contentLength` option** on `putUrl()` / `createUploadHandle()` signs the exact upload size, so only a body of that size is accepted.
  - **New bucket options `allowedContentTypes` and `maxUploadBytes`.** `allowedContentTypes` (exact media types or `type/*` wildcards) restricts the content types `put()`, `putUrl()` and `createUploadHandle()` accept. A `type/*` wildcard does not match `text/html`, `image/svg+xml`, `application/xhtml+xml`, `text/xml`, `application/xml`, `text/xsl`, the JavaScript and ECMAScript types (`text/javascript`, `text/ecmascript`, `application/javascript`, `application/ecmascript`, `application/x-javascript`), or any `+xml` subtype; list one exactly to accept it. `maxUploadBytes` caps `put()` bodies and makes presigned uploads require a `contentLength` at or under it. Both are checked identically in local dev and on AWS, and their shape is validated at synth.
  - **New `attachment` option** on `getUrl()` / `getFileHandle()`: `true` or a filename signs a `Content-Disposition: attachment` into the download URL, so the browser saves the file instead of displaying it. Directional formatting and zero-width characters are removed from the filename, `/` and `\` are replaced with `_`, and a filename that is empty, `.` or `..` is rejected. Default behavior is unchanged.
  - **Stricter key validation.** Keys are also rejected when they contain a backslash, C1 control characters, U+2028/U+2029, or bidirectional formatting characters, a segment that contains `.` or `..` once `%2e`, `%2f` and `%5c` are decoded, or more than 1,024 bytes in UTF-8. `scan({ prefix })` now validates the prefix with the same rules (an empty prefix and a trailing `/` are allowed).
  - **`ValidationFailed` is now an `ApiError` with status 400**, so API methods answer invalid keys, prefixes, expiry values and upload constraints with HTTP 400 instead of 500. The name and message format are unchanged, and messages never include the key.
  - **`VersionNotFound` from `restoreVersion()` now has the fixed message `The requested version does not exist`**, without the key or version id.

  The README adds sections on per-user isolation (derive keys from the authenticated user, never from a client-supplied key or prefix), upload constraints, serving user uploads, and the key rules; its examples now build keys from the caller's identity.

- b2eb306: feat(blocks): add the `cdk-blocks` CLI

  `@aws-blocks/blocks` now installs a `cdk-blocks` command (there is no `blocks` command) for the whole app lifecycle: `cdk-blocks dev`, `cdk-blocks sandbox`, `cdk-blocks deploy`, `cdk-blocks destroy`, `cdk-blocks whoami`, `cdk-blocks secret`, `cdk-blocks config`, `cdk-blocks telemetry`, `cdk-blocks generate client|spec|types`, `cdk-blocks db` and `cdk-blocks vendorize`. Each lifecycle command runs the same code as the matching npm script of a generated app, so `npx --no -- cdk-blocks dev` behaves like `npm run dev`, and the npm-script spellings (`dev:stop`, `sandbox:destroy`, `typegen`, …) work as aliases. Run it as `npx --no -- cdk-blocks <command>`: `--no` uses the installed CLI and never downloads a package, while a bare `npx blocks` would install the unrelated `blocks` package from npm.

  The CLI prints results on stdout and progress on stderr, supports `--output json` and `--query <field>` (for example `API_URL=$(npx --no -- cdk-blocks deploy --query apiUrl)`), and exits 0 on success, 1 on failure, 2 on a usage error and 130 when interrupted. `cdk-blocks destroy` shows the stack it deletes and asks first; in a non-interactive run it requires `--yes`. Local server settings can be set in `package.json` under `"blocks": { "dev": { … } }`; without a `frontendCommand` the frontend is detected from `vite` or `next` and started on `frontendPort` (default 3100). `@aws-blocks/blocks` now depends on `tsx`; the CLI uses the app's own `tsx` first, else that one, for its lifecycle runners and for client generation. `blocks-generate-client` falls back to it the same way, so it no longer needs the app to install `tsx`. CDK synth still runs the app's own `tsx` (the `app` command in `cdk.json`, or `npm exec tsx` for the sandbox commands), so apps keep `tsx` as a devDependency, as the templates do.

  Inside an app, run it as `npx --no -- cdk-blocks <command>` or through the npm scripts. Without installing, run `npx -p @aws-blocks/blocks cdk-blocks <command>`: a plain `npx @aws-blocks/blocks` cannot choose a command, as none has the package's unscoped name.

  `@aws-blocks/blocks/scripts` re-exports `@aws-blocks/core/scripts`, so the lifecycle scripts it exports now honor `BLOCKS_LOG_LEVEL` and `BLOCKS_LOG_STREAM`, and it exports `readAwsIdentity()`, `describeDeploymentCredentials()`, `resolveDeploymentTarget()` and `log`.

- 792e269: feat(blocks): add `cdk-blocks migrate`

  `npx --no -- cdk-blocks migrate` moves an app that create-blocks-app scaffolded with `aws-blocks/scripts/*.ts` wrappers to the `cdk-blocks` CLI. It rewrites each `package.json` script whose value is exactly a generated command (for example `"deploy": "tsx aws-blocks/scripts/deploy.ts"` becomes `"deploy": "cdk-blocks deploy"`), moves the port and frontend settings of a generated `server.ts` to `package.json#blocks.dev` (`"frontend": false` for a backend-only one), and deletes the generated wrappers that nothing uses any more. A wrapper that a script or any app file other than Markdown docs still uses is kept: it reads TypeScript and JavaScript sources (including nested and parent-relative imports such as `import '../server.js'`), shell scripts, Dockerfiles, and dot directories such as `.github` and `.vscode`. In a git repository the app files are the tracked files and the untracked files that are not gitignored, in any directory, so gitignored build output and logs do not count, plus the files of a submodule or an untracked git repository inside the app; outside git, or where git does not track the app (a parent repository ignores its directory), they are the files under the app directory other than `node_modules`, `.git`, build output (`build-temp` included) and tool caches. Markdown docs and editor rules (`*.md`, `*.mdx`, `*.mdc`), binary files, files over 1 MiB and symbolic links never count. It does not read outside the app directory, so check the scripts of a parent workspace yourself. It recognises every wrapper version that create-blocks-app has shipped, ignoring whitespace. A wrapper you changed is never deleted, only reported. If you changed `server.ts`, the `sandbox` scripts are kept too, because `sandbox.ts` starts that server, and a `sandbox.ts` that stays keeps its `server.ts`; in the Amplify overlay, `blocks:stop` and `stop.ts` are kept as well, because that `stop.ts` stops the server's own port. If `.blocks/config.json` is missing or has no `stackId`, as in apps scaffolded before create-blocks-app wrote it, the `deploy` and `destroy` scripts and wrappers are kept, because `cdk-blocks deploy` and `cdk-blocks destroy` need it; the report says how to add it. Every other script is left alone.

  Run `npx --no -- cdk-blocks migrate --dry-run` first to see the plan. Unless you pass `--force`, it refuses an app outside git (or where git is not installed), a git working tree with uncommitted changes, an app that git does not track (so git could not undo the changes), and a repository that git fails to read, such as one with "dubious ownership", quoting git's error. `--output json` prints `{changed, removed, kept, scriptsRewritten, devConfig}`, where `devConfig` is the `blocks.dev` config that migrate adds to `package.json` (or, with `--dry-run`, would add), or `null`. It exits 0 when the app is fully migrated and 1 when kept items remain for you to finish by hand; exit 1 is a report, not a crash, and running it again is safe.

  It recognises the wrappers of every public create-blocks-app release up to 0.4.0, including the `sandbox.ts` that runs `npm run sandbox:preview`, whose `"sandbox:preview": "tsx aws-blocks/scripts/sandbox.ts --preview"` becomes `"sandbox:preview": "cdk-blocks sandbox preview"`.

  Fixes from CLI testing:

  - Two `cdk-blocks migrate` runs at the same time no longer crash with `ENOENT` when one deletes a wrapper that the other is reading or planned to delete.
  - `cdk-blocks migrate --dry-run` no longer says "everything else was migrated" above the items it would keep.
  - The hint for an app without `stackId` now says that `<stackId>-prod` must equal the production stack name in `aws-blocks/index.cdk.ts`: an app that hard-codes `my-blocks-stack-prod` uses `{"stackId": "my-blocks-stack"}`.
  - A wrapper that matches no known version is reported as an "unrecognised version (only public create-blocks-app releases are recognised)", not as "customized": it may be an unmodified file from a release that migrate does not know. The README and `cdk-blocks migrate -h` say that only the public releases are recognised.
  - A generated script that still runs a kept, unrecognised wrapper (for example `dev` and `dev:server` with a changed `server.ts`) is now listed in `kept` with the reason, so `--output json` names every script that still uses `aws-blocks/scripts`.
  - `cdk-blocks migrate` writes `blocks.dev.frontendCommand` only when it differs from the command `cdk-blocks dev` detects from the `vite` or `next` dependency; the ports still move. A migrated default app gets `{"frontendPort": 3100}`, as new apps do, so `cdk-blocks dev --frontend-port` keeps working.
  - With `--output json`, a refusal (uncommitted changes, an app git does not track, a git failure) prints `{"error": {"message", "hint"}}` on stdout, so a script can tell it from kept items, which also exit 1. `cdk-blocks migrate -h` and the README list the exit codes: 0 fully migrated, 1 kept items remain or refused, 2 usage error.
  - `cdk-blocks migrate` keeps a wrapper that a CI workflow, shell script, Dockerfile or script runs from another working directory: a bare `scripts/deploy.ts` or `deploy.ts` there now counts as a use (`working-directory: aws-blocks` with `npx tsx scripts/deploy.ts`, `cd aws-blocks/scripts && npx tsx typegen.ts`). In a monorepo it also reads every `package.json` and every CI, shell, Make and Docker file that git tracks outside the app, at any depth (`.github/workflows/*`, `scripts/deploy-web.sh`, `ci/Makefile`, `tools/release/package.json`; not under `node_modules`, nor over 1 MiB), and, when the app is in a git submodule, those files of the superproject, so it no longer deletes a wrapper that a root workflow, a monorepo script or a sibling workspace still runs.
  - `cdk-blocks migrate --query <path>` checks the path against the result before anything runs, as the other commands do: `kept.0.reason`, `scriptsRewritten.<script>.to` and `devConfig.frontendPort` are accepted, and a typo exits 2 with the fields it could be.
  - `cdk-blocks migrate --query <path>` prints a refusal only as the error on stderr, with nothing on stdout, also under `--output json`: `--query` prints one field of the result, and a refusal has no result. The `{"error"}` document is for `--output json` without `--query`.
  - An app `package.json` that is not valid JSON stops `cdk-blocks migrate` with `cannot read <app>/package.json: <the parse error>`, as the other commands say, instead of only `Unexpected end of JSON input`.
  - In a monorepo, a file above the app counts as a use of a wrapper only when it names this app: `apps/web/aws-blocks/scripts/deploy.ts` (relative to the repository top or to the file), or a bare `aws-blocks/scripts/deploy.ts`, `scripts/deploy.ts` or `deploy.ts` in a file that changes into the app (`working-directory: apps/web`, `cd apps/web`). Before, `apps/api`'s workflow, with `working-directory: apps/api` or `apps/api/aws-blocks/scripts/typegen.ts`, kept `apps/web`'s wrappers and made its migration exit 1.
  - An app `package.json` that is valid JSON but not an object (`null`, an array, a string) stops `cdk-blocks migrate` with `<app>/package.json must be a JSON object, not null.` and changes nothing, instead of `Cannot read properties of null (reading 'scripts')`, or `Nothing to migrate` for an array or a string.
  - A path written with backslashes counts as a use of a wrapper: `npx tsx aws-blocks\scripts\deploy.ts` in a `.cmd`, `.bat` or `.ps1` file (or a `package.json` script) keeps `deploy.ts`, which `cdk-blocks migrate` deleted before.
  - On Windows, two `cdk-blocks migrate` runs at the same time no longer crash with `EPERM: operation not permitted, rmdir '…\aws-blocks\scripts'`: a directory that the other run holds or is deleting is tried again, then left to it.
  - Outside git, or where git is not installed, `cdk-blocks migrate` now refuses unless you pass `--force`, as it does for an app that git does not track: git could not undo the rewritten scripts or the deleted wrappers. The hint points to `--dry-run` first, and `--output json` prints the `{"error"}` document.
  - In a monorepo, a quoted `cd` or `working-directory` into the app now counts when it holds an escaped quote (`cd "apps/we\"b"`) or a command substitution: `cd "$(git rev-parse --show-toplevel)/apps/web" && npx tsx aws-blocks/scripts/deploy.ts`, or `cd "$(dirname "$0")/../apps/web"` from the script's own directory. Before, `cdk-blocks migrate` deleted `deploy.ts` there and exited 0 while the root script still ran it.
  - A `.blocks/config.json` that is not valid JSON is no longer reported as missing: the kept `deploy` and `destroy` items say `.blocks/config.json is not valid JSON (<the parse error>): fix <path>, then run cdk-blocks migrate again`, as core's deploy and `cdk-blocks whoami` do, instead of telling you to create the file.
  - A `package.json` edit made while `cdk-blocks migrate` scanned the app is no longer overwritten: migrate now stops with `package.json changed while cdk-blocks migrate ran; nothing was written.` before it writes or deletes anything, also with `--force`, and `--output json` prints the `{"error"}` document. Before, it wrote the scripts it had planned over the edit, and could delete a wrapper that a newly added script ran.
  - A wrapper that a field of the app's `package.json` other than `scripts` runs is no longer deleted: a `lint-staged`, `simple-git-hooks` or `nodemonConfig` block with `tsx aws-blocks/scripts/typegen.ts` (or a bare `scripts/deploy.ts` after `cd aws-blocks`) keeps that wrapper, reported as `generated, but still used by package.json#lint-staged`. Before, `cdk-blocks migrate` read only the `scripts` of the app's own `package.json`, deleted the wrapper and exited 0.

- 9ebf67a: An API namespace can run on a `container` compute:

  ```ts
  const renderCompute = new Compute(scope, 'render', { type: 'container', size: { vcpu: 2, memory: 4096 } });
  export const render = new ApiNamespace(scope, 'render', (context) => ({ … }), { compute: renderCompute });
  ```

  The container's tasks serve the namespace with the same dispatch as the Lambda handler (CORS, cookies, error envelopes), so clients call it exactly as before at `/aws-blocks/api/render`.

  - The shared API gateway reaches the tasks through a VPC link to an internal Application Load Balancer that the compute provisions in the app's VPC: one load balancer and one listener per backend, with a path rule per namespace forwarding to its container's target group, health-checked on the task's readiness port. A container that only runs jobs gets no target group.
  - The tasks admit the load balancer on a security group of their own; the shared compute security group stays closed to inbound traffic.
  - The load balancer drops request headers that aren't valid HTTP before they reach a task.
  - API calls to a container keep the gateway's ~29-second cap. A stopping task finishes its in-flight requests (up to 35 s) before it shuts down.
  - A `Scope` with a container `compute` now places its `ApiNamespace`s on that container too, instead of failing synth.
  - A container that serves API namespaces needs a running task: `scaling.minInstances: 0` fails synth. Without a `scaling.strategy`, one that also runs an `AsyncJob` scales on CPU, and its queue backlog adds tasks too.
  - Moving a namespace that already serves traffic onto a container: during that deploy, its calls can get 503s for the minute or two the new tasks take to start.
  - `runContainer()` takes the backend module (`runContainer({ backend })`) and serves its API on port 8080, with readiness on port 8081; called without it, the container answers a health check on port 8080 as before. A container compute passes it only when the compute serves API traffic.
  - The container compute's dashboard section gains API request, 5xx, latency and task-health widgets.

- 5f55dac: feat(core): opt in to HTTP error statuses for an API namespace

  `ApiNamespace` takes a new `httpErrorStatus` option. With `httpErrorStatus: true`, a call that throws an `ApiError` with a 4xx status — such as `requireAuth()`'s 401 — is answered with that HTTP status instead of 200, so API Gateway and CloudFront metrics, access logs, WAF rate rules and 4xx alarms can see rejected calls:

  ```ts
  export const api = new ApiNamespace(
    scope,
    "api",
    (context) => ({
      async getNote() {
        const user = await auth.requireAuth(context); // signed out → HTTP 401
        return notes.get(user.userId);
      },
    }),
    { httpErrorStatus: true },
  );
  ```

  The JSON-RPC body is unchanged, and the TypeScript client reads it whatever the status, so `isBlocksError()` and `error.status` behave exactly as before. 5xx and other failures stay HTTP 200. It applies in the local dev server and on AWS alike. The default is unchanged: every RPC response stays HTTP 200.

  Two things to check before turning it on, both documented on the option: CloudFront error pages apply to the proxied API too, so on a `Hosting` distribution that maps 403 or 404 to a page, those responses would reach the client as HTML. CloudFront cannot scope error responses away from `/aws-blocks/*`, so `Hosting` now fails synth for that combination with a `HostingError` named `HttpErrorStatusErrorPagesError`; remove the 4xx error pages or leave `httpErrorStatus` off for those namespaces. The hosting README describes the gap. (During review this was a synth warning, `@aws-blocks/hosting:HttpErrorStatusErrorPages`; it was never released as one.) And the Dart client, with an `authProvider`, refreshes its token and runs the method once more on any HTTP 401, so a method that throws 401 after a side effect can run twice for it: put the guard first (`requireAuth()` as the first statement, or `auth.protect`).

- 2c9005f: fix(core): reject malformed native declarations instead of dropping them

  An `aws-blocks` key that is present but not an object dropped every declaration
  inside it; it is now `"aws-blocks" must be an object (declared by <block>)`. A
  `null` key is an error rather than an absence, and an absent key still skips. An
  unrecognized field on a binding with a usable `id` is rejected rather than
  silently stripped, both generic-arity errors now name the binding and the
  declaring block, and a registration, platform entry or package entry carrying a
  non-enumerable field is rejected too.

  Behavior change (0.x minor = breaking channel): generation now exits 1 where it
  wrote a spec before, for a `null` or non-object `aws-blocks` key and for an
  unrecognized binding field. Remove the offending key or field.

- 44c7377: feat(core): `defaults.strictNamespacePlacement` serves each API namespace only on the compute it is placed on

  An `ApiNamespace` given its own `compute` is routed to that compute at `/aws-blocks/api/{namespace}`, but the bare `POST /aws-blocks/api` endpoint is served by the default compute and dispatches on the JSON-RPC body. A raw call such as `{ "method": "reports.build" }` to the bare endpoint therefore runs `reports` on the default compute, outside the VPC, container or sizing its placement was meant to give it.

  - **New `BlocksDefaults.strictNamespacePlacement`** (`false` in both presets). Add `strictNamespacePlacement: true` to the stack's `defaults`, next to the preset you already use, and each compute's dispatcher serves only the namespaces placed on it, on any RPC path. A call to a namespace placed elsewhere gets the same `-32601` "method not found" error as an unknown namespace. Namespaces without a placement keep running on the default compute, on the bare endpoint and on their own path. The typed TypeScript client and the Kotlin, Swift and Dart clients already call each namespace at its own path, so they keep working. A raw HTTP caller, or a native client generated before per-namespace paths, that posts a placed namespace to the bare endpoint is refused once you turn it on. The option applies only to deployed computes: the local dev server keeps serving every namespace on every path.
  - **Every API compute rolls on a change.** The placement map is set in the environment of every compute that serves an API namespace, the default one included, so turning the option on or moving a namespace to another compute updates each function and task definition and no running compute keeps an old map. Synth fails with a clear error if the encoded map is over 2 KB. A compute whose environment has its compute id but no readable map fails to start (a Lambda function retries on the next request) instead of serving every namespace.
  - **New synth warning** `blocks:apigateway:bare-endpoint-serves-placed-namespaces` when some namespace runs on its own compute and `strictNamespacePlacement` is off. Turn the option on, or, if raw callers still need the bare endpoint, acknowledge the warning with `Annotations.of(stack).acknowledgeWarning('blocks:apigateway:bare-endpoint-serves-placed-namespaces')` on the stack or backend returned by `create()`.

  The option keeps a namespace's code on its own compute and network. It doesn't split IAM: every compute still runs under the app's one execution role.

- afad513: `defaults.allowedOrigins`: plain origins such as `https://app.example.com` now match exactly (case-insensitive), so their dots are literal. `http`/`https` plain origins are compared in the form the browser sends (default port dropped, internationalized hosts in punycode), and entries with user info, a path, a query or a fragment are rejected. Entries with regex syntax are still anchored regexes, but must compile on their own and escape `.` (unless followed by a quantifier, as in `.*`); glob-style entries such as `https://*.example.com` and patterns with nested quantifiers such as `(a+)+` are rejected, and brace quantifiers are limited to `{n}`. Invalid entries now fail `cdk synth` from `BlocksStack.create()` / `BlocksBackend.create()` with a message naming the entry, and are ignored (and logged) at runtime. The README examples now use plain origins, and suggest `https://[a-z0-9-]+\\.example\\.com` for subdomains.
- 5f55dac: New apps now use the unified `Auth` block. Every template that signs users in (`default`, `react`, `demo`, `api-only`, `sql` and the auth template) now uses `Auth` from `@aws-blocks/blocks` instead of `AuthBasic` or `AuthCognito`. The block id stays `'auth'`.

  **Sign-up now needs the emailed code.** A new account confirms its email address with a 6-digit code, then the user is signed in automatically, with no second password entry. With `AuthBasic`, users were signed in as soon as they signed up. When you run locally (`npm run dev`), no email is sent: the code is printed in the terminal, and each template's e2e tests read it from `.bb-data/`. Once deployed, Amazon Cognito emails the code. Its default sender is limited to 50 emails a day.

  **The `auth-cognito` template is now `auth`.** There is one auth block now, so the template is named for what it shows: email sign-up with a code, groups with `requireRole`, profile attributes, password change and sign-out everywhere. `--template auth-cognito` still works and scaffolds `auth`. The template now signs in with email + password instead of a passwordless email code, because Cognito can only send that code through Amazon SES, which a user pool created by the block doesn't have.

  The `amplify` overlay's token verifier now implements the `BlocksAuth` interface and throws the same error names as `Auth` (`NotAuthenticatedException`, `NotAuthorizedException`), and its `requireGroup()` is now `requireRole()`. The `AGENTS.md` scaffolded into every app explains how to configure `Auth`, gate methods with `requireAuth` / `requireRole`, and where the `Auth` docs live.

- 9801a5b: fix(core): give each deploy stage its own CDK outputs file

  `npm run deploy` and `npm run sandbox` both wrote `--outputs-file .blocks-sandbox/outputs.json`, and the CDK CLI replaces that file with the stacks of the one invocation that wrote it rather than merging into it. A production deploy therefore left only its own stack in the document the sandbox reads, and a deploy that failed on its first stack wrote an empty document, blanking the record of a stack that was still standing.

  Each stage now writes its own document:

  - the sandbox keeps `.blocks-sandbox/outputs.json`
  - production writes `.blocks-sandbox/outputs.production.json`

  Both stay in `.blocks-sandbox/`, which is already ignored, so neither can be committed by a missing ignore entry.

  `cdk-blocks destroy` and `cdk-blocks sandbox destroy` now forget the deleted stack in the document of the stage being destroyed, instead of always in `outputs.json`. A production destroy also clears its stack from a pre-split `outputs.json`, so an app that deployed production before upgrading is not left recording a stack that no longer exists.

  **If you read `.blocks-sandbox/outputs.json` for production** (a script, a CI step, or a launcher), read `.blocks-sandbox/outputs.production.json` instead. `OUTPUTS_FILE` from `@aws-blocks/core/scripts` carries both paths. The next deploy of each stage writes its own document, and `cdk-blocks sandbox console` derives the sandbox stack rather than naming one out of a pre-split `outputs.json`.

  **If you call `openConsole({ outputsFile })` directly** (the Kotlin and Swift example apps, and any app scaffolded before the `cdk-blocks` CLI), it still opens the document's first stack. On an app that deployed production before upgrading, that is production's stack until one `npm run sandbox` refreshes `outputs.json`, so run it once or delete the stale file.

- be8864c: feat(bb-distributed-table): add a `consistentRead` option to `get()`

  `get(key, { consistentRead: true })` reads the item with a strongly consistent DynamoDB `GetItem` (`ConsistentRead: true`), so it sees every write that succeeded before the read. Use it when the next step depends on an item that was just written, such as an existence or ownership check. Without the option `get()` stays eventually consistent, as before. A strongly consistent read costs twice the read capacity. The local mock is always strongly consistent and accepts the option.

  The new `GetOptions` type is exported from `@aws-blocks/bb-distributed-table`, and from the umbrella `@aws-blocks/blocks` as `DTGetOptions`.

- 64f7247: `EmailClient.sendBatch()` now takes at most 100 messages per call by default. A larger batch throws `InvalidInputException` (`Batch size 101 exceeds the maximum of 100 messages.`) and nothing is sent, locally and when deployed. Before, a single call could send any number of messages, so one request to an exposed method could fan out into an unbounded number of SES sends.

  **Behavior change:** a `sendBatch()` call with more than 100 messages that worked before now throws. Split the messages across calls, or set the new `maxBatchSize` option (a positive integer) to raise the cap for a trusted server-side job. An invalid `maxBatchSize` throws `InvalidInputException` from the constructor, and fails at synth.

  The SES send permission granted to the app's execution role is now scoped to the stack's own region and partition, instead of every region. The runtime only ever calls SES in the Lambda's own region, so this does not change what an app can send.

  The README has a new security section: an `ApiNamespace` method that passes caller input to `send()` or `sendBatch()` without a gate is an open relay. It shows gating with `auth.requireAuth(context)` and building the message on the server. The umbrella `@aws-blocks/blocks` gets a minor bump because it re-exports `EmailClient`, so the `sendBatch()` behavior change reaches umbrella users too, and because the `bb-email-client` README/DESIGN docs it bundles have changed.

- fb29c06: feat(hosting): lock the CloudFront door's server origin with a random secret, a regional web ACL and opt-in access logs

  The API Gateway REST API that CloudFront reaches the SSR Lambda through now
  requires a random origin-verify `Referer` value that Secrets Manager generates
  once per stack. The REST API policy and the CloudFront origin read it through a
  CloudFormation dynamic reference, so it no longer appears in the template and
  can't be derived from the stack name. A Nuxt IPX image optimizer gets its own
  REST API with its own secret.

  With `waf: { enabled: true }`, each server-origin stage also gets a REGIONAL
  web ACL with the distribution's rules and rate limit. Its CloudWatch Logs keep
  only the requests a rule blocked or counted, with the `Referer`, `Cookie` and
  `Authorization` headers redacted, and it keeps no sampled requests.

  Cost: with `waf.enabled`, a second web ACL per stack: its monthly charge, a
  per-request charge (every uncached SSR request is evaluated by both web ACLs),
  and the log ingestion of blocked and counted requests. Every CloudFront + SSR
  stack also gets one Secrets Manager secret (two with Nuxt IPX), each with a
  small monthly charge.

  New `frontDoor.features.serverOrigin` settings:

  - `accessLogging` (default `false`): JSON stage access logs in CloudWatch Logs.
    It creates the account-level API Gateway CloudWatch Logs role once per stack.
  - `logRetention` (default one month): retention of those logs and of the
    stage web ACL's logs.
  - `verifySecretRotation`: bump it to rotate the origin-verify secrets.
  - `acceptLegacyVerifyHeader`: accept the earlier derived value for one deploy
    while upgrading. Synth warns while it is set.

  Upgrading: the first deploy updates the REST API policy within seconds and the
  distribution within minutes, so SSR requests can get 403 for those minutes.
  To avoid this, deploy once with `serverOrigin: { acceptLegacyVerifyHeader: true }`,
  then deploy again without it. For that deploy the SSR REST API also keeps the
  IPX image routes it served before, and its stage web ACL is attached only on
  the next deploy, once every edge sends the marker its rate rule exempts.

- 40d25ec: fix(hosting): keep credentialed and cookie-setting SSR responses out of the shared edge cache

  The hosting construct now installs an SSR cache guard in front of the SSR server it builds, and in front of every other regional compute a route targets (native Lambda handlers, buffered or streaming; Node.js servers on the Lambda Web Adapter or a Lambda Web Function), for every framework. Where the guard cannot be installed (e.g. a Lambda Web Adapter server that is not Node.js), synth emits a `@aws-blocks/hosting:SsrCacheGuardNotInstalled` warning. The guard sends `Cache-Control: private, no-store` in place of the origin's value when:

  - the response sets cookies (`Set-Cookie`) and is not already `private` or `no-store`; or
  - the request carries `Authorization` (unless `'authorization'` is in `cacheKeyHeaders`) or a cookie whose name is not in the SSR cache key (the Next.js preview cookies, the skew-protection `__dpl` cookie and `cacheKeyCookies`), and the response is shared-cacheable: `s-maxage`, `public`, `max-age` without `private`, a future `Expires`, no caching headers while `ssrDefaultTtl > 0`, or an error status CloudFront caches without caching headers (404, 414, 500-504). Behind the CloudFront-over-ALB door, whose server-route cache key holds every cookie, only `Authorization` and `Set-Cookie` lead to the rewrite.

  Responses already `private`/`no-store`, or `no-cache` without `s-maxage`, are unchanged. The cache-key names are baked into the generated guard module at synth.

  **BREAKING:** SSR responses that the origin marks shared-cacheable are no longer edge-cached for requests that carry `Authorization` or cookies outside the cache key, and responses with `Set-Cookie` are never edge-cached. To keep a credentialed route cacheable, list its session cookie in `cacheKeyCookies` and/or `'authorization'` in `cacheKeyHeaders`, so the cache is keyed per credential. Client-side analytics and consent cookies (`_ga`, `_gid`, `_fbp`, consent cookies) make ISR/SSR pages uncacheable at the edge for every visitor that carries them, unless they are listed in the new `cacheGuardIgnoredCookies` option (`frontDoor.features.cacheGuardIgnoredCookies`), which the guard ignores and keeps out of the cache key; a listed cookie must never affect the rendered output.

  A distribution with a server sets the error caching minimum TTL to 0 for 500, 501, 502, 503 and 504 (CloudFront caches these for 10 s by default, and caches 500 and 502-504 whatever their `Cache-Control` says), keeping any error page configured for them.

  The SSR cache policy's maximum TTL (and the server-route cache policy of the CloudFront-over-ALB front door) is lowered from 1 year to 1 day, so an origin `s-maxage` longer than a day is clamped to a day.

  On a Lambda Web Adapter server the guard is loaded through `NODE_OPTIONS` (`--import`); a `NODE_OPTIONS` set in `compute.environment` keeps the guard loaded first.

- d51b8ee: Add `KnowledgeBase.asAgentTool()`, which returns a search tool for an Agent's `tools` callback. The model supplies only the query; a required `filter` callback derives the metadata filter from the per-call tool context (set from the authenticated session), and the tool is marked `untrustedOutput: true` so retrieved text reaches the model as data. A `filter` result other than `undefined` must narrow the search (`null`, `{}` or a missing `equals` fails the call), and `maxResults` is checked when the tool is defined. The umbrella package re-exports the new `KnowledgeBaseAgentTool`, `KnowledgeBaseAgentToolOptions` and `KnowledgeBaseAgentToolResult` types.
- 2095f31: fix(core): `ctx.request.url.pathname` no longer includes the API Gateway stage when deployed

  On AWS, a `RawRoute` handler's `ctx.request.url` had the API Gateway stage in front of the path (`/prod/bench/me`), while `npm run dev` gave the route path (`/bench/me`). A handler that sub-routed on `url.pathname` passed every local test and returned its own 404 for every request after deploy. Behind `Hosting`, the stage wasn't part of the browser's URL either.

  `ctx.request.url.pathname` is now the route path in every environment, on Lambda and on a container compute, which took the stage from the front door's `x-blocks-forwarded-stage` header. The origin is unchanged: on AWS it is still the host the backend received, which behind a front door is the API Gateway host. An HTTP API `$default` stage is no longer prepended either, and a request path starting with `//` no longer changes the URL's host.

  This is a `minor` bump because it changes an existing value. If you build an absolute link from `ctx.request.url.pathname` or `href` while clients call the API Gateway URL directly, add the stage yourself, or build the link from your app's configured origin. The likeliest such code resolves a relative path against the request URL: `new URL('next', ctx.request.url)` used to give `/prod/…/next` and now gives `/…/next`. Building Block authors who need the externally reachable base, stage included, can use the new `getRequestBaseUrl(ctx)` from `@aws-blocks/core/bb-utils`; every transport sets it for every request it dispatches.

  `@aws-blocks/bb-auth` now takes the stage for its fallback callback URL (the direct engine's `redirect_uri` when no public origin is configured) and its stub IdP issuer from `getRequestBaseUrl()`, so those URLs are unchanged.

  The `@aws-blocks/bb-container-compute` design notes now say that the stamped stage goes to `getRequestBaseUrl()`, not to the request path.

- 42b84b2: feat(bb-realtime): add `getChannel(namespace, channel, { scope: 'exact' })` and validate channel names

  A channel handle's token authorizes its channel and every `/`-separated sub-channel under it, so a handle for `tenants/acme` also opens `tenants/acme/billing`. This was not documented, so a naming scheme that nests one principal's channels under another's could hand out more access than intended.

  - **`getChannel()` takes an optional `{ scope }`.** `'subtree'` is the default and keeps today's behaviour. `{ scope: 'exact' }` mints a token that authorizes the channel only; a subscribe to any sub-channel with it is rejected. `GetChannelOptions` is exported from `@aws-blocks/bb-realtime` and `@aws-blocks/blocks`.
  - **Tokens stay compatible.** The default token is byte-for-byte the format issued before, so tokens from an older deployment keep validating with the same scope. An exact token carries its channel under a new `exact` key instead of `channel`, so a deployment from before this release refuses it (the handle stops working) rather than granting it sub-channel access, for example on a warm container during an update or after a rollback. Native clients pass tokens through unchanged.
  - **Channel names are validated.** `publish()`, `subscribe()` and `getChannel()` now throw `RealtimeErrors.ValidationFailed` for a channel name that is empty, starts or ends with `/`, contains an empty segment (`a//b`), or has a `.` or `..` segment, and for a channel that isn't a string or a number (`undefined`, `null`, an object). `/` between non-empty segments is still allowed, and a number is validated as its string form. If your app builds channel names from user input, check that the result can't be empty or contain these segments.
  - **bb-agent `stream()` and `resume()`** throw `AgentErrors.InvalidUsage` before dispatching a turn when the `channelId` and `userId` don't form a valid channel name (for example a `channelId` of `a//b` or a `userId` of `..`), instead of returning a stream whose chunks all fail to publish.
  - **The `default` and `react` create-blocks-app templates** pass `encodeURIComponent(user.username)` as the channel name, so a username can't add `/` segments.
  - **Server-side `subscribe()`** now uses an exact token for its own WebSocket subscription; it only ever subscribes to that one channel, so nothing changes for callers.

  The README's new "Sub-channels and access" section explains how a channel name maps to access, with the per-tenant pitfall as the example. Use `{ scope: 'exact' }` whenever a sub-channel of a handle's channel can belong to someone else.

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

### Patch Changes

- 3d7479a: fix(bb-agent): report a turn that failed while the chat was disconnected

  If the chat's connection dropped and the turn failed before it reconnected, the `error` chunk was lost. `createChat` and `useChat` then kept loading for about 11 minutes and reported "Timed out waiting for the agent to respond after reconnect." instead of the real error.

  On reconnect, both clients now recognize the row the backend saves for a failed turn, including a turn a `maxLlmCalls` or `maxToolIterations` cap stopped, whose partial text they keep. They end the turn right away and pass the recorded error to `onError`, typed the same way as a live `error` chunk (for example `AgentErrors.ModelUnavailable`). When the previous turn also failed, the saved row could be that turn's, so the client keeps waiting for the turn as before.

- c6a3357: `AppSetting.put()` on AWS now enforces the documented 4 KB limit before writing, the same way the local mock does: a non-secret value whose JSON serialization exceeds 4096 UTF-8 bytes throws `AppSettingErrors.ValidationFailed` and is not sent to SSM. Previously the AWS path sent every value to SSM, so a value the mock rejects with `ValidationFailed` was left to SSM's own limit check on AWS, which fails with an unnamed SDK exception. Both paths now share one check, called after schema validation.
- 5f55dac: `AppSetting`'s CDK construct now exposes two read-only properties at synth time: `parameterName`, the SSM parameter name the setting resolves to (the explicit `name`, the `AppSetting.fromExisting()` name, or the derived default `/<fullId>`), and `secret`, whether the parameter is a SecureString. Other Building Blocks' CDK layers can now reference the exact parameter instead of assuming the default name, so a secret created with a custom `name` or via `fromExisting()` can be passed where a Building Block needs a secret. The local and Lambda runtime APIs are unchanged.
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
- 5f55dac: The cookie helpers' documentation now names `bb-auth` as their caller and refers to `bb-auth-basic`, `bb-auth-cognito` and `bb-auth-oidc` as the removed blocks they replaced.
- 5f55dac: Auth broadcasts are tagged per API, so `onAuthChange` for one API no longer receives another API's user. With two auth blocks on one page, signing in to one no longer hands its user to the other's listener (typed as the other's user), in this window or in another tab, and the other block's store no longer refetches.

  `submitAuthAction` tags its sign-in and sign-out messages with the RPC namespace of the API it ran on (a generated client now answers `Symbol.for('aws-blocks.apiNamespace')` with it), and `broadcastAuthChange(user, api)` takes an optional `api` to do the same. An untagged message still reaches every API's listeners: `broadcastAuthChange(user)` without an `api`, and a message from a tab running an older `@aws-blocks/auth-common`. An API that is not a generated client (a hand-written `AuthStateApi`) has no namespace: `submitAuthAction` on it sends untagged broadcasts, and its listeners and store receive every message, tagged or untagged. The message format (the `blocks-auth` channel and the `blocks-auth-change` window event, `{ type: 'auth-change', user }`) only gains the optional `api` field, so tabs running an older bundle keep working.

- 5f55dac: Docs: the `AuthFieldOverride` reference documentation no longer names `bb-auth-supabase`, a package AWS Blocks does not ship.
- 5f55dac: Federated sign-in callbacks compare the returned `state`, and the ID token's `nonce`, in constant time, so response timing reveals nothing about a guessed value. A `state` or `nonce` of the wrong length or encoding is rejected with the usual `InvalidStateException` or `IdpErrorException`.
- 5f55dac: `auth.createApi()` is typed by the block's options, so the frontend gets the same gates as the server-side methods, and the signed-in user with its own groups and attributes.

  - **Actions.** `setAuthState` takes `AuthActionInputOf<O>`: the password actions (`signIn`, `signUp`, `confirmSignUp`, `resendSignUpCode`, `autoSignIn`, `resetPassword`, `confirmResetPassword`, `confirmSignIn`) need email + password, the passkey actions need `passkeys`, and `confirmSignIn` takes only the challenges the configuration can produce: the MFA challenges follow `mfa.types` (and `mfaType` is one of them), and the first-factor ones need `users.authFlow: 'USER_AUTH'`. On an `emailPassword: false` block, `authApi.setAuthState({ action: 'signIn', username, password })` and `submitAuthAction(authApi, { action: 'signIn', … })` are compile errors. A setting the compiler cannot see (the wide `Auth` type, a `boolean`-typed option, a union `authFlow`, a wrapped pool, `mfa.types` typed `MfaFactor[]`) keeps its actions.
  - **User.** `AuthState.user` is `AuthStateUser<O>`: the signed-in `AuthenticatedUser` (`groups` typed by `users.groups`, `attributes`, `userSub`, `signInProvider`) without the server-only `claims` and `federatedIdentity`. `onAuthChange`, `AuthenticatedContent`, `subscribeAuthState`, `getAuthStateSnapshot` and `submitAuthAction` pass it on, so `onAuthChange(authApi, (user) => user?.groups)` compiles with no cast and no `api.me()` endpoint. `AuthUserOf<typeof authApi>` names the type.
  - **`@aws-blocks/auth-common`.** `AuthStateApi` and `AuthState` now take these as optional type parameters (`AuthStateApi<I, U>`, `AuthState<U>`), defaulting to `AuthActionInput` and `AuthUser`, so code that names them, and helpers such as `Authenticator(api)`, accept every narrowed API unchanged; `AuthStateUser` is an `AuthUser`. A custom renderer that builds a wide `AuthActionInput` from runtime `action.fields` takes the API as a plain `AuthStateApi`, as `Authenticator` does. `submitAuthAction`, `subscribeAuthState`, `getAuthStateSnapshot`, `onAuthChange` and `AuthenticatedContent` are now generic over the API you pass (`submitAuthAction<A extends AuthStateApi<never>>(api: A, input: Parameters<A['setAuthState']>[0])`), and type-check on TypeScript 5.0 and later.
  - **Federated sign-in** is not a `setAuthState` action: it is a browser redirect, the `signIn:<id>` action's `url`. `FederatedActionNameOf<O>` types those names.
  - **Native clients.** The narrowing is TypeScript-only. The OpenRPC spec describes `setAuthState`'s input and `AuthState` in their wide form, so differently configured blocks generate the same native types; the server enforces each block's configuration.

  New types: `AuthActionInputOf<O>`, `AuthStateApiOf<O>`, `AuthStateUser<O>`, `ConfirmSignInInputOf<O>`, `FederatedActionNameOf<O>` and `AuthUserOf<A>`.

- 2eb62fa: The `hasAuthError` example in the `@aws-blocks/core` README and JSDoc now submits the action with `submitAuthAction` from `@aws-blocks/blocks/ui` and imports `hasAuthError` from `@aws-blocks/blocks/client`. The old example called `authApi.setAuthState()` directly, which signs the user in but never notifies `onAuthChange` or `AuthenticatedContent`, so a custom form built from it stayed on the sign-in screen. The `installCookieJar` documentation from `@aws-blocks/blocks/utils` now shows up in editors, because it is attached to the function instead of an internal variable.

  The `AGENTS.md` that `create-blocks-app` adds to new apps now says that `onAuthChange` fires for sign-ins and sign-outs made through `Authenticator` or `submitAuthAction`, lists `submitAuthAction` for custom auth forms, and warns that a direct `authApi.setAuthState()` call notifies nothing on the page.

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

- 5f55dac: What `bb-auth migrate` does with imports:

  - `@aws-blocks/bb-auth-cognito/ui` imports move to `@aws-blocks/bb-auth/ui`, and their names are renamed to `Auth`'s (`cognitoOverrides` → `authOverrides`, `CognitoActionName` → `AuthActionName`, `CognitoNextStepName` → `AuthNextStepName`, `CognitoActionFields` → `AuthActionFields`, `CognitoActionOverride` → `AuthTypedActionOverride`, `CognitoAuthenticatorOptions` → `AuthTypedAuthenticatorOptions`) along with every place they're used.
  - Names imported from `@aws-blocks/bb-auth-oidc/client` or `/middleware` that `@aws-blocks/bb-auth` also exports move there. The rest (`AuthOIDCClient`, `handle401`, …) stay where they are, with a TODO that names them.
  - `import * as blocks from '@aws-blocks/blocks'` is followed: `new blocks.AuthCognito(…)`, `blocks.AuthCognitoErrors`, `blocks.CognitoUser` and the other old names are rewritten, the options are mapped, and the block id is never changed.
  - Old imports that end up on the same module are merged into one import.
  - An import whose name list would end up empty is left as it is, with a TODO, and the summary lists the file under "needs attention" instead of with the rewritten files.

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
- 5f55dac: `Auth` rejects `emailPassword: false` combined with `mfa` (other than `'off'`), `passkeys` or `users.deviceTracking` when you construct it, in `npm run dev`, at synth and in Lambda alike: these options apply only to email + password users, and federated users get MFA and passkeys from their identity provider. The error names each conflicting option and `emailPassword: false`, for example ``Auth 'auth': `mfa: 'required'` needs email + password sign-in, which `emailPassword: false` disables.`` `passkeys` without `users.authFlow: 'USER_AUTH'` is refused the same way at construction, as well as at synth, so `npm run dev` and Lambda reject a passkey configuration the pool cannot serve. The README quotes the exact compiler error for a gated call, and recommends keeping options in a variable declared `as const satisfies AuthOptions` (plain `satisfies AuthOptions` widens declared `users.groups` to `string[]`).
- 5f55dac: Only the `Auth` block that owns a user pool's PreSignUp trigger answers it. So when one `Auth` creates a pool with `validateUser` and another wraps that pool with `userPool: Auth.fromExisting(…)` (for example, to use `admin`), the second block can't take over the trigger, and `validateUser` still runs for sign-ups made directly against Cognito.

  Two `Auth` blocks claiming one user pool's PreSignUp trigger fail `cdk synth`, naming the event key and both blocks, like other Building Blocks that would handle the same Lambda event.

- 5f55dac: `Auth` has `protect()`, for an API namespace that is deny by default. `auth.protect(scope, 'notesApi', { public: (context) => ({ ...methods }), methods: (context, user) => ({ ...methods }) })` returns an ordinary `ApiNamespace`. For each call to one of its `methods`, the session is checked first, and only then is the `methods` factory called, once, with the signed-in user, typed by the block's options (`AuthenticatedUser<O>`). So nothing in it runs for a signed-out caller, and a forgotten guard, or one called without `await`, can't leave a method open. A signed-out call to any name that isn't a `public` method gets 401 `NotAuthenticatedException`, whether or not the method exists, so the protected methods can't be listed without a session; a signed-in caller gets "method not found" for an unknown name. `public` methods (optional) run as in a plain `ApiNamespace`. A name defined in both is a compile error. With `{ role: 'admin' }` as the last argument, every protected method also requires that group, as `requireRole` does (401 first, then 403 `NotAuthorizedException`); `compute` and every other `ApiNamespace` option go in the same object and are passed on to the namespace. It works the same locally and on AWS, and the frontend calls every method like any other namespace. Existing `ApiNamespace` code is unchanged.

  The OpenRPC spec (`blocks-generate-spec`) describes every method of a `protect()` namespace, public and protected, and warns, naming the namespace, if it can't list them. It also now describes the parameters of a namespace typed through a mapped type, such as one returned by a factory, by name and type, instead of as a single `args` parameter.

  The `Auth` README has a "Protect every method" recipe. The `ApiNamespace` docs and the scaffolded `AGENTS.md` now recommend `auth.protect` for namespaces with signed-in methods, and say that a guard which isn't awaited protects nothing. The templates don't add a floating-promise lint rule: Biome's `noFloatingPromises` doesn't flag an un-awaited `requireAuth` / `requireRole` call, so `protect` is the safeguard.

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
- 1c7e0dd: `@aws-blocks/auth-common/cookies` adds `isLocalDevRequest(ctx)`, the per-request `isLocalhost` input for the session-cookie security policy. It is `true` only when the process itself is local, as reported by `getDeploymentType()` from deploy configuration, and the request comes from a loopback origin. On deployed compute it is always `false`, so a request that sends `Origin: http://localhost` cannot drop `Secure` (or, with `crossDomain: true`, `Partitioned`) from the cookie. `isLoopbackRequest(ctx)` stays exported and unchanged.
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

- 5f55dac: `Auth`'s signed-in user (`AuthenticatedUser`) has an optional `claims` field: the provider's verified claims for users of a `store: 'builtin'` block (an OIDC, OAuth 2.0 or stub IdP provider verified by your backend), as `AuthOIDC`'s user carried. With `db.crud()` or `db pull`'s `supabaseCrud()` and Postgres row-level security, RLS therefore sees the identity provider's raw `sub` as `request.jwt.claims.sub` for those users, as it did with `AuthOIDC`, so policies that match the raw `sub` keep returning rows after the move to `Auth`. `claims` is absent for user-pool users, whose RLS subject is their `userId`. `claims` is server-side only: `getAuthState()` and the sign-in routes never send it to the browser.

  `@aws-blocks/bb-data`: newly generated `supabaseCrud()` wiring now passes `claims` to RLS explicitly, and the generated `MIGRATION_GUIDE.md` now says which subject RLS sees for each kind of user.

- 5f55dac: feat(bb-auth): `validateUser` also guards users created outside your app, through a Cognito PreSignUp trigger

  When you set `validateUser` and `Auth` creates the user pool, the pool gets a Cognito PreSignUp trigger that runs your `validateUser` in your backend Lambda. It checks every user Cognito is about to create, including the ones your app never sees: a `SignUp` sent straight to Cognito with the app client id, an `AdminCreateUser` from the console or CLI, and the first sign-in of a social, SAML or Cognito-federated OIDC user (a `providers` entry on the default store).

  - `auth.signUp()` runs `validateUser` first, in your request, and the trigger recognises that sign-up, so the check runs once. `auth.admin.createUser()` runs it too (`phase: 'signUp'`, `provider: 'password'`).
  - A rejection in the trigger reaches the client with the same `AuthErrors` name and message you threw, masked the same way as in-process. The trigger never confirms or verifies a user.
  - Without `validateUser`, no trigger is added. Adding or removing the option later updates the pool in place. On a pool wrapped with `userPool: Auth.fromExisting(...)`, no trigger is attached and synth warns.
  - Cognito waits at most 5 seconds for the trigger, and a cold start of your Lambda counts, so keep `validateUser` fast.

- 5f55dac: `Auth` synthesizes when you vendorize it (`npm run vendorize -- Auth`). A vendorized copy contains only the TypeScript sources, so the handlers of the deploy-time Lambdas `Auth` creates — the user-pool immutability guard (every `Auth` with a user pool) and the identity-provider registration (social, SAML and Cognito-federated OIDC sign-in) — are bundled from the vendorized source at synth, and your edits to them deploy too. Installed (non-vendorized) apps use the pre-built handlers. Bundling uses your app's `esbuild`, which AWS Blocks apps already have as a dev dependency; if it is missing, synth tells you to install it.
- 5f55dac: Error messages sent to clients never include Amazon Cognito's raw text, as in `AuthCognito` 0.1.11.

  Cognito's error messages can quote the request (a username, a rejected value) or name an endpoint, a role or your AWS account. `Auth` sends a fixed message for each error `name` instead (for example `Invalid parameter` for `InvalidParameterException`), from every method, `auth.admin.*` and the `createApi()` Authenticator state, and the same message under `npm run dev` as on AWS. Cognito's own text is written to the server log, with the user's login redacted. Error `name`, HTTP status and `retriable` are not affected, so code that matches errors with `isAuthError` works as usual. If you show `error.message` to users, they see the short fixed message (for example, `Invalid parameter` rather than the attribute Cognito rejected). A weak password is the one exception: its message is written from the password policy you configured, for example `Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number and a symbol.`, the same under `npm run dev` as on AWS. A pool you wrap with `Auth.fromExisting` keeps the fixed `Password does not meet the password policy`, because `Auth` doesn't know its policy. Errors you throw yourself as an `ApiError`, for example from `validateUser`, keep your message.

- efe28cb: The `MIGRATION_GUIDE.md` that `bb-data pull` generates for Supabase apps now says which token must carry the non-standard JWT claims your RLS policies read: the one `Auth` verifies, which is the ID token for browser sessions and the access token for `Authorization: Bearer` API callers (it said the access token only).
- 5f55dac: `getSdkIdentifiers(auth)` for an `Auth` block is typed with optional fields (`userPoolId`, `clientId`, `region`, `hostedUiDomain`, `hostedUiClientId`), matching what `Auth` registers. An `Auth` with `store: 'builtin'` has no user pool and registers none of them, so code that reads `userPoolId` must check that it is defined.

  The sign-in pricing tables (`Auth`'s "Which option and why" and the umbrella's "Choosing a sign-in method") note that Cognito's Plus plan has no free tier for email + password and social users ($0.020 per MAU), confirm that SAML / OIDC federated users cost $0.015 per MAU above 50 on every plan, and cite the Cognito pricing page and the date it was read.

- b2eb306: fix(blocks): `cdk-blocks` help never runs a command, and confirmations name the real credentials

  - Help never runs a command. `-h` or `--help` anywhere after `cdk-blocks secret`, `cdk-blocks config`, `cdk-blocks db` or `cdk-blocks vendorize` shows help instead of running the tool with your arguments, so `cdk-blocks config remove KEY --help` never deletes `KEY`. `cdk-blocks help secret remove KEY` and `cdk-blocks db pull ./out --help` forward only `remove --help` or `pull --help` to the tool, which prints that command's usage; `cdk-blocks help vendorize <package>` and `cdk-blocks vendorize <package> --help` print the CLI's help. `blocks-vendorize --help` prints its usage and exits before it copies or installs anything.
  - Confirmations name the real credentials. `cdk-blocks destroy`, `cdk-blocks deploy` and the sandbox commands describe the credentials as the deploy does, for example `access keys in AWS_ACCESS_KEY_ID (used instead of AWS_PROFILE)`. When environment access keys override an exported `AWS_PROFILE` or `--profile`, they print a warning, even with `--quiet`.
  - `--verbose` masks the password of a URL (`postgres://user:***@host`) and the value of `--url` when it echoes a child command line.
  - `--region` and `AWS_REGION` must be an AWS Region code such as `us-east-1`, `us-gov-west-1` or `cn-north-1`; anything else is a usage error (exit 2). On Windows, the sandbox dev command refuses a path that contains `"` or `%`, which the Windows shell cannot quote safely.

- b2eb306: fix(blocks): `cdk-blocks` output streams, non-interactive runs and usage errors

  - `--no-input` and `CI` reach `cdk-blocks secret`, `cdk-blocks config` and `cdk-blocks db pull`: a value prompt that the run cannot show is a usage error (exit 2) naming `--value-stdin`, even on a terminal. A missing key, an unknown subcommand, a missing flag value, an unknown `db` verb (with a suggestion) and an unconfirmed `secret remove --force` also exit 2. The global `--yes` confirms `secret remove --force`, as `--yes` after the command does.
  - `--quiet` does not hide the dev server's RPC errors; it sets only `BLOCKS_LOG_LEVEL=quiet`. A `BLOCKS_DEV_QUIET` you set yourself still applies.
  - Text output: the CLI runs core with `BLOCKS_LOG_STREAM=stderr`, so progress, CDK milestones, raw CDK output and streamed CloudFormation events go to stderr, and stdout keeps the deployment target, `BLOCKS_DEPLOYED` and the final URLs. `cdk-blocks generate spec` follows it too: its progress lines go to stderr, and stdout keeps the `✅ OpenRPC spec written to …` line.
  - `cdk-blocks deploy` and `cdk-blocks sandbox deploy` print no JSON or `--query` result after a failed or interrupted run. The result comes from `.blocks-sandbox/last-deploy.json`, which the deploy runner writes: the stack outputs core read when it deployed, so a concurrent deploy of the other stage that rewrites `.blocks-sandbox/outputs.json` cannot change or empty it, and the account and Region the deploy itself used. When the runner recorded no result, the command exits 1 with an error instead of printing null fields.
  - A closed terminal no longer makes `cdk-blocks deploy` exit 1 while the deploy goes on: the runners other than the dev server run as `node --import` with the `tsx` loader, with no `tsx` process between the CLI and the runner, and the CLI reports the deploy's own exit code and result.
  - Arguments after `--` are rejected with exit 2 (`unexpected arguments after --`) for commands that do not forward them, instead of being dropped.
  - `--telemetry-file <path>` (or `--telemetry-file=<path>`) is a global option. The CLI passes it, as an absolute path, to the lifecycle runners, where core's telemetry client reads it, so `npm run dev -- --telemetry-file=/tmp/events.json` captures events as it did with the scripts.
  - `cdk-blocks sandbox --deploy-only` runs `cdk-blocks sandbox deploy`, as a hidden alias of the old script flag.
  - `package.json` `"blocks": { "dev": { "frontend": false } }` runs the backend only, as `--no-frontend` does, even when `vite` or `next` is installed. It cannot be combined with `frontendCommand` or `frontendPort`.
  - A `--host` or `blocks.dev.host` is also exported to the dev server as `BLOCKS_DEV_HOST`, so the local realtime WebSocket (`/realtime`) accepts that host's origins, as it does for a `BLOCKS_DEV_HOST` you set yourself; a `BLOCKS_DEV_HOST` already in the environment is kept.
  - A `package.json` that starts with a UTF-8 byte order mark is read as npm reads it, so `cdk-blocks dev`, `cdk-blocks dev stop` and the sandbox commands accept it instead of failing with `cannot read …/package.json`.
  - Global options apply after `secret`, `config`, `db` and `vendorize` too, up to a `--`: `cdk-blocks secret remove KEY --profile prod` deletes in that profile's account, and `cdk-blocks config set KEY value --output json` exits 2, instead of the CLI forwarding the options to the tool, which wrote them into the value or a file name, or ignored them. Global options can also sit between the words of a command (`cdk-blocks generate --debug client`), and before the command they take the same forms as after it (`-qv`, `-C<dir>`). `--version` after any command prints the version and runs nothing.
  - `--output json` and `--query` exit 2 with `… is not supported for "cdk-blocks <command>"` on a command without a JSON result, after the command name as before it, and without a command. A single-valued global option given twice with different values (`--cwd a -C b`), `-C` naming a file, `-y=false` and `-C=<dir>` are usage errors; `--port -1` takes `-1` as the value; `cdk-blocks --region <bad> help` shows the help.
  - `--query` checks the whole path against the command's result before the command runs, so `cdk-blocks dev stop --query stopped.0.nope` or `cdk-blocks deploy --query apiUrl.x` exits 2 without stopping a server or deploying. A list element is named by its index (`stopped.0.port`); an element past the end of a list, as in an empty `stopped`, prints an empty line.
  - The help of a `db`, `secret` or `config` verb (`cdk-blocks secret set --help`, `cdk-blocks help db pull`) works outside an app too, instead of failing with `not inside an AWS Blocks app`.
  - `cdk-blocks vendorize` without a package, with two packages or with an option other than `--force` is a usage error (exit 2), with one `Error:` line, instead of the tool's usage and `cdk-blocks vendorize failed (exit code 1)`.
  - Error hints say only what helps: `Run with --verbose for the full tool output` follows a failed lifecycle runner, whose output `--verbose` extends; a failed `db`, `vendorize` or `generate client` says that the tool's own output is above; `--debug` prints the stack trace of an error the CLI raised itself too. A runner prints a failure's message, and its stack trace only with `--debug`. The command line that `--verbose` echoes is quoted for a POSIX shell, so a path with a space or the runner's JSON options can be pasted back.
  - A Ctrl-C that reaches a command after its tool finished (`cdk-blocks db migrate` applied every migration and exited 0) reports the tool's success, exit 0, instead of `interrupted` and 130. `cdk-blocks dev` and `cdk-blocks sandbox`, which exit 0 when Ctrl-C stops them, still exit 130.
  - A relative path given to `cdk-blocks db` or to `cdk-blocks generate types --out`/`--include` is resolved from the directory you run the command in (or `-C`), as `cdk-blocks generate client` and `generate spec` already did, instead of from the project root. `cdk-blocks db` drops the `--` that ends the CLI's options instead of forwarding it to bb-data as a directory name.
  - `cdk-blocks generate types` rejects `--check` with `--watch`, and an empty `--out`, `--include` or `--module`, as usage errors (exit 2), instead of passing them to typegen, which failed with exit 1 or wrote an invalid `declare module ""`.
  - `cdk-blocks generate client <foundation> <output>` and `cdk-blocks generate spec <backend> [output]` run outside an app, as `blocks-generate-client` and `blocks-generate-spec` did; only their default paths need one.
  - A typo of a hidden alias suggests the canonical command: `cdk-blocks consol` suggests `sandbox console`, `cdk-blocks typegn` suggests `generate types`.
  - A relative `--telemetry-file` is resolved from the directory you run the command in for the commands that run core in the CLI process too (`cdk-blocks sandbox console`), instead of from the project root.
  - `cdk-blocks telemetry enable|disable` outside an app is a usage error that suggests `--global`, instead of writing a `.blocks/config.json` into the current directory; `cdk-blocks -C <dir> telemetry` reads `<dir>`, not the shell's directory.
  - `cdk-blocks destroy` prints the target with `.env.production` applied, as `cdk-blocks deploy` and `cdk-blocks whoami` do, and core's destroy now uses it too, so all three name the same credentials and Region.
  - `cdk-blocks destroy` passes the stack it names to core, so destroying a production stack that does not exist (already deleted, or another Region) says there is nothing to delete instead of `✅ Production stack destroyed!`. `cdk-blocks sandbox destroy` on a machine with no `.blocks-sandbox/sandbox-id.txt` says there is no sandbox to delete and exits 0, without creating a sandbox id or running cdk.
  - An explicit `--profile` wins over access keys in the environment: the CLI empties `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` (and their `AMAZON_` names) for the run, so neither the shell nor a stage env file can make CDK or `cdk-blocks whoami` use another account, and says so on stderr. `cdk-blocks whoami` prints the same warning as `deploy` and `destroy` when exported keys win over an exported `AWS_PROFILE`.
  - `cdk-blocks deploy` checks the `--wait-live` budget before anything runs: `--wait-live=SECONDS` and `--wait-live-timeout=SECONDS` take a whole number from 1 to 3600, `--wait-live-timeout` needs `--wait-live`, and the budget is given once. Anything else exits 2, instead of deploying with a warning about the default budget, or silently ignoring the flag.
  - `cdk-blocks sandbox console` opens this machine's sandbox stack, in the Region it was deployed to (from `last-deploy.json`, else the sandbox's configured Region with `.env.local`), instead of the first stack in `.blocks-sandbox/outputs.json`, which is the production stack after a `cdk-blocks deploy`. Without a sandbox id or a recorded deploy of the sandbox it exits 1 and suggests `cdk-blocks sandbox deploy`.
  - After a successful `cdk-blocks sandbox destroy`, the CLI removes the deleted sandbox from `.blocks-sandbox/last-deploy.json` and `outputs.json`, and removes `config.json` when the sandbox wrote it, so `cdk-blocks sandbox console` and the frontend no longer point at the deleted stack. The sandbox id and the production records stay.
  - Credential, bootstrap and sandbox recovery guidance names the `cdk-blocks` command that was run, with its `-C`, `--profile` and `--region`, for example `Then re-run \`cdk-blocks deploy --profile prod\`.`, instead of `npm run deploy`, `npm run sandbox`(for`sandbox deploy`too) or`npm run sandbox:destroy`, which an app without those scripts does not have.
  - `cdk-blocks destroy` refuses, deleting nothing, when the CDK app does not define the `<stackId>-prod` stack it names and asked to delete (for example an older app whose `index.cdk.ts` names its own stack). `cdk-blocks deploy` warns when CDK deployed another stack than `<stackId>-prod`. Without a `stackId`, both say which id to choose and add a `Try:` line that lists the existing production stacks.
  - `cdk-blocks whoami` tells a malformed `.blocks/config.json` (`(invalid .blocks/config.json)`, with the parse error as a warning) from a missing file or a missing `stackId`; `cdk-blocks deploy` and `destroy` print the parse error.
  - `cdk-blocks whoami --profile <name>` for a profile that does not exist says the profile is not in your AWS config, instead of "no AWS Region is set".
  - A SIGTERM or SIGHUP sent to the pid of `cdk-blocks dev` alone (`kill <pid>`, an IDE stop button, a harness) stops the dev server and its frontend at once, as one sent to its process group does, instead of after 10 s. `cdk-blocks sandbox` in watch mode stops at once too.
  - `cdk-blocks dev` exits 1 with the reason when its dev server fails to start (another dev server owns the port, the bind fails), instead of waiting for a file change forever. Stopping `cdk-blocks dev` while its backend is not running (`cdk-blocks dev stop` after a crash, or a SIGTERM) exits 0 instead of reporting `failed (exit code 143)`.
  - `--port`, `--frontend-port` and the `blocks.dev` ports accept only decimal port numbers from 1 to 65535: `1e3`, `0x10`, `0b…`, `" 41082 "` and `-1` are usage errors (exit 2) that name the value, instead of binding port 1000 or 16.
  - `cdk-blocks dev stop --all --port N` and `cdk-blocks cleanup --port N` are usage errors (exit 2), instead of ignoring `--port` and stopping every recorded dev server.
  - `cdk-blocks dev stop` reads only `blocks.dev.port`, so it stops the server while another `blocks.dev` setting is invalid. `cdk-blocks dev`, `dev stop` and `sandbox` warn about a `blocks.dev` key that nothing reads (a typo such as `prot`), with the nearest setting; `generateClient` is accepted.
  - `cdk-blocks dev stop` without `--port` stops the only dev server the app recorded when none is recorded on the configured port (a server started with `cdk-blocks dev --port 4000`), and says which port. With several recorded, it lists them and points to `--port` and `--all`.
  - `cdk-blocks dev` and `cdk-blocks sandbox` warn when a `frontendCommand` you set (`--frontend-command` or `package.json`) does not contain the frontend port the dev server proxies to, as with a hard-coded `npx vite --port 3100` and `--frontend-port 41079`, which answered 502. The README example config no longer sets `frontendCommand`.
  - Ctrl-C or Ctrl-D at the hidden prompt of `cdk-blocks secret set` or `cdk-blocks config set` exits 130 with `Interrupted; nothing was set.`, instead of exit 13 and Node's "unsettled top-level await" warning.
  - `cdk-blocks secret set KEY` and `config set KEY` with stdin that is not a terminal say `stdin is not a TTY`, instead of blaming `--no-input or CI` when neither was set.
  - A bare `cdk-blocks secret` or `cdk-blocks config` exits 2 with `needs a verb: set, list or remove` and its help command, instead of `Unknown subcommand undefined`. An invalid key and an empty value exit 2, with no `--verbose` hint.
  - `cdk-blocks generate client -q` (and `blocks-generate-client` at `BLOCKS_LOG_LEVEL=quiet`) hides the warnings that loading the backend prints, such as `[Realtime] BLOCKS_RT_WS_URL not set`, which say nothing about the generated client.
  - `cdk-blocks db --help` shows `cdk-blocks db migrate aws-blocks/migrations` and `cdk-blocks db status aws-blocks/migrations`, the migrations directory of the templates, instead of examples that fail with `Migrations directory not found: ./migrations`. `cdk-blocks db <verb> --help` prints `Usage: cdk-blocks db <verb> …`, not `Usage: bb-data <verb> …`.
  - A SIGTERM, SIGINT or SIGHUP sent to `cdk-blocks generate client` (or `blocks-generate-client`) alone reaches the client generator, and the command ends after it, instead of leaving the generator running to write `aws-blocks/client.js` after the command reported a failure.
  - `cdk-blocks generate client` and `cdk-blocks generate spec` report a missing backend the same way, `cannot find the backend entry at <path>.` with exit 1, before anything runs (`generate client` exited 2). A backend that does not load (a syntax error) gives a one-line `❌ Client generation failed: …` with exit 1, as `❌ Spec generation failed: …` does, instead of a raw Node stack trace; both print the stack with `--debug`.
  - A `db`, `vendorize` or `generate` tool stopped by a signal fails with `<tool> was stopped by SIGTERM.`, without `its output is above`, which it may not have printed. `cdk-blocks generate spec` fails as `cdk-blocks generate client` does: `blocks-generate-spec exited with code 1; its output is above.`
  - A `cdk-blocks dev` startup refusal (another dev server on the port, a port in use) prints its reason once: the runner's `❌` message, then exit 1, without an `Error:` line repeating it.
  - `cdk-blocks generate spec <backend>` outside an app runs from the backend's directory, so the backend's local mock storage (`.bb-data/`) is not created in the directory you run it from.
  - `cdk-blocks generate types --out <dir>` naming a directory is a usage error (exit 2), instead of a raw `EISDIR` error.
  - `cdk-blocks generate client` in an app whose `package.json` sets `"blocks": { "dev": { "generateClient": false } }` (the Amplify overlay) refuses to replace `aws-blocks/client.js`, with exit 2 and the hint `npm run blocks:generate-client`; `--force` writes it anyway.
  - A single-valued command option given twice with different values (`cdk-blocks dev stop --port 1 --port 2`) is a usage error, as for global options. `cdk-blocks dev --port N stop -h` shows the help of `cdk-blocks dev stop`, the command the run names. A global value option without a command (`cdk-blocks --profile deploy`, where `deploy` became the profile) exits 2 instead of printing the help with exit 0.
  - `cdk-blocks deploy --wait-live-timeout=0` without `--wait-live` suggests `--wait-live=SECONDS`, not a value `--wait-live` rejects. The `aws cloudformation describe-stacks` hint for a missing stackId passes the run's `--profile` and `--region`.
  - A `cdk-blocks deploy --wait-live` whose liveness wait fails still records the deploy in `.blocks-sandbox/last-deploy.json` and, with `--output json` or `--query`, prints its result with `"live": false`; it exits 1 with `cdk-blocks deploy deployed the stack, but --wait-live could not confirm that the new build is live`, not `cdk-blocks deploy failed`. The `cdk-blocks deploy` JSON result has a `live` field: `true` when `--wait-live` confirmed the build, `null` without `--wait-live` or a frontend.
  - `cdk-blocks sandbox` (watch mode) records the sandbox deploy in `last-deploy.json` after its first deploy, as `cdk-blocks sandbox deploy` does, so `cdk-blocks sandbox console` still opens the running sandbox after a production deploy rewrote `.blocks-sandbox/outputs.json`.
  - `cdk-blocks dev` exits 1 when its dev server fails on its first start (a backend that throws while it loads, an import that does not resolve, an unreadable file, a malformed `.env.local`), instead of exiting 0: `tsx watch` ignores the runner in `node_modules` and ended by itself. A dev server that dies before anything stopped it (out of memory, `kill -9`) and leaves `tsx watch` with nothing to watch fails too. A failure after a reload still waits for the fix, as before.
  - Ctrl-C ends a `cdk-blocks dev` whose dev server was killed (`kill -9`, the OOM killer), as a SIGTERM does: `tsx watch` waits forever for a runner that a signal ended, so once no runner is left the CLI SIGKILLs it after 1 s. It exits 130.
  - A SIGTERM sent to `cdk-blocks` that ends the operation it runs (`cdk-blocks sandbox deploy`, `sandbox destroy`, `deploy`, `destroy`; for example core aborts a deploy on a second SIGTERM) exits 143 with `<command> stopped by SIGTERM.`, instead of exit 1 with `failed (signal SIGTERM)` and a `--verbose` hint. A runner that core aborted on the operator's SIGINT exits 130. A runner killed by a signal that `blocks` did not receive still fails with exit 1.
  - A `package.json` that is valid JSON but not an object (`null`, `[]`, a string) fails `cdk-blocks dev`, `dev stop`, `sandbox` and `generate client` with `<path>/package.json must be a JSON object, not an array.` (exit 1), instead of `Cannot read properties of null`, a dev server on the default port, or a raw `ERR_INVALID_PACKAGE_CONFIG` stack.
  - An installed `@aws-blocks/core` that does not match `@aws-blocks/blocks` (an upgrade that kept an older core in the lockfile) fails with `@aws-blocks/blocks <version> cannot load @aws-blocks/core <version>, which does not match it: …` and `Try: reinstall @aws-blocks/core to match @aws-blocks/blocks <version>: npm install '@aws-blocks/core@<range>'`, instead of a raw `ERR_PACKAGE_PATH_NOT_EXPORTED` or `does not provide an export named` stack, also when the CLI itself fails to load. `--version` and `--help` never load core.
  - After a successful `cdk-blocks destroy`, the CLI removes the deleted production stack from `.blocks-sandbox/last-deploy.json` and `outputs.json`, and removes `config.json` when a production deploy wrote it, as `cdk-blocks sandbox destroy` does for the sandbox, so the local client and `--output json` no longer point at the deleted API. The sandbox records stay.
  - `cdk-blocks sandbox console` opens a sandbox that no record on this machine names (one that the old npm-script wrappers deployed, after a production deploy rewrote `.blocks-sandbox/outputs.json`) when CloudFormation has its stack, looked up with the sandbox's credentials and Region. It refuses only a stack that does not exist, with `the sandbox stack <stack> does not exist in <Region>.`; when the lookup cannot tell (no credentials, no network), it opens the console.
  - `Try:` lines and the deploy, sandbox and credential re-run guidance name `cdk-blocks` commands as `npx --no -- cdk-blocks …`, as the app's AGENTS.md does, so they can be copied into the app's shell, where a bare `blocks` is not on `PATH` (exit 127). The `--all --port` refusal suggests `npx --no -- cdk-blocks dev stop --all` instead of the hidden `cdk-blocks cleanup` alias.

- b2eb306: feat(blocks): `cdk-blocks sandbox preview` deploys the preview sandbox

  - `cdk-blocks sandbox preview` deploys the sandbox once with the app hosted in preview shape, prints the preview URL and exits, as `npm run sandbox:preview` does. With `--output json` or `--query url` it prints the deploy result. `cdk-blocks sandbox --preview` and `cdk-blocks sandbox:preview` run it, for the npm-script spellings.
  - `startSandbox` takes `previewInvocation`, the command that the warning of a plain deploy over a hosted preview names. Default: `npm run sandbox:preview`. The recorded deploy result's `url` is the URL the sandbox prints.

- 184df0b: fix(blocks): run the backend under `cdk-blocks dev`, `sandbox`, `deploy` and `generate client` with `aws-blocks/tsconfig.json` when the app has one

  `tsx` compiles a file with the root `tsconfig.json`. When that root only lists project references, as in the AWS Blocks Vite templates, it applies no options to backend files, so `jsx` or `paths` set in `aws-blocks/tsconfig.json` worked for `tsc -b` and the deploy bundling but not in `cdk-blocks dev` or `generate client` (`React is not defined`, `Cannot find package`). These commands and the `blocks-generate-client` bin now set `TSX_TSCONFIG_PATH` to `aws-blocks/tsconfig.json` (for the bin, the `tsconfig.json` next to the backend entry) when it exists and `TSX_TSCONFIG_PATH` is not set already.

- b2eb306: fix(blocks): `cdk-blocks` on Windows

  - Ctrl-C in `cdk-blocks dev` on Windows no longer prints `ps: unknown option -- A` when Git for Windows' `ps` is on `PATH`: the CLI runs no `ps` there, and on POSIX `ps`'s errors no longer reach the terminal.
  - On Windows, an installed `@aws-blocks/core` that does not match `@aws-blocks/blocks` fails with the `cannot load @aws-blocks/core …, which does not match it` error and its reinstall hint, as on POSIX, instead of a raw `ERR_PACKAGE_PATH_NOT_EXPORTED`: Node names the package there by a path with backslashes.
  - `cdk-blocks dev` and the sandbox's dev command tell the dev server that it runs under `tsx watch` (`BLOCKS_DEV_UNDER_WATCH=1`), so that a failed first start can end that `tsx watch` on Windows too, where the dev server cannot read its parent's command line.

- b2eb306: fix(blocks): a SIGTERM to the process group of `cdk-blocks dev` or `cdk-blocks sandbox` stops it cleanly

  A supervisor, `timeout` or CI sends SIGTERM to the whole process group, so the child of `cdk-blocks dev` and `cdk-blocks sandbox` gets it directly. On a SIGTERM or SIGHUP, the CLI now sends `cdk-blocks dev`'s dev server one SIGTERM, which its idempotent cleanup takes without harm, and stops `tsx watch` only once the dev server is gone. Before, its immediate forward was a second SIGTERM to `tsx watch`, which then SIGKILLed the dev server before it stopped the frontend, and `next dev` or Vite kept running. Other commands still forward SIGTERM at once.

- e098c7a: The JSDoc on each Building Block re-export now points at the docs bundled in
  this package (`docs/<package>/README.md`) instead of a `node_modules` package
  directory, matching the lookup described in the README. Coding agents that
  follow these comments now land on the shipped docs instead of a path that may
  not exist.
- 94d5900: The production settings of `DistributedTable` and `FileBucket` now live in a `PRODUCTION.md` next to each block's `README.md`, which links to it. `DistributedTable`'s covers scaling and cost, durability, deletion protection and encryption. `FileBucket`'s covers access logging, KMS encryption, Object Lock, scaling and cost. Both files ship in their packages and in `@aws-blocks/blocks` under `docs/<block>/`, and the shorter READMEs can be read in one pass.
- f133ff8: On the `apiFrontDoor: 'cloudfront'` tier, CloudFront now routes an API namespace on a `container` compute straight to the container's load balancer, instead of through the shared API gateway — from the backend's managed distribution, or from `Hosting`'s default CloudFront door when it fronts the API. A call can run up to 60 seconds (CloudFront's origin read timeout) instead of the gateway's ~29, and skips a hop.

  - Each container namespace path (`/aws-blocks/api/<export name>`) gets its own CloudFront behavior, ahead of the `/aws-blocks/api/*` gateway behavior, all on one VPC origin per distribution for the backend's load balancer listener (whose path rules pick the compute) — so a distribution uses one of the account's VPC origins (25 by default) however many containers serve API traffic. Namespaces on Lambda computes, auth routes and `RawRoute`s still go through the gateway.
  - A viewer-request CloudFront Function stamps the viewer's host on those requests, so `ctx.request.url` in the container is the public URL, including a custom domain.
  - The load balancer admits CloudFront's origin-facing prefix list on its listener ports; the prefix list is looked up at deploy time, so stacks stay environment-agnostic.
  - A direct call skips the gateway's throttling and access logs; the distribution's web ACL (`apiWaf`, or Hosting's WAF) covers it, and synth warns when there is none.
  - On the `apigateway` tier nothing changes: container namespaces go through the gateway, behind `Hosting` too.
  - A container namespace whose load balancer's VPC has no public subnets (an isolated VPC; a CloudFront VPC origin needs an internet gateway) stays on the gateway, and synth warns naming it.
  - `Hosting`'s `stacked` door keeps container namespaces on the gateway, through its ALB router.
  - Synth fails with a clear message when the direct behaviors take a distribution past its cache-behavior quota (CloudFront's default of 75, or `Hosting`'s `quotas.cacheBehaviors`), naming the container namespaces.
  - The CloudFront Function also drops a client-sent `X-Forwarded-Host`, so it cannot change `ctx.request.url`.

- c1fabce: feat(core): honor `BLOCKS_LOG_LEVEL` and `BLOCKS_LOG_STREAM` in the lifecycle scripts

  `deploy`, `destroy`, `startSandbox`, `destroySandbox` and `startDevServer` from `@aws-blocks/core/scripts` now read `BLOCKS_LOG_LEVEL`:

  - unset (or any unrecognised value): output is unchanged.
  - `quiet`: errors and final results only.
  - `normal`: short progress steps; CDK output is condensed into milestones and a resource count, and failure and rollback lines still print.
  - `verbose`: the raw CDK output, as today.
  - `debug`: `verbose` plus stack traces for errors the scripts catch and report as warnings.

  The `BLOCKS_DEPLOYED …` line, the deployment-target summary, the API and frontend URLs and error messages print at every level. At `quiet` and `normal` the last 500 lines of hidden CDK output are kept, and when a deploy, destroy or `cdk watch` deploy fails they are printed to stderr before the error, so the failure never needs a re-run to diagnose. A `cdk watch` deploy that fails during synth, which CDK reports without a `❌` line, counts as failed too.

  The external-database migration step and the dev server's `secret()`/`config()` type generation follow the level as well: at `quiet` the migration's output and warnings (its stdout and stderr) are hidden, and printed to stderr only if the migration fails; type-generation notices are hidden at `quiet` and `normal`.

  `BLOCKS_LOG_STREAM=stderr` moves progress to stderr: progress steps, CDK milestones, raw CDK output, streamed CloudFormation events, migration output and type-generation notices go to stderr, and stdout keeps only the results (the deployment target, `BLOCKS_DEPLOYED` and the final URLs). `blocks-generate-spec` follows it too: its progress lines go to stderr, and stdout keeps the `✅ OpenRPC spec written to …` line. Without the variable, the streams are unchanged. `@aws-blocks/core/scripts` exports `log`, the logger these scripts print progress with.

- 6151940: Failed RPC calls on Lambda are now visible in CloudWatch. A failed call reaches the client as a JSON-RPC error inside an HTTP 200 response, so Lambda's `Errors` metric never counted it, and an alarm on it never fired. Each failed call (a method that throws, a call to an unknown API namespace or method, or the handler's 504 timeout) now writes one line in CloudWatch embedded metric format: the `AWSBlocks` / `RpcErrors` metric, with the dimensions `FunctionName` and `StatusClass` (`4xx` or `5xx`). The status, API namespace and method are in the same log line for CloudWatch Logs Insights. No SDK call or IAM permission is added, and the error message is never written to the metric line.
- 2a358ff: `blocks-telemetry --disable` and `--enable` (without `--global`) now write `.blocks/config.json` at the project root, the nearest directory at or above the working directory that holds a `package.json` and an `aws-blocks/` directory. Run from a subdirectory of an app, `--disable` previously wrote the opt-out into that subdirectory, where the telemetry check never read it, so telemetry kept sending while the command reported success. When no project root is found, `--enable` uses the working directory, while `--disable` writes nothing and exits non-zero (for example at a monorepo root whose app is nested below it), pointing at `--global` and `AWS_BLOCKS_DISABLE_TELEMETRY=1`. `--status` reads the same project root as `--enable`. `--disable` reads the status back and prints its success line only after confirming telemetry is off; otherwise it prints a warning and exits non-zero. `--global` is unchanged.
- 1ec956f: Test temp directories are created with `mkdtempSync`, so two tests that start in the same millisecond no longer share a path.
- 072c3ff: An unrecognized `encryption` value on `KVStore`, `DistributedTable` or `FileBucket` now fails the synth with an error that lists the valid values (`'aws-managed'`, `'customer-managed'`, or the block's `fromKmsKey(arn)`). Previously such a value (for example a typo like `'kms-managed'` in untyped JavaScript, or a value loaded from JSON or the environment) only emitted an `UnknownEncryption` warning and fell back to the AWS-managed key, so a request for a customer-managed key could be silently downgraded. Apps that pass a valid value, or omit `encryption`, are unaffected; an app that hits the new error was never getting the encryption it asked for and should correct the value.
- 184df0b: feat(create-blocks-app): typecheck the backend with Node types and the browser code without them

  The frontend imports the backend (`import { api } from 'aws-blocks'`), so its `tsconfig` typechecked the backend source with the frontend's settings. The templates passed because their one `tsconfig.json` made Node types global, which also let browser code use `process` or `Buffer` without an error, and a frontend `tsconfig` with `"types": ["vite/client"]`, as create-vite's has, failed with `TS2591: Cannot find name 'process'` in `aws-blocks/`.

  - The Vite templates (`default`, `bare`, `react`, `auth`, `agent`, `demo`) now check the browser and the backend as separate TypeScript projects, the way create-vite's `react-ts` template does: `tsconfig.app.json` checks `src/` without Node types and reads the backend through a project reference to `aws-blocks/tsconfig.json`, which checks every backend file with Node types. `npm run typecheck` is `tsc -b --force`, and `npm run build` is `tsc -b --force && vite build`. A Node global in `src/` is now a type error.
  - `nextjs` and the backend-only templates keep one `tsconfig.json` with Node types: `next build` ignores project references, and backend-only apps run all their code on Node.
  - Adding AWS Blocks to an existing project writes `aws-blocks/tsconfig.json` (except in a Next.js project) and prints how to reference it. It never edits the project's `tsconfig`.
  - Apps scaffolded before this change keep working as they are. To move one to the new layout, see [Keep Node types out of the frontend](https://github.com/aws-devtools-labs/aws-blocks/blob/main/docs/guides/upgrading-older-apps.md#keep-node-types-out-of-the-frontend). `TROUBLESHOOTING.md` in `@aws-blocks/blocks` lists the TypeScript errors of the layout and their fixes.

  The decision and the alternatives considered are recorded as D-028 in `docs/DECISIONS.md`.

- 05a88e1: When AWS denies the credential check before `npm run deploy` and `npm run sandbox`, for example when a profile's role cannot be assumed, the warning now says so instead of reporting an unverified check, and says whether an AWS Organizations policy (a service control policy or a resource control policy) explicitly denied the request. It still does not stop the command, and it never includes the error's account IDs, ARNs or policy IDs.

  A credential failure message now names the profile and the deployment Region. When the fix is `aws login` and the profile has no Region or a different one, the message first prints `aws configure set region <region> --profile <name>`, so that the sign-in uses the Region you deploy to, and says to sign in again after a later Region change. If the profile's Region is set in the AWS credentials file, which overrides the config file that `aws configure set` writes, the message asks you to change it there instead. When `AWS_REGION` or `AWS_DEFAULT_REGION` names another Region than the deployment, which the AWS CLI would use instead, the `aws login` command includes `--region <region>`.

- 3ae8592: feat(bb-cron-job): run a CronJob on a container compute for long-running jobs

  `CronJob` takes the same `compute` and `timeoutSeconds` options as `AsyncJob`.
  Assign a container `Compute` to run a scheduled job longer than a serverless
  compute's 15-minute limit:

  ```ts
  import { Compute, CronJob } from "@aws-blocks/blocks";

  const worker = new Compute(scope, "worker", {
    type: "container",
    size: { vcpu: 1, memory: 2048 },
  });

  new CronJob(scope, "nightly-rebuild", {
    schedule: "cron(0 3 * * ? *)",
    compute: worker,
    timeoutSeconds: 2 * 60 * 60,
    handler: async () => {
      // ...
    },
  });
  ```

  On a container compute each tick is delivered like a container `AsyncJob`: the
  handler runs in its own worker thread, `timeoutSeconds` is enforced, and a
  failed tick is retried up to 3 attempts in total before moving to a dead-letter
  queue. A CronJob under a container scope (`new Scope(id, { parent, compute })`)
  now runs on that container instead of failing synth. Jobs on a serverless
  compute deploy as before.

- f32185c: Add the `blocks dashboard` command, which starts the Blocks Admin UI against the app it is run from on a free loopback port and opens it with a session token. `blocks dashboard doctor` diagnoses the app and prints a report instead, for when the server will not start. Accepts `--port`, `--profile`, `--region`, `--project`, `--allow-origin` and `--json`, and rejects a flag whose value is another flag rather than silently accepting it.

  The dashboard is opt-in: `@aws-blocks/admin-ui` is resolved from the app and offered for install when missing, so an app that never runs it carries none of its dependencies. The default template gains an `npm run dashboard` script.

- 5f55dac: `db pull`'s generated `MIGRATION_GUIDE.md` and the auth placeholder it adds to your `index.ts` now use `Auth` from `@aws-blocks/bb-auth` instead of the removed `AuthOIDC`. The guide's example signs users in with Google as a `type: 'oidc'` provider of a `store: 'builtin'` block, so their `userId` keeps the same `<issuer>:<sub>` format `AuthOIDC` produced, and the deploy checklist names the callback URL to register (`https://<your domain>/aws-blocks/auth/callback`).
- f32185c: Record every deploy in `.blocks/deploy-history.jsonl`. A deploy appends one `IN_PROGRESS` record when it starts and one terminal record with the same id when it ends, so a reader merges by id with last-record-wins and a dangling `IN_PROGRESS` record means the process died mid-deploy. The region and stack name are captured at deploy time rather than resolved when the file is read, because ambient `AWS_REGION` and IMDS can point somewhere other than where the deploy actually went.

  Writing is best-effort: a history file that cannot be written never fails the deploy it describes. The sandbox path records the explicit deploy only, since a later `cdk watch` hot-swap has no clean deploy boundary.

- 201e59e: The local dev server now handles API and raw-route requests through the same dispatcher as deployed handlers, so cookie and error responses match. Handlers in local dev can now read the request cookies and client user agent through the request context, API and raw-route responses carry the same no-store cache headers, `ctx.request.url` formats the query string the same way as in a deployment, handlers receive `ctx.request.signal`, `ctx.request.url` takes its host from a loopback `X-Forwarded-Host`, and a request without a `Host` header reads as `http://localhost/...`.
- 5f55dac: The local dev server no longer exits on an unhandled promise rejection from request handling, which left `npm run dev` down until the next file change. The usual cause is a guard called without `await`, such as `auth.requireRole(context, 'admin')`: the method returns before the guard rejects. The dev server now logs `[unhandled-rejection] <namespace.method>: <error>` with a hint about the missing `await`, whether the response had already been sent, and the stack, and keeps serving. A rejection outside any request still ends the process, as before. Deployed (Lambda) behaviour is unchanged.
- 9d69412: Correct documentation that no longer matched the code: session cookies default to `SameSite=Lax` (`SameSite=None; Partitioned` only with `crossDomain: true`), an `inferenceOnly` agent still creates its S3 session bucket, and local mocks are documented as matching the API rather than every AWS behavior.

  `FileBucket` docs now say `objectLock` can be added to a bucket that is already deployed, as an in-place update; it still can't be turned off once on.

- 5f55dac: Docs and editor hover text now point at `Auth`, the single authentication Building Block, instead of the removed `AuthBasic`, `AuthCognito` and `AuthOIDC`. The `@aws-blocks/blocks` README adds a "Choosing a sign-in method" table comparing email + password, social, OIDC verified by your backend (`store: 'builtin'`), OIDC through Cognito, and SAML by Cognito free tier, offline support and user-pool features. The `hasAuthError` example in `@aws-blocks/core` now matches `AuthErrors.NotAuthorized`.
- e8673cd: Clarify event block compute compatibility and UnsupportedCompute errors: AsyncJob and CronJob support Lambda and container delivery, while Realtime requires default Lambda compute. Distinguish direct Lambda scheduling from the internal AsyncJob queue used by container CronJobs. Align both design documents and the AsyncJob comments with compute inheritance, retry paths, and backend-scoped Scheduler permissions for function and queue targets. Document that omitting container concurrency allows five in-flight deliveries per job per instance, rather than one per vCPU.
- 8fb67ec: Fix local FileBucket version deletion so removing the newest stored data version updates the current body and metadata from the next stored data version, or removes the current copies when none remain. Active delete-marker flags and older-version deletion behavior are preserved. Document that historical delete markers discarded by a subsequent upload are not reconstructed, so deletion across re-uploads still differs from S3.

  Ignore nested-key directories when reading version history. Retain the target version body until current-copy reconciliation and version-sidecar removal succeed, allowing filesystem failures to be retried with the same version ID.

- f643a76: Return HTTP 404 for local presigned downloads of unknown or permanently deleted file versions instead of serving the current file's content.
- c6a59f4: chore(hosting,create-blocks-app): build Next.js with OpenNext 4.1

  - The Next.js adapter is verified against `@opennextjs/aws` `>=3.10.0 <3.11.0 || >=4.0.0 <4.2.0`, so 4.1.x no longer prints the out-of-range warning.
  - An app that doesn't declare `@opennextjs/aws` builds with 4.1.14 instead of 4.0.3. Its `next` peer range is `>=15.5.28 <16 || >=16.4.1`, so the build warns for `next` versions below that.
  - The `create-blocks-app` `nextjs` template declares `@opennextjs/aws` `~4.1.14`.

- 1e4d08d: docs(hosting): explain what a plain-HTTP front door does to session cookies

  The README's front-door section now says that behind a standalone ALB door with no certificate, `Auth` omits `Secure` from its same-origin session cookie (a browser discards a `Secure` cookie from a plain-HTTP origin), so the cookie and the session travel in clear text. It recommends a certificate (an HTTPS listener) for anything beyond testing, and points at the separate `StackedRouterPlainHttp` warning for the stacked door's edge → router hop.

- e6c989d: `frontDoor: 'none'` now always warns at synth (`@aws-blocks/hosting:PlainHttpFrontDoor`), including for a static site with no backend API. The S3 website endpoint takes no certificate, so the pages and scripts travel unencrypted and can be altered in transit. The warning explains this, points to the CloudFront door for HTTPS, and names how to acknowledge it when `'none'` is intended (`Annotations.of(stack).acknowledgeWarning('@aws-blocks/hosting:PlainHttpFrontDoor')`). It stays a warning: synth still succeeds.
- 60360c1: `Hosting` no longer rebuilds the frontend on a synth that doesn't need it:

  - **Destroy:** `npm run destroy` and `npm run sandbox:destroy` reuse the frontend build output already on disk instead of running `buildCommand` and the framework build (OpenNext, Nitro, Astro, SvelteKit). On a Next.js app this removes a multi-minute build from every destroy. When there is no build output, the destroy builds as before; a Next.js destroy reuses the `.open-next/` output of an earlier deploy. `BLOCKS_SKIP_FRONTEND_BUILD=1` doesn't apply to a destroy.
  - **Opt-in deploy reuse:** `BLOCKS_SKIP_FRONTEND_BUILD=1` makes a deploy use the existing build output without building. A missing build output (the output directory, or the output the framework adapter deploys, such as Next.js's `.open-next/`) fails the synth with the adapter's error (same code and resolution) plus a line naming the variable. The build bakes in `BLOCKS_API_URL`, so a deploy never reuses a build on its own.

  The framework adapters read the decision from the build profile (`reuseBuild: 'if-present' | 'required'`); an explicit `skipBuild` option still wins.

- 8ece10a: fix(core,hosting): require source conditions on KMS key policies that name a service principal

  The synth-time service-principal check now also reads the key policy of every KMS key in the scopes it covers. An `Allow` statement that names an AWS service principal must carry `aws:SourceAccount` or `aws:SourceArn`, or `kms:EncryptionContext:aws:logs:arn` for CloudWatch Logs. `events.amazonaws.com` is exempt for `kms:GenerateDataKey*` and `kms:Decrypt`, because Amazon SNS documents that these conditions stop EventBridge from publishing to an encrypted topic. A key AWS Blocks creates fails synth; a key your app creates gets a warning, which you can acknowledge with the id `@aws-blocks/core:kmsKeyPolicyWithoutSourceCondition`.

  A condition now counts, for key policies and for role trust policies alike, only under a positive string or ARN operator (`StringEquals`, `StringLike`, `ArnLike`, …, or their `ForAnyValue:` forms) and with a value that names an account. `…IfExists`, negated (`StringNotEquals`, `ArnNotLike`, …), `Null` and `ForAllValues:` operators don't count. Neither does `*` alone, a wildcard `aws:SourceAccount`, or an ARN whose account segment is empty or a wildcard. A role or key your app creates that relied on one of these forms now gets the synth warning.

  The `Hosting` alarm topic key (regional and `us-east-1` monitoring stacks) now grants `cloudwatch.amazonaws.com` with `StringEquals aws:SourceAccount` and `ArnLike aws:SourceArn` (`arn:<partition>:cloudwatch:<region>:<account>:alarm:*`) in place of `StringEqualsIfExists aws:SourceAccount`. Alarm notifications are still delivered.

- 287be20: fix(bb-knowledge-base): keep raw ingestion failure text out of client errors

  When the latest ingestion job had failed, `isSynced()` and `waitUntilSynced()` threw `IngestionFailedException` with Bedrock's `failureReasons` in the message. That message is returned to RPC callers, and the reasons are raw service text that can name buckets, object keys or ARNs. The error now has a fixed message. When Bedrock reports reasons, they are written to the server log and kept on the error's non-enumerable `cause`, so `JSON.stringify(err)` and the RPC response leave them out. The new exported type `IngestionFailureCause` describes that `cause`. The error name, `KnowledgeBaseErrors.IngestionFailed` and the method signatures are unchanged. If your server code read the reasons from `err.message`, read `failureReasons` from `err.cause` instead, treating it as optional: `cause` is absent when the job reported no reasons or the lookup failed.

- d8a86ee: Update the `LambdaCompute` README and design doc to describe how the compute reaches an app (as the default compute and through `Compute` with `type: 'serverless'`), its options, and its VPC, CORS, tracing, and dashboard behavior. Add tests for the memory, timeout, and VPC placement settings.
- c607deb: Behind a Blocks CloudFront front door, a Lambda handler's `ctx.request.url` is now the URL the client called: the distribution's domain, or the custom domain it was called at (`https://d111.cloudfront.net/aws-blocks/api/orders`, not `https://<id>.execute-api.<region>.amazonaws.com/aws-blocks/api/orders`). Links and redirects a handler builds from it stay on the public domain, where the app's cookies are scoped. A container namespace behind the same door already reported that URL; the two compute types now agree. `getRequestBaseUrl()` is unchanged: it stays the gateway's origin and stage, for code that must reach the gateway directly.

  - Applies to the `apiFrontDoor: 'cloudfront'` distribution and to `Hosting`'s CloudFront door (on either tier). A viewer-request CloudFront Function on their API behaviors to the gateway stamps the viewer's host as `x-blocks-public-host`; each door registers its hosts under the backend's `BLOCKS_PUBLIC_HOSTS` config.
  - A handler takes the stamped host only when it is one of the backend's front-door hosts (for a wildcard alias such as `*.example.com`, a subdomain at any depth, not the apex); any other value is ignored.
  - Requests sent to the `execute-api` URL directly, and requests through `Hosting`'s other doors (ALB, API Gateway, stacked, bring-your-own), keep reporting the gateway's host.
  - The sandbox dev server's loopback `X-Forwarded-Host` still takes precedence, so redirect-based sign-in in a sandbox keeps working through the CloudFront URL. In both the Lambda handler and the container, it now contributes only its host: a query, fragment or userinfo in it no longer reaches `ctx.request.url`, and a request path starting `//` or `/\` can't change the URL's host.
  - A container namespace the gateway proxies to behind a Blocks CloudFront door (on the `apigateway` tier, or when CloudFront can't reach its VPC) also reports the public URL now, instead of the gateway's.
  - `Auth`'s same-origin relay allowance follows: when a sign-in starts, a `relayTo` on the host the client called behind a Blocks CloudFront door counts as same-origin, where the gateway's `execute-api` host did before. When the IdP calls back, the relay re-check accepts a relay to any host the backend serves over HTTPS (each CloudFront door's hosts and the gateway's), so a sign-in that started on one of a door's hosts, or on the `execute-api` URL, still finishes when the callback arrives on another.
  - Each CloudFront door adds one CloudFront Function to the account.

- 4e92168: On the Lambda functions AWS Blocks runs through `createLambdaHandler` (the backend API and its event handlers), every `Logger` line now carries `awsRequestId`, the invocation's request id, so you can correlate everything one request logged (for example `filter awsRequestId = "<id>"` in CloudWatch Logs Insights). Core's `createLambdaHandler` runs each invocation with its `awsRequestId` in scope, and overlapping invocations on one container each see their own id. `awsRequestId` is reserved, so context can't replace it, and your own context fields such as `requestId` are kept as is. Building Block authors can read the same id with `currentRequestId()` from `@aws-blocks/core/bb-utils`. Local dev, SSR hosting web functions and container compute set no request id, so the field is absent there.
- c6a3357: Add a repository check that every Building Block with both a local mock and an AWS runtime entry ships a `parity.test.ts` and calls its shared `validation.ts` from both entries. The contributor docs now describe the rule.
- 8a5726c: test: check `defaults.permissionsBoundary` coverage for Auth, Compute, ContainerCompute, CronJob and Dashboard

  Each of these blocks now has a synth test that sets `defaults.permissionsBoundary`
  and fails if any IAM role in any synthesized template, including custom-resource
  provider roles, the CronJob scheduler role and the container task execution
  role, lacks the boundary or is missing from the `<stack>.blocks-iam.json`
  report. No runtime or synth behavior changes.

- 80ce128: `npm run sandbox` now deploys infrastructure changes made while it watches. Its `cdk watch` ran with CDK's default `--hotswap`, which applies code-only changes but silently ignores any change it can't hotswap. Adding a Building Block that needs new infrastructure, such as a `Database` or `Realtime`, therefore updated the Lambda code that uses it and never created it, with no message. The watch now passes `--hotswap-fallback`: a code-only change still hotswaps in seconds, and any other change runs a full deploy of the stack.
- 5f55dac: The scaffolded `AGENTS.md` no longer contradicts itself about API namespaces: a method is called as `<exported name>.<method>` (`export const api = new ApiNamespace(…)` → `api.*`), not by the second argument to `new ApiNamespace(…)`.
- 70ea280: `Secret` schema-validation errors no longer include the secret value. Schema libraries often quote the received value in their issue messages, and a `SecretErrors.ValidationFailed` error's message is returned to the RPC caller, so `get()` and `put()` now throw it with a fixed message, `ValidationFailedException: The secret value did not match the schema`. The message doesn't name the failing field, because a record or map schema reports the value's own keys as the path. The library's original issues and the first failing path stay on the error's non-enumerable `cause` (`cause.issues`, `cause.path`) for server-side logging. The error name is unchanged, so `isBlocksError(e, SecretErrors.ValidationFailed)` checks keep working.
- e286b16: docs(telemetry): make the first-run telemetry notice describe exactly what is collected

  The notice printed the first time the CLI or `create-blocks-app` collects usage data said the data was anonymous and that no personal data was collected. It now lists what an event can include: random installation and project IDs, and an event ID and timestamp; the command, its outcome, duration and error category (never the error message); your OS, Node.js version and package manager user agent; whether it ran in CI or under a coding agent; the AWS Blocks and CDK versions, the framework, and the template name and version; and the names and versions of the official Building Blocks the app uses, how many Building Blocks it uses, and how many of them are custom (custom Building Block names are never sent). It says that events never include names, email addresses, AWS account IDs, ARNs, file paths, file contents or source code, and that, as with any HTTPS request, the collection endpoint also receives your IP address.

  The notice now names the opt-outs that work everywhere: `AWS_BLOCKS_DISABLE_TELEMETRY` set to `1`, `true` or `yes`, or `npx --no -- cdk-blocks telemetry disable --global` or `npx --no -- blocks-telemetry --disable --global` run inside an AWS Blocks app. Without `--global`, these commands opt out the current app only. The `@aws-blocks/blocks` README describes the same in its CLI section.

  What is collected and when has not changed.

- c00ab16: docs(telemetry): state the retention periods in the first-run notice

  The first-run telemetry notice printed by the CLI and `create-blocks-app`, and the `@aws-blocks/blocks` README, now say that the collection endpoint does not store your IP address, except in logs of requests that its firewall blocks, and that events are kept for up to 1 year and logs of all requests, blocked or not, for up to 10 years.

- 5f55dac: Templates: per-user data is keyed on `userSub`, and `updateTodo` can no longer write into another user's list.

  - **`updateTodo` (`demo`, `auth`)** spread the caller's `updates` object over the stored todo. The RPC layer passes through properties the TypeScript signature doesn't declare, so a crafted request could set the todo's key fields and overwrite or create a todo in someone else's list. It now copies only `completed`, `priority` and `title`. If you scaffolded an app from either template, make the same change to its `updateTodo`.
  - **Keyed on `userSub`** (`default`, `react`, `demo`, `api-only`, `sql`, and the commented example in `bare`): per-user rows used the username as their owner key. They now use `user.userSub`, the id that stays the same for the user's lifetime, as the `auth` template already did. The todo field is renamed from `userId` to `userSub`. This only affects newly scaffolded apps.
  - Each template's e2e tests now check that a second user can't list, read, update or delete the first user's items.

- 58980c7: fix: `sandbox:destroy` works on Windows

  On Windows, `npm run sandbox:destroy` always failed and left the sandbox stack deployed. The CDK `--app` path was
  wrapped in single quotes, which `cmd.exe` keeps as part of the path (`Cannot find module '...index.cdk.ts'`). Listing
  the stacks to empty their buckets also failed with `spawnSync npm ENOENT`, because `npm` is a `.cmd` shim there. The
  path is now double-quoted on Windows (single-quoted elsewhere), and stack listing for `destroy`
  uses the same cross-platform spawn as the rest of the CLI. `sandbox` deploy, synth, and watch now quote the path
  the same way, so they also work when the project path contains a space.

- Updated dependencies [3d7479a]
- Updated dependencies [be8864c]
- Updated dependencies [4457ea4]
- Updated dependencies [d51b8ee]
- Updated dependencies [e83d152]
- Updated dependencies [c6a3357]
- Updated dependencies [5f55dac]
- Updated dependencies [6423964]
- Updated dependencies [6eba38b]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
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
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
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
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [5f55dac]
- Updated dependencies [6236bf9]
- Updated dependencies [b2eb306]
- Updated dependencies [c1fabce]
- Updated dependencies [efe28cb]
- Updated dependencies [49b68af]
- Updated dependencies [f0c1455]
- Updated dependencies [6297d5a]
- Updated dependencies [a5a5dd3]
- Updated dependencies [e8e3262]
- Updated dependencies [eacc87e]
- Updated dependencies [7c23ab9]
- Updated dependencies [b2eb306]
- Updated dependencies [bfaddeb]
- Updated dependencies [5f55dac]
- Updated dependencies [b2eb306]
- Updated dependencies [94d5900]
- Updated dependencies [a5e754b]
- Updated dependencies [f133ff8]
- Updated dependencies [9ebf67a]
- Updated dependencies [76fd75c]
- Updated dependencies [3ae8592]
- Updated dependencies [2b250f8]
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
- Updated dependencies [3ae8592]
- Updated dependencies [777c5a4]
- Updated dependencies [f32185c]
- Updated dependencies [5f55dac]
- Updated dependencies [116b32b]
- Updated dependencies [f32185c]
- Updated dependencies [9801a5b]
- Updated dependencies [a86bccb]
- Updated dependencies [b2eb306]
- Updated dependencies [df25d97]
- Updated dependencies [201e59e]
- Updated dependencies [5f55dac]
- Updated dependencies [be8864c]
- Updated dependencies [99638ca]
- Updated dependencies [2d7ce4a]
- Updated dependencies [9d69412]
- Updated dependencies [5f55dac]
- Updated dependencies [4e41c28]
- Updated dependencies [64f7247]
- Updated dependencies [e8673cd]
- Updated dependencies [8fb67ec]
- Updated dependencies [11877b6]
- Updated dependencies [77c2c75]
- Updated dependencies [f643a76]
- Updated dependencies [1f565bd]
- Updated dependencies [5f55dac]
- Updated dependencies [c6a59f4]
- Updated dependencies [1e4d08d]
- Updated dependencies [5f55dac]
- Updated dependencies [e6c989d]
- Updated dependencies [b2eb306]
- Updated dependencies [b2eb306]
- Updated dependencies [fb29c06]
- Updated dependencies [60360c1]
- Updated dependencies [40d25ec]
- Updated dependencies [184df0b]
- Updated dependencies [c1fabce]
- Updated dependencies [b2eb306]
- Updated dependencies [b2eb306]
- Updated dependencies [b2eb306]
- Updated dependencies [d51b8ee]
- Updated dependencies [8ece10a]
- Updated dependencies [287be20]
- Updated dependencies [c672712]
- Updated dependencies [d8a86ee]
- Updated dependencies [c607deb]
- Updated dependencies [4e92168]
- Updated dependencies [bfdd06f]
- Updated dependencies [8a5726c]
- Updated dependencies [2095f31]
- Updated dependencies [42b84b2]
- Updated dependencies [10eb382]
- Updated dependencies [6bac1c9]
- Updated dependencies [8e96367]
- Updated dependencies [80ce128]
- Updated dependencies [da7eb93]
- Updated dependencies [3259d83]
- Updated dependencies [70ea280]
- Updated dependencies [fc57730]
- Updated dependencies [d354055]
- Updated dependencies [d354055]
- Updated dependencies [d354055]
- Updated dependencies [58817b0]
- Updated dependencies [e286b16]
- Updated dependencies [c00ab16]
- Updated dependencies [58980c7]
  - @aws-blocks/bb-agent@0.8.0
  - @aws-blocks/bb-app-setting@0.4.1
  - @aws-blocks/bb-async-job@0.3.1
  - @aws-blocks/bb-auth@0.2.0
  - @aws-blocks/auth-common@0.4.0
  - @aws-blocks/core@0.9.0
  - @aws-blocks/bb-data@0.6.0
  - @aws-blocks/bb-secret@0.4.0
  - @aws-blocks/bb-distributed-data@0.3.1
  - @aws-blocks/bb-container-compute@0.3.0
  - @aws-blocks/bb-distributed-table@0.4.0
  - @aws-blocks/bb-file-bucket@0.5.0
  - @aws-blocks/bb-realtime@0.6.0
  - @aws-blocks/bb-compute@0.2.1
  - @aws-blocks/hosting@0.6.0
  - @aws-blocks/bb-kv-store@0.5.0
  - @aws-blocks/bb-lambda-compute@0.7.1
  - @aws-blocks/bb-cron-job@0.5.0
  - @aws-blocks/bb-knowledge-base@0.4.0
  - @aws-blocks/bb-email-client@0.3.0
  - @aws-blocks/bb-logger@0.4.0
  - @aws-blocks/bb-dashboard@0.3.1
  - @aws-blocks/bb-metrics@0.2.1
  - @aws-blocks/bb-tracer@0.3.1

## 0.9.0

### Minor Changes

- 0765f84: feat(core): run an API namespace on its own compute

  `ApiNamespace` takes an optional fourth argument, `{ compute }`, that runs the
  namespace's methods on a `Compute` instead of the app's default compute — for
  example to give one namespace more memory (and CPU) or its own scaling:

  ```ts
  import { ApiNamespace, Compute } from "@aws-blocks/blocks";

  const reportsCompute = new Compute(scope, "reports", {
    type: "serverless",
    memory: 4096,
  });

  export const reports = new ApiNamespace(
    scope,
    "reports",
    (context) => ({
      async build(month: string) {
        // …
      },
    }),
    { compute: reportsCompute },
  );
  ```

  - Clients are unchanged: the TypeScript client, and the Swift, Kotlin and Dart
    clients from `aws-blocks-swift` 0.2.0, `aws-blocks-kotlin` 0.3.0 and the matching
    Dart `blocks_runtime`, call `POST /aws-blocks/api/reports`, and the stack's
    shared API gateway routes that path to the namespace's compute — on every
    `apiFrontDoor` tier and behind `Hosting`, so the API keeps one domain. Calls to
    the bare `/aws-blocks/api` endpoint — raw HTTP calls and older native clients —
    still run on the default compute.
  - API calls stay capped at ~29 seconds by the gateway whatever the compute's
    `maxTimeoutSeconds`; run longer work in an `AsyncJob`.
  - Routing follows the export name (what the frontend imports), not the second
    `ApiNamespace` argument.
  - One `Compute` can host several namespaces and `AsyncJob`s; they then run in
    the same function.
  - Only `serverless` computes can serve API namespaces for now; a `container`
    compute is a type error.
  - Namespaces without a `compute`, `RawRoute`s and auth routes stay on the
    default compute. In local dev every namespace still runs in the dev server.
  - A `compute` created in a different `BlocksBackend` can't serve this backend's
    API: synth warns, and the namespace runs on this backend's default compute.

- 5572341: feat(core): `apiWaf` puts AWS WAF in front of the backend API

  `BlocksStack` and `BlocksBackend` take an `apiWaf` prop. It is off by default.

  - **`{ enabled: true, rateLimit? }`** creates a web ACL with the AWS managed Common rule set and Known Bad Inputs rule set, plus a per-IP rate limit (default 1000 requests per 5 minutes). The Common rule set's body rules (8 KB size, cross-site scripting, local and remote file inclusion) are set to count, so ordinary RPC payloads, including user-written HTML or Markdown, aren't blocked.
  - **`{ webAclArn }`** attaches a web ACL you already have instead. Synth checks that its scope and region match where it attaches.

  The web ACL attaches to whichever front door clients use. Under `apiFrontDoor: 'apigateway'` it is a REGIONAL web ACL on the API Gateway stage, in any region, even when `Hosting` fronts the API. If a CloudFront `Hosting` claims the API, its requests carry a marker header that the rate rule exempts, so browser users behind one CloudFront edge aren't counted as one client. Behind any other `Hosting` door the rate rule is left off and synth warns. Under `apiFrontDoor: 'cloudfront'` it is a CLOUDFRONT web ACL on the managed distribution. AWS only creates those in us-east-1, so in any other region pass `webAclArn` of a web ACL created there. Under `'cloudfront'`, when a CloudFront-backed `Hosting` fronts the API, `apiWaf` creates nothing and synth warns you to set the WAF on Hosting. `bb-realtime`'s WebSocket API isn't covered: AWS WAF can't attach to API Gateway WebSocket APIs.

- 88747f5: feat: Building Block mock entries fail closed in a deployed environment

  - **Runtime guard.** `@aws-blocks/core/bb-utils` exports `assertNotMockInDeployedEnv(bbName)`, the runtime counterpart of the `--conditions=cdk` synth check. It throws when a Building Block's mock (`default` export) entry is loaded in a deployed environment, which happens when the backend was bundled without the `aws-runtime` export condition. A deployed environment is detected from `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY`, which Blocks sets on every compute it provisions (Lambda, container, AgentCore). On compute Blocks doesn't configure, the check is inert and the `aws-runtime` bundler condition is the only protection. It is a no-op in local dev and tests.
  - **Wired into every BB mock entry.** Each Building Block's mock entry calls the guard at module load, so a mis-bundled artifact throws instead of running in-memory stubs: at process start on container and AgentCore computes, and on the first invocation on Lambda (where the backend is imported lazily, so the deploy succeeds and requests then return an error).
  - **AuthOIDC mock cookie secret.** The mock runtime's cookie-signing secret is now random per project instead of a fixed string, persisted (mode 0600) under the instance's `.bb-data/` mock data dir so local sessions survive backend reloads and dev-server restarts. Local sign-in is unchanged.
  - **Bundler conditions.** The `@aws-blocks/hosting` handler bundle and the AuthOIDC IdP-registration and DistributedTable GSI-manager Lambda bundles now pin the `aws-runtime` condition. The hosting bundle uses `['aws-runtime', 'module']` so esbuild keeps preferring packages' ESM builds.
  - **Scaffold template.** `@aws-blocks/create-block`'s primitive template calls the guard in its mock entry and depends on an `@aws-blocks/core` range that exports it.
  - **Docs.** `docs/guides/extending-with-existing-aws-resources.md` documents configuring your own bundler (esbuild, webpack) or unbundled Node (`--conditions=aws-runtime`) with the `aws-runtime` condition when deploying to a compute target Blocks doesn't own, and adds the guard call to the BB-author checklist.

  Maintainer note: these are `minor` bumps because AWS Blocks is pre-1.0, where `minor` is the channel for behavior changes — mock entries that previously ran in a deployed environment now throw.

- 1076ccc: fix(core): warn at synth when a durable stack disables API Gateway access logging

  A synth-time warning now fires on every durable (non-`DESTROY` removal policy)
  stack that has API Gateway access logging disabled — this includes the default
  `BlocksPresets.production` posture, where `accessLogging` is off by default. The
  warning id is `blocks:apigateway:access-logging-disabled`.

  Because it is a warning, ordinary `cdk synth`/`deploy` still succeed, but
  `cdk synth`/`deploy --strict` treat warnings as errors and fail until you either
  opt in or acknowledge it.

  Opt in by setting `accessLogging: true` in the backend's `defaults` (this also
  turns on S3 server access logging for any FileBucket, each getting its own log
  bucket). To keep it off deliberately, acknowledge the warning on the stack or
  backend returned by `create()`, after it resolves:

  ```ts
  const backend = await BlocksBackend.create(stack, "Blocks", {/* … */});
  Annotations.of(backend).acknowledgeWarning(
    "blocks:apigateway:access-logging-disabled",
  );
  ```

  Acknowledging on the `App` before `create()` does not suppress it.

- 928c48a: fix(bb-auth-oidc): `cognitoFederated()` registers the deployed app's callback and sign-out URLs on the Cognito app client

  The Cognito app client used to register only an `https://localhost` placeholder, so Cognito's `/oauth2/authorize` answered `redirect_mismatch` for a deployed app before any identity provider was contacted. The app client now registers, resolved at synth:

  - the app's public origin (`BLOCKS_PUBLIC_ORIGIN` — the CloudFront distribution, primary custom domain, HTTPS ALB or stacked door, or the managed `apiFrontDoor: 'cloudfront'` distribution) plus the callback path;
  - the shared API Gateway URL (stage included) plus the callback path, used when no front door publishes a public origin;
  - `http://localhost:3000` plus the callback path, in sandbox mode only.

  Sign-out URLs list the same origins. Only an `https://` public origin is registered, since Cognito accepts `http://` only for `localhost`; a plain-`http://` one (an ALB door without a certificate) is left out and synth emits an `@aws-blocks/bb-auth-oidc:PlainHttpPublicOrigin` warning, because federated sign-in through that door needs HTTPS.

  New `cognitoFederated()` options `additionalCallbackUrls` and `additionalLogoutUrls` register URLs that can't be derived at synth — browser PKCE SPA redirect pages, native-app custom schemes used as a direct sign-in redirect, custom-domain names other than the primary one, or a sandbox dev server on another port. Entries from every `cognitoFederated()` provider are merged and de-duplicated. Each entry is validated at synth, which fails with a descriptive error naming the URL and the option for an entry that isn't a well-formed redirect URL: surrounding whitespace or control characters, a backslash, userinfo (`@`) in the host, a missing, wildcard or non-ASCII host, a plain-`http://` URL whose host isn't `localhost`, a `javascript:`, `data:`, `file:`, `vbscript:`, `blob:` or `about:` scheme, a `#` fragment, or a `code` / `state` query parameter. Native custom schemes such as `myapp://auth/callback` are accepted; the relay flow does not need one registered, since its `redirect_uri` is the backend's HTTPS callback.

  `@aws-blocks/core/cdk` exports two read-only helpers for first-party Building Blocks (marked `@internal`, not a stability-guaranteed API): `getRegisteredConfigValue(scope, key)` reads a value registered with `registerConfig`, and `getSharedGatewayUrl(scope)` returns the shared REST API's base URL. Both read at call time, so call them from a `cdk.Lazy` producer when the value is registered or built after the Building Block is constructed.

  **Upgrading:** the app client's callback and sign-out URLs are now managed by the Building Block. If you added URLs to the Cognito app client outside of CDK (for example, in the console as a workaround for #1001), those manual entries are replaced on the next deploy. Add any URLs you still need through `additionalCallbackUrls` / `additionalLogoutUrls` so they are kept.

- 4d5ea86: feat(auth-oidc): limit `stubIdp()` providers to local development and sandbox deployments

  Behavior change (0.x minor = breaking channel): stacks that configure `stubIdp()` outside a sandbox now fail at synth, and deployed compute serves the stub IdP routes only in a sandbox.

  - **AuthOIDC.** `stubIdp()` providers are now limited to local development and sandbox deployments. Synth fails when a non-sandbox stack configures a `stubIdp` provider, and deployed compute mounts the stub IdP routes only when the deployment is a sandbox. Stub authorization codes are now signed with a key derived from each instance's cookie-signing secret.
  - **Core.** Adds `getDeploymentType()` (`'local' | 'sandbox' | 'production'`) and the `DeploymentType` type, and propagates the deployment type to runtime as `BLOCKS_DEPLOYMENT_TYPE` so an app can select providers consistently at synth and runtime. Also exports `getCachedConfigValue(key)`, which reads the loaded deployed config without the `process.env` override that `getConfigSync()` applies. `@aws-blocks/core/cdk` also exports `isSandboxContext(scope)`, which reads the `sandboxMode` CDK context.
  - **DistributedTable.** Sandbox detection now uses `isSandboxContext()`, so a boolean `sandboxMode: true` CDK context (for example from `cdk.json` or `setContext`) is treated as a sandbox, in addition to the string `'true'`. This applies to the sandbox-only GSI management permissions and the GSI manager's sandbox mode.

  To keep a stub provider for local and sandbox while using a real provider elsewhere, select providers by deployment type:

  ```ts
  import {
    AuthOIDC,
    google,
    stubIdp,
    getDeploymentType,
  } from "@aws-blocks/blocks";

  const providers =
    getDeploymentType() === "production"
      ? [google({ clientId, clientSecret })]
      : [stubIdp({ name: "google" })];

  new AuthOIDC(app, "auth", { providers });
  ```

  Migration: restart `npm run sandbox` once after upgrading. Its initial full deploy writes `BLOCKS_DEPLOYMENT_TYPE` into the deployed config; a `cdk watch` hotswap alone does not, and the stub IdP routes return 404 until that full deploy runs.

- 1d58d60: Report Bedrock invoke-time model-access refusals as `AgentErrors.ModelUnavailable` with an actionable message. When Bedrock refuses a model because the account has not submitted Anthropic's one-time use case details, has not activated the model's one-time AWS Marketplace subscription, or is not entitled to the model, the `error` chunk now carries a message explaining what to do plus an optional `errorName` field, and the `onError` callbacks of `createChat` and `useChat` receive the branded error as an optional `cause` argument. Error chunks without `errorName` behave as before. `complete()` now rejects with `ModelUnavailableException` (instead of `StreamFailedException`) for these failures and for health-check failures, and the persisted error row's `metadata` records the same `errorName`. The README now explains that the Bedrock presets are Anthropic models that need the one-time use case details form and AWS Marketplace subscription, replacing the outdated "enable model access" guidance.
- 7114399: **Breaking (behavior):** `Database` now reports request errors as named 4xx errors instead of a generic 500 `QueryFailed`, on the local (PGlite), `pg` and Data API engines:

  | Postgres error                                         | SQLSTATE | Error                                | HTTP status |
  | ------------------------------------------------------ | -------- | ------------------------------------ | ----------- |
  | Row-level-security rejection, or no grant for the role | `42501`  | `DatabaseErrors.PermissionDenied`    | 403         |
  | Check constraint                                       | `23514`  | `DatabaseErrors.CheckViolation`      | 400         |
  | Not-null constraint                                    | `23502`  | `DatabaseErrors.NotNullViolation`    | 400         |
  | Foreign key                                            | `23503`  | `DatabaseErrors.ForeignKeyViolation` | 409         |

  Match them with `isBlocksError(e, DatabaseErrors.PermissionDenied)` and so on, on the server or the client. Each carries a fixed message; the driver text stays on the server as `cause`. None is retriable.

  If your code matched these failures with `isBlocksError(e, DatabaseErrors.QueryFailed)`, or treated them as server errors because their status was 500, match the new names instead.

  `withRLS()` on PostgreSQL 16 and later (including Aurora) also needs the database user to be a member of the RLS roles: add `GRANT authenticated TO CURRENT_USER;` (and the same for `anon`) to your migrations. If the role switch is refused, `withRLS()` fails with a 500 `QueryFailed` and the server log names the missing grant.

- 92909f8: **Breaking (behavior):** `withRLS({ userId, role, claims })` no longer lets `claims` override `sub` or `role` in `request.jwt.claims`. `sub` always comes from `userId` and `role` from `role`, so an RLS policy that reads either claim sees the server-derived value. Any other claims still pass through.

  If you relied on `claims.sub` or `claims.role` to change those values, pass the intended value as `userId` or `role`, or put it under a different claim name.

- 33edca2: Re-export `submitAuthAction` from the umbrella `@aws-blocks/blocks/ui` entry point, alongside the existing `Authenticator`, `AuthenticatedContent`, `AccountMenuBar`, `onAuthChange`, and `broadcastAuthChange` exports. Consumers building a custom auth UI on `@aws-blocks/blocks` can now import the helper that pairs `setAuthState` with the local auth notification — so `onAuthChange` subscribers and `AuthenticatedContent` re-render on a real signed-in/signed-out transition — without reaching into `@aws-blocks/auth-common` directly. Relates to #185; addresses #208 review feedback.
- 48c35f6: feat(core): Node clients resend a call once when the connection closes before the response headers arrive (at-least-once delivery); `retryStaleConnection: false` opts out

  In Node (CLIs, SSR servers, scripts), an API call made after a few idle seconds could fail with `TypeError: fetch failed` (cause `other side closed`, `ECONNRESET` or `EPIPE`) when the deployed API had closed the pooled keep-alive connection just as the call was sent. The typed client now resends such a call once on a new connection, but only when `fetch` failed before the response headers arrived, with `TypeError: fetch failed` whose cause is an undici socket error (`UND_ERR_SOCKET`, for example `other side closed`), `ECONNRESET` or `EPIPE`.

  **This makes delivery at-least-once.** In the idle-close race the first copy never reached your method. But Node's `fetch` doesn't say whether the connection was a reused one, so the same failure on a fresh connection is resent too, including a server that read the request and crashed before answering: in that rare case a method runs twice. Behind API Gateway or CloudFront a crashed backend answers with a 5xx, which is never retried. Keep state-changing methods idempotent where a duplicate would matter, or pass `retryStaleConnection: false` to `ApiNamespaceClient` (or to the generated `generateClient`) for at-most-once delivery. Timeouts, aborts, failures after the response headers arrived (while reading the body), and HTTP or JSON-RPC errors are still never retried. Browser behaviour is unchanged (browsers already resend in this case).

- 9a32674: fix(core): enforce TLS, enable versioning, and add access logging on the config bucket

  The shared config bucket (`BlocksConfigBucket`, holding `blocks-config.json`) now sets `enforceSSL: true` (a bucket policy denying non-TLS access), `versioned: true` (making the pre-existing noncurrent-version expiration rule effective, so an overwritten config stays recoverable for ~24h before the 1-day noncurrent expiry removes it), and delivers S3 server access logs to a new dedicated, locked-down log bucket. Because `blocks-config.json` is derived from the CDK app, the durable way to restore a prior config is to redeploy; the ~24h window is only a short in-transit safety net. The log bucket resolves its removal policy and log-retention from the stack `defaults` (production ⇒ RETAIN + 365-day expiry, sandbox ⇒ DESTROY + 7-day expiry), so production access logs are not torn down with the stack. Every stack now synthesizes an additional log bucket + bucket policy + versioning config.

  Note: enabling bucket versioning is one-way — S3 can only move a versioned bucket to Suspended, never back to unversioned — so reverting this change leaves the config bucket in the Suspended state rather than unversioned.

- 4553866: feat(core): opt-in permissions boundary on every role AWS Blocks creates, plus a synth-time IAM report

  - **`defaults.permissionsBoundary`** (new, optional) attaches an IAM permissions
    boundary to every IAM role AWS Blocks creates: the shared execution role,
    block-owned helper roles, the CDK custom-resource roles blocks cause, and
    `Hosting`'s roles. That includes the Lambda@Edge and CloudFront-monitoring
    roles in the separate `us-east-1` stacks and the cross-region-reference
    provider roles, which CDK's own `@aws-cdk/core:permissionsBoundary` context
    doesn't reach. Pass a policy name, a full policy ARN, or an `iam.IManagedPolicy`:

    ```ts
    defaults: { ...BlocksPresets.production, permissionsBoundary: 'my-app-boundary' }
    ```

    A boundary is a ceiling; it never grants. It's unset in both presets, and
    leaving it unset keeps synthesized templates unchanged. When both this option
    and the CDK context are set, this option wins for Blocks-created roles and
    synth warns.

  - **IAM report:** every synth now writes `cdk.out/<stack>.blocks-iam.json`
    (`<stack>.<backendId>.blocks-iam.json` for an embedded `BlocksBackend`). It
    lists every statement on the shared execution role, the managed policies, the
    boundary, and the Building Blocks each statement's resources belong to, plus
    an inventory of every IAM role AWS Blocks created with its boundary and tags as
    the template carries them. The file is sorted and deterministic, so CI
    (continuous integration) can diff it between builds or check every role's
    boundary and tags. It doesn't change the CloudFormation template. The file is
    written on every synth, whether or not a permissions boundary is set.
  - **Shared multi-app accounts:** the core README has a new section on running
    many apps in one AWS account: an example boundary policy that uses
    attribute-based access control (`${aws:PrincipalTag/app}`) so one policy
    serves every app, the deploy-role conditions that make the boundary
    mandatory, and the limits of the approach.

- 48c35f6: feat(core): refuse to synth when a renamed or removed Building Block would take a stateful resource with it

  Some Building Blocks commit a baseline file per instance under
  `aws-blocks/baselines/<stack>/` to refuse destructive changes at synth. When
  such a block was renamed or removed, nothing read its baseline any more, so
  CloudFormation could delete the resource it guarded with no warning.

  Every `BlocksStack` and `BlocksBackend` now checks its own baseline directory
  at synth, even when no instance of the block is left: a baseline that records a
  stateful resource and that no block in the stack claims fails synth, naming the
  block and what CloudFormation would delete. Restore the block's old id, or
  re-baseline deliberately with the block's re-baseline variable set to that
  block's id (which deletes the stale file). Apps without baseline files are
  unaffected.

  This is a minor release because it defines a new file format that apps commit to
  their repositories. Each baseline file carries a top-level `version` (currently
  `1`; a file without one is read as `1`), and every later release keeps reading
  every earlier version. A baseline with a higher version than this release knows
  fails synth with a message to upgrade `@aws-blocks/core`; one whose `version` is
  not a whole number from 1 fails synth as invalid. Neither is ever rewritten or
  deleted. Commit these files with your
  app; they are written and updated by the Building Block that owns them.

- e68e653: fix(bb-distributed-table): keep a retained table's indexes when the table leaves the stack

  Deleting a stack, or removing a DistributedTable from the app, used to drop every global secondary index from the table before CloudFormation reached the table itself. With the production default (`RemovalPolicy.RETAIN`, `protection: 'locked'`/`'retained'`) the table survived without any of its indexes, and the delete waited for every index drop. The GSI manager now reads its own stack's status and current template on Delete, and leaves the indexes in place when the table is leaving the stack. Removing indexes from the config and redeploying still drops them. If the stack cannot be read, the indexes are kept. If only the template cannot be read during the cleanup phase of an update (or of a rolled-back update), the indexes are kept and the deploy shows a `DELETE_FAILED` event naming the table and its indexes, so any that are no longer configured can be removed by hand; the deploy itself still succeeds.

  A Delete whose table no longer exists (for example, deleted outside CloudFormation) now succeeds instead of leaving the stack in `DELETE_FAILED`.

  The package now depends on `@aws-sdk/client-cloudformation` at runtime (already a runtime dependency of `@aws-blocks/core`, so it is normally installed already). On upgrade, every stack with a table that defines `indexes` gets a new code bundle for both GSI manager Lambdas and one read-only IAM statement on the GSI manager's role: `cloudformation:DescribeStacks` and `cloudformation:GetTemplate` on the stack itself. Tables, indexes and the GSI custom resource are not changed or re-run. The new behaviour applies once this version is deployed, so upgrade a stack first, then delete it or remove a table or its `indexes` in a later deploy.

- 3142985: **Breaking (behavior):** two changes reach apps that are already deployed:

  - The deployed `EmailClient` now validates addresses before calling SES, so `send()` throws `InvalidInputException` (and `sendBatch()` marks the message `failed`) for addresses the validator rejects but SES accepted, for example quoted local parts (`"john.doe"@example.com`) or non-ASCII domains.
  - The shared execution role is granted only `ses:SendEmail` and `ses:SendBulkEmail`. An app that calls the SES SDK directly (for example `SendRawEmail` for attachments) and relied on this block's grant of `ses:SendRawEmail`, `ses:SendTemplatedEmail` or `ses:SendBulkTemplatedEmail` must grant those actions itself.

  `EmailClient` changes:

  - `sendBatch()` sends a message without `html` as plain text only, as `send()` already does. It previously reused the plain-text `body` as the HTML part, where a mail client would render any markup in it. Messages with `html` are sent in separate calls, before the text-only ones; `results` stays in input order.
  - The deployed client validates every message the same way the local one does, before calling SES: every address (To, CC, BCC, `fromAddress` and `replyTo`), at most 50 recipients, and at most 40 MB. Invalid input throws `InvalidInputException` (or `EmailSendFailedException` for size) from `send()`, and is marked `failed` in `sendBatch()` results. Addresses may carry a display name made of plain words or one quoted string (`Jane Doe <jane@example.com>`, `"Doe, Jane" <jane@example.com>`), which SES accepts. Surrounding whitespace and control characters are rejected.

- 9c96135: feat(bb-file-bucket): customer-managed KMS encryption, Object Lock, and a stack-wide default for S3 access logging

  - **`encryption`** on `FileBucket` takes the same values as `KVStore` and `DistributedTable`. `'aws-managed'` (the default) keeps SSE-S3. `'customer-managed'` creates a dedicated KMS key for the bucket, with rotation on, and removes it along with the bucket. `FileBucket.fromKmsKey(arn)` uses a key you already own. Both KMS options use S3 Bucket Keys. The runtime role is granted the key permissions, so `put`/`get` and presigned URLs keep working.
  - **`objectLock: { mode: 'governance' | 'compliance', retentionDays }`** turns on S3 Object Lock with a default retention for every new object version. It needs versioning (on by default) and a retained bucket, and both are checked at synth: `versioned: false` and a `'destroy'` removal policy, which is the sandbox default, both fail synth. Pass `removalPolicy: 'retain'` to use Object Lock in a sandbox. Object Lock can only be turned on when the bucket is first created. S3 requires a signed checksum on every upload to such a bucket, which a presigned URL can't carry, so `putUrl()` and `createUploadHandle()` throw the new `FileBucketErrors.PresignedUploadUnsupported` there; upload with `put()`.
  - **`BlocksDefaults.storageAccessLogging`** (optional) turns S3 server access logging on or off for every `FileBucket` without changing API Gateway access logging. It is unset in both presets, so `FileBucket` still falls back to `accessLogging` and existing stacks deploy unchanged.

  `encryption` and `objectLock` are ignored on a bucket wrapped with `FileBucket.fromExisting`, and synth warns when either is set there. `@aws-blocks/blocks` re-exports `ObjectLockOptions` and the FileBucket key reference type, as `FBExternalKmsKeyRef`.

  `@aws-blocks/core` now parses the `encryption` option in one place for all three storage blocks. An unrecognized value still warns and falls back to the AWS-managed default.

- ce5dfa9: feat(compute): the `Compute` block and container-backed AsyncJobs

  Adds a single `Compute` Building Block for choosing where a workload runs, and
  lets an `AsyncJob` run on a container (AWS Fargate) instead of the default
  serverless compute — for long-running or high-memory work. All net-new,
  unreleased surface.

  **`Compute`.** `new Compute(scope, id, { type, ...options })` states the compute
  type explicitly (`serverless` | `container`); Blocks maps the type to the AWS
  service. Options are per-type (a discriminated union), so an attribute that
  doesn't apply to the chosen type is a compile error, and the service name never
  appears in the API. The concrete backing computes stay internal and extend
  `Scope` like every other block.

  - `serverless`: `memory`, `maxTimeoutSeconds` (the function's runtime ceiling).
  - `container`: `size` (a valid `{ vcpu, memory }` combination — invalid pairs are
    unrepresentable), `scaling` (real Application Auto Scaling —
    `min/maxInstances` + `cpu`/`memory` target-tracking and `queue-depth`
    step-scaling policies;
    queue-depth sums the messages across the queues the compute drains), and a
    custom `image`.

  **`AsyncJob({ compute })`.** A job runs on the app default (serverless) unless
  given a `Compute`. On a container, delivery is an owner-matched SQS poller the
  container self-starts, and each delivery runs in its own worker thread so the
  job's `timeoutSeconds` is hard-enforced (the worker is terminated at the
  deadline). `maxConcurrencyPerCPU` sets in-flight deliveries per vCPU — the
  per-instance count is `max(1, ceil(maxConcurrencyPerCPU × vcpu))`, and it is a
  compile error (and a synth-time error) on a serverless job. Both are properties
  of the work and live on the job; `size`/`scaling` live on the compute. In local
  dev, compute assignment is transparent. `AsyncJobOptions` has no compute-kind
  type parameter — the kind is inferred from the `compute` argument — so
  `new AsyncJob<Payload>(…)` with a container compute compiles without spelling a
  second generic.

  **One shared VPC per backend, and stateful blocks stay put.** A container needs
  a VPC, so Blocks provisions **one** shared VPC (and one ECS cluster) per backend
  root at a fixed id — N container configs do **not** create N VPCs, and placement
  is independent of declaration order. The shared VPC is tagged by origin:
  `provided` (customer passed `defaults.vpc.network`) or `derived` (Blocks created
  it). Stateless compute (Lambda, the container) uses whichever exists. A
  **stateful** block — today `Database` — joins only a customer-`provided` VPC; it
  never auto-joins a Blocks-`derived` one. This is a safety guarantee: without it,
  adding a container (or upgrading to a version that derives a VPC) could move an
  existing Aurora cluster into the new VPC, which CloudFormation applies as a
  _replacement_ — destroying the database. A Database with no customer VPC keeps
  building its own, exactly as before. (Moving a Database into a shared VPC remains
  a deliberate, out-of-band migration.)

- 7477b6e: Add `compute.type: 'web-function'` to run the SSR server on AWS Lambda Web Functions. The framework's own Node.js server runs directly on Lambda behind CloudFront origin access control, with no API Gateway and no Lambda Web Adapter. Each execution environment serves many concurrent requests and is billed for active CPU. It works with Astro, SvelteKit, Nuxt/Nitro and Next.js in the Regions where Web Functions are available. When this compute is selected, Nitro builds with the `node-server` preset and Next.js builds with OpenNext's `node` wrapper automatically. Tune it with `compute.webFunction` (`maxConcurrencyPerEnvironment`, `maxEnvironments`, `rateLimit`). The default (`'lambda'`) is unchanged.

  Sandbox deploys (`npm run sandbox`) of a Web Function app skip CloudFormation Express Mode after the first deploy. Express Mode can't update a Web Function endpoint, so the deploy uses a full deploy with rollback instead.

- dd5e807: feat(core): emit an OIDC client's inferred provider names

  `blocks-generate-spec` now writes `x-blocks-type-args` for an `oidc/client` result
  from the provider names the type checker infers, including for a namespace built
  in another module. `AuthOIDC.createApi()`'s `getClient()`, typed
  `OIDCClient<ProviderName<P>>`, now carries the configured provider names as a
  string enum, for example `[{ "type": "string", "enum": ["google", "github"] }]`,
  so native clients can generate a provider type. Provider names that resolve to
  plain `string` or `any` emit no type args. Other transferables are unchanged.

  `@aws-blocks/blocks` gets the same bump because it re-exports `@aws-blocks/core/scripts`.

- 8565ef7: feat: place a whole scope, or a CronJob, on its own compute

  A `Scope` takes `compute`, which places everything created under it, including in
  its child scopes, on one `Compute`:

  ```ts
  const reportsCompute = new Compute(scope, "reports-compute", {
    type: "serverless",
    memory: 4096,
  });
  const reports = new Scope("reports", {
    parent: scope,
    compute: reportsCompute,
  });

  export const reportsApi = new ApiNamespace(reports, "reports", (context) => ({
    /* methods */
  }));
  new CronJob(reports, "nightly", {
    schedule: "cron(0 2 * * ? *)",
    handler: async () => {},
  });
  ```

  - The nearest setting wins: a block's own `compute`, then the nearest scope's,
    then the app's default compute.
  - `AsyncJob` follows a serverless or container scope. `ApiNamespace` and
    `CronJob` run only on a serverless compute for now; under a container scope
    they fail synth with an error that names the compute.
  - `Realtime` and `RawRoute` always run on the default compute, inside such a
    scope too. `Realtime.publish()` works from any compute.

  `CronJob` also takes its own `compute` (serverless only; a container compute is a
  type error). Each job's schedule now gets permission to invoke the function it
  targets: before, the shared scheduler role could only invoke the first job's
  function, so a job on a different function would have been refused at run time.

  A `CronJob` or `AsyncJob` whose compute (its own, or its scope's) belongs to a
  different backend now fails synth with an error naming the compute. This happens
  when several backends are built from one backend module and the `Compute` comes
  from a sub-module, which stays bound to the first backend that imported it.
  Before, the job was wired to that backend's function: a scheduled run failed
  every time, or synth stopped with a dependency cycle.

  In local dev every block still runs in the dev server.

- 3d83cb6: feat(bb-secret): make `Secret` read-only at runtime by default; add `allowRuntimeWrite`

  A `Secret` is now **read-only at runtime unless you opt in**. By default the instantiated object exposes only `get()` and `listVersions()` — there is no `put()` method (a call is a compile error _and_ the method is absent from the object at runtime), and the deployed execution role is granted **read-only** IAM (`GetSecretValue` + `ListSecretVersionIds`, no `PutSecretValue`). This is the least-privilege default: most apps read a credential that is set out-of-band (console / `aws` CLI / CI), so the running app never needs write access.

  Pass the new `allowRuntimeWrite: true` option to opt into runtime writes — then `put()` is present on the object and the execution role is granted `PutSecretValue`. The option applies to every secret, including one wrapped via `Secret.fromExisting(arn)`.

  ```typescript
  // Read-only (default): no put(); role gets read-only IAM.
  const stripeKey = new Secret(scope, "stripe-api-key");
  const key = await stripeKey.get();

  // Writable: the app sets/rotates the value itself.
  const token = new Secret(scope, "self-rotating-token", {
    allowRuntimeWrite: true,
  });
  await token.put("t-abc123");
  ```

  **Behavioral/typing change (bb-secret is pre-1.0).** `Secret` is now exposed as an overloaded constructor whose return type reflects `allowRuntimeWrite`: `true` yields a `WritableSecret<T>` (has `put`), otherwise the read-only `Secret<T>`. Existing code that called `put()` on a default secret must now pass `allowRuntimeWrite: true`. Deployed stacks created before this change that relied on the runtime writing the secret will lose `PutSecretValue` until the declaration sets `allowRuntimeWrite: true` — add it where the app genuinely writes.

- 82ea78a: A project config can no longer re-enable telemetry that a global config disabled.

  `isTelemetryEnabled()` returned early on a project `telemetry.enabled: true` before reading `~/.blocks/config.json`, so `blocks-telemetry --disable --global` followed by `--enable` left the send gate open while `--status` reported disabled. The gate now resolves through `getTelemetryStatus()`, so only `false` short-circuits and the two cannot disagree. `blocks-telemetry --enable` also warns, naming the mechanism, when a broader opt-out still applies. The env var already overrode both config files, and a project `false` still beats a global `true`.

  Behavior change (0.x minor = breaking channel): if you globally disabled telemetry and relied on a project config to turn it back on, that project stays opted out. Re-enable globally with `npx blocks-telemetry --enable --global`.

- f704a68: feat(auth-common): add the `StatusMessage` UI primitive

  Adds `StatusMessage` to `@aws-blocks/auth-common/ui` (re-exported from `@aws-blocks/blocks/ui`) — a themed, accessible status line for the loading / success / error affordance the starter templates otherwise hand-roll with inline styles.

  - `StatusMessage(options?)` returns a `StatusMessageHandle` (`{ element, set }`): mount `element`, then drive it with `set(kind, text)` as an async operation progresses.
  - Four lifecycle states (`StatusKind`): `idle` (muted), `loading` (muted + spinner), `success` (green), `error` (red) — all driven by the existing `--bb-*` semantic tokens, so the message matches the active light/dark theme.
  - The root is a polite ARIA live region (`role="status"`, `aria-live="polite"`); the `loading` spinner is decorative (`aria-hidden`) and holds still under `prefers-reduced-motion`.
  - Adds the `.bb-status*` / `.bb-spinner` classes and a reduced-motion-aware `bb-spin` keyframe to the shared theme CSS.
  - The `auth-cognito` template now renders its status lines through `StatusMessage` instead of a hand-built classed span.

  No breaking changes — purely additive.

### Patch Changes

- 5dc1d98: fix(bb-agent): authenticate the openai-api provider to Bedrock Mantle with the agent's AWS credentials

  An `openai-api` model whose `endpoint` is a Bedrock Mantle URL (`https://bedrock-mantle.<region>.api.aws/...`) and has no `apiKey` now authenticates with short-term Bedrock API keys minted from the AWS credentials the agent runs with, refreshed automatically. The deployed runtime role is granted the `bedrock-mantle` permissions it needs. `OPENAI_API_KEY` is not used for Mantle endpoints, and an explicit `apiKey` still takes precedence.

- 48c35f6: `Agent` reads and writes its session state under the session bucket's real name, which `FileBucket` now shortens when the `fullId` is over 63 characters. Agents whose bucket name already fits are unchanged.
- 763f67e: AuthBasic now caps the number of failed guesses against a single verification
  code (sign-up confirmation and password-reset OTP). A 6-digit code (~19.8 bits)
  is exhaustively guessable within its 10-minute validity window at any reasonable
  request rate, so an always-on per-code attempt cap narrows that exposure.

  After 5 consecutive wrong guesses the code is invalidated and the user must
  request a fresh one; a wrong guess never extends the code's life. The cap is
  enforced atomically — each attempt is reserved with a compare-and-swap before
  the guess is evaluated, so concurrent guesses (including across Lambda
  instances on one row) cannot bypass it. The error is the same generic
  `InvalidCodeException` on a wrong guess, a lost race, and an exhausted code, so
  no oracle reveals whether the cap was hit. The cap bounds guesses against one
  code; rate-limiting code issuance volume remains an infrastructure-layer
  concern (WAF / API Gateway throttling).

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

- 72c8165: AuthBasic can now lock an account after too many consecutive failed sign-ins,
  an opt-in defense against credential-stuffing and password brute-forcing (issue
  #766). Pass the new `lockout` policy to enable it:

  ```typescript
  const auth = new AuthBasic(scope, "auth", {
    lockout: { maxAttempts: 5, windowSeconds: 900, lockoutSeconds: 900 },
  });
  ```

  Failed attempts are counted **per username** in the existing `codes` store
  (under a `lockout:<username>` key, with a TTL so counters self-reap and never
  grow unbounded). Once `maxAttempts` consecutive failures accumulate within
  `windowSeconds`, the account is locked for `lockoutSeconds`; the lock is
  enforced at the **top of `signIn`**, before the user record is read or the
  password compared, so a locked account sheds the bcrypt cost under attack and
  exposes no timing oracle. A successful sign-in clears the counter.

  This is a `minor` (not `patch`) bump because it adds the exported error constant
  `AuthBasicErrors.AccountLocked` (`AccountLockedException`, 429, branded so the
  name crosses the wire) and the new `lockout` option (`LockoutPolicy`) on
  `AuthBasicOptions`. The error message is generic — it reveals neither the
  username nor any SDK metadata — and `retriable` is left `false` (a lockout
  requires waiting out the window, not an immediate retry).

  Throttling is **disabled unless `lockout` is passed**, so existing apps are
  unaffected. This is per-account credential-guess protection, complementary to —
  not a replacement for — infrastructure-layer rate limiting (CloudFront WAF, API
  Gateway throttling) for volumetric/DDoS protection.

  Per-username counting (rather than per-IP) matches `AuthCognito`'s managed
  lockout and avoids locking out a whole shared NAT/corporate egress on one user's
  typos. The umbrella `@aws-blocks/blocks` is bumped because the bundled
  `bb-auth-basic` README/DESIGN docs it mirrors have changed.

- ee69cd7: docs(bb-file-bucket): document that `corsRules` is required for browser uploads and downloads

  Browser uploads and downloads that worked under `npm run dev` failed after
  deploying to a sandbox or production stack with `No 'Access-Control-Allow-Origin'
header is present on the requested resource`, and nothing in the docs explained
  why. The local dev file-server accepts any origin, but the deployed S3 bucket has
  no CORS configuration unless `corsRules` is set — and it does not inherit the
  stack's `defaults.allowedOrigins` or the Hosting domain.

  - **bb-file-bucket README** — new "Browser Uploads and Downloads (CORS)" section
    with the failing error, a working `corsRules` example (`GET`/`PUT`,
    `allowedHeaders: ['Content-Type']`), how to find the deployed Hosting origin
    (`HostingUrl`), and notes on preflight headers, S3 origin syntax, the scope of
    the wildcard synth guard, which requests need CORS, and wrapped buckets. The
    `corsRules` option row, Best Practices, and Local Development sections now
    point to it.
  - **bb-file-bucket TSDoc / DESIGN.md** — `corsRules` documents its no-CORS
    default, that it is ignored for wrapped buckets, and (new D-FB-15) why it is
    not derived from `defaults.allowedOrigins` or the Hosting domain.
  - **blocks README** — the Security Considerations list notes that
    `defaults.allowedOrigins` covers the API only and FileBucket needs its own
    `corsRules`.

  Documentation only — no runtime or API change.

- e15fe58: fix: publish `TROUBLESHOOTING.md` at the package root

  The package README links to `./TROUBLESHOOTING.md`, but the file only shipped under `docs/`, so the link was dead on npm and in `node_modules/@aws-blocks/blocks/`. It now ships at the package root too.

- 943d405: fix: error constants can be imported in frontend code

  Frontend code imports a Building Block's error constants to match errors with `isBlocksError`, which resolves the
  package's `browser` entry. Some of those imports failed the frontend build:

  - `AppSettingErrors`, `EmailErrors`, `FileBucketErrors`, and `LoggingErrors` were missing from the `browser` entries
    of `@aws-blocks/bb-app-setting`, `@aws-blocks/bb-email-client`, `@aws-blocks/bb-file-bucket`, and
    `@aws-blocks/bb-logger`. They are now exported.
  - Any import from `@aws-blocks/bb-auth-basic` or `@aws-blocks/bb-auth-cognito`, including `AuthBasicErrors` and
    `AuthCognitoErrors`, failed with `No matching export ... for import "ApiNamespace"`. The browser stubs no longer
    depend on `ApiNamespace`; their server-only `createApi()` / `buildApi()` now throw if called in the browser.
  - `CronJobErrors.ScheduleNotSupported` was `undefined` in the browser, so `isBlocksError(e, CronJobErrors.ScheduleNotSupported)`
    never matched. The `@aws-blocks/bb-cron-job` and `@aws-blocks/bb-dashboard` browser entries now re-export the
    server's constants instead of keeping their own copies.
  - `@aws-blocks/bb-realtime` had no `browser` entry, so importing `RealtimeErrors` in frontend code pulled in the
    server build and failed to bundle. It now has one.

  `@aws-blocks/blocks`: the conditional-export parity test now checks that every Building Block with error constants
  has a `browser` entry that exports them with the same values, and that the entry bundles for the browser.

- 50b8c94: `npm run deploy` and `npm run sandbox` now check that CDK has been bootstrapped in the target account and Region before they synthesize. In an account and Region that were never bootstrapped, a deploy used to fail only after synthesis, with `SSM parameter /cdk-bootstrap/hnb659fds/version not found`. The commands now read that parameter, with the credentials that the credential check verified and the qualifier from `@aws-cdk/core:bootstrapQualifier` in the CDK context, and stop right away with the command that bootstraps the account and Region: `npx cdk bootstrap aws://<account-id>/<region> --app=`. `--app=` keeps CDK from synthesizing the app to find environments. The commands never bootstrap for you, because bootstrapping creates IAM roles in the account. Only a missing parameter stops the deploy; a denied read, a network error or a timeout does not. The destroy commands do not run this check.
- 943d405: fix: export types missing from the `cdk` entry point

  Some types exported by the default entry point of `@aws-blocks/blocks` were missing from its `cdk` entry, so backend
  code importing them failed to type-check under that condition — for example,
  `import type { SubscribeOptions } from '@aws-blocks/blocks'`.

  The `cdk` entry now exports `AuthActionInput`, `AgentTool`, `DefaultToolContext`, `ToolFactory`, `ToolHandlerArgs`,
  `ToolsConfig`, the `AuthCognito` admin types (`AdminAction`, `AdminActionGate`, `AdminCreateInit`, `AdminDisabled`,
  `AdminGetterOf`, `AdminGrants`, `AdminOptions`, `AdminSurface`, `AdminUser`, `AdminUserFilter`, `CodeDeliveryFn`,
  `GroupAdmin`, `LifecycleAdmin`, `SetPasswordOptions`), `DisconnectReason`, `RealtimeChannel`, `RealtimeSubscription`,
  `SubscribeOptions`.

- a3969b5: fix: actionable errors for runtime methods called during `cdk synth`

  Calling a Building Block's runtime method (for example `db.query()`, `bucket.put()`, `auth.requireAuth()`, or
  `auth.admin`) at the top level of a backend module runs it during `cdk synth`. For many Building Blocks this failed with
  a cryptic `TypeError: x is not a function`; it now throws the same actionable error the other Building Blocks already
  give: `<Class>.<method>() cannot be called during CDK synth. Data methods run at request time — …`.

- 48c35f6: fix: export the same names from every conditional entry point

  Some Building Blocks were missing named exports from their `cdk` or `browser`
  entry points, even though the TypeScript types said they were there. Importing
  one of these names from code evaluated during `cdk synth`, or from a browser
  bundle, failed at import time. Added:

  - `cdk` entry: `InterruptError` (`@aws-blocks/bb-agent`), `BatchSubmitFailedError`
    (`@aws-blocks/bb-async-job`), and `RLSEnabledDatabase` and `PgClientEngine`
    (`@aws-blocks/bb-data`).
  - `browser` entry: the error constants `AgentErrors`, `AppSettingErrors`,
    `EmailErrors`, `FileBucketErrors` and `LoggingErrors` (for `isBlocksError` checks
    in frontend code), plus `InterruptError`, `BedrockModels` and `OllamaModels`
    (`@aws-blocks/bb-agent`) and `fromExisting` (`@aws-blocks/bb-data`).

  The conditional-exports regression test now compares every Building Block's
  `aws-runtime`, `cdk` and `browser` entries against its default entry in both
  directions, so these gaps can't come back unnoticed.

- 48c35f6: The Lambda handler routes Cognito user pool trigger events to the Building Block registered for that user pool (`EventSourceMapping.COGNITO_USER_POOL`). It returns the event unchanged, and it rejects an event for a pool that no block handles.
- 48c35f6: An RPC error response now passes a `Set-Cookie` through only when every browser would delete that cookie, including when it has several `Expires` attributes or one that is not a strict HTTP date. For example, `Expires=Thu, 01 Jan 1970 00:00:00 GMT; Expires=Fri, 01-Jan-2100 00:00:00 GMT` is no longer treated as a deletion, because browsers keep the later date. Cookies cleared the usual way (`Max-Age=0`, or a single past `Expires`) are unaffected.
- 8c73a24: chore(core): declare the `@aws-sdk` devDependencies its tests already use

  `packages/core`'s `client-user-agent.test.ts` dynamically imports
  `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` but never declared them,
  relying on the packages being hoisted to the root by `bb-kv-store`/
  `bb-distributed-table`. A dependency bump that reshuffles hoisting drops that
  incidental resolution and breaks `core`'s build. Declare both as
  devDependencies so the imports resolve regardless of hoisting.

- 48c35f6: An RPC error response no longer passes through a `Set-Cookie` whose `Max-Age` is malformed but could be read as a positive lifetime (such as `+999` or `999abc`), even when its `Expires` is in the past. Error responses carry only cookies that every browser deletes.
- 48c35f6: `Scope.registerLambdaEventHandler()` now throws, for every Building Block, when a handler is already registered for the same event source and identifier, instead of silently replacing the first one. This only fires on a misconfiguration: two blocks in your app consuming the same queue, schedule, WebSocket API or user pool trigger, or a block constructed per request (inside a handler) instead of once at module level. A correctly configured app is unaffected; a misconfigured one now gets an error naming the duplicate, where before one block quietly took over the other's events.
- 54e9443: fix(core): keep x-blocks-type-args when a method is typed from a resolved type

  A method typed from a resolved `ts.Type` rather than the backend entry's AST lost its
  `x-blocks-type-args`, because `detectTransferable` was called without the syntactic
  return-type node that gates type-argument emission. An arity-1 transferable reached that
  way failed spec generation with `found 0` type args.

  The node is now read from the method's own declaration, covering an interface or class
  method and a function-typed or handler-literal property. Entries are emitted only where
  the customer wrote every type argument: a partial list would pass the arity check with
  the wrong types in it.

- 48c35f6: fix(core): only forward real cookie deletions on an API error response

  When an API method throws, only `Set-Cookie` headers that delete a cookie are sent with the error, so a method can clear a session cookie but never issue one. The deletion check used `Date.parse` on `Expires`, so values like `Expires=0` or `Expires=1` counted as deletions. Browsers ignore those values and keep the cookie, so a live cookie could reach the client on an error. The check is now strict. A cookie counts as deleted only with an integer `Max-Age` of `0` or less, or an `Expires` that is an IMF-fixdate (`Thu, 01 Jan 1970 00:00:00 GMT`) at or before now. Any other value is not a deletion and is dropped from the error response.

- d366907: chore: manual dependency bump (2026-10-19)
- 48c35f6: `deploy()` in production mode no longer hangs after the deploy finishes. It used to load your backend's local development (mock) versions of the Building Blocks while generating the client, which started local runtimes (the local `Database` engine, `CronJob` schedules) that kept `npm run deploy` running, and kept logging `[CronJob:…] triggered at …`, after "✅ Deployment complete!". Deploy no longer loads local mocks. As a side effect, it no longer applies migrations to, or writes data into, your local `.bb-data/` database.
- d062eeb: Before they deploy, `npm run deploy` and `npm run sandbox` now print the deployment target: the credentials that CDK deploys with (an AWS profile, access keys from the environment, or container or web identity credentials) and the configured Region. As in CDK, access keys from the environment (including the `AMAZON_` names that CDK also reads) are used before `AWS_PROFILE` unless `cdk.json` sets a profile; the credential check now verifies those keys rather than the profile. When the credential check succeeds, they also show the account name and the AWS account plan (Free or Paid, with its status), read with the same credentials that the check verified. These reads are optional and never stop a deploy. If they are denied, unsupported, empty, malformed or take longer than 2.5 seconds, the value shows as "not available". Account IDs, ARNs, error text and plan credits are not printed. `npm run destroy` and `npm run sandbox:destroy` print only the deployment target.

  When the credentials are the AWS-managed role from the new AWS sign-up experience (a role at the path `/managed/` that `account-access.amazonaws.com` can assume, read with `iam:GetRole`), the output also has a one-line link to `https://settings.aws.com/billing` for spend limits, with a reminder to check that the project selected there matches the deployment target. Other credentials, or a role that cannot be read in time, get no link. When a profile has no Region, the warning now explains how to use `aws login`: set the profile Region to your project's Region before you sign in, and sign in again after you change it.

  `@aws-blocks/core` now depends on `@aws-sdk/client-account`, `@aws-sdk/client-freetier` and `@aws-sdk/client-iam`. They load only when a deploy command runs.

- 48c35f6: `FileBucket` no longer fails `cdk synth` when its derived S3 bucket name is longer than 63 characters. A bucket's name comes from your stack name and scope ids, so a long stack name or deeply nested ids could push it over S3's limit. This also hit blocks that create a bucket internally, such as `Agent`. These names are now shortened to the start of the name plus `-` and an 8-character hash. The result is the same on every deploy, and different scope chains still get different names. Bucket names that already fit are unchanged, so no existing bucket is renamed or replaced. Names that break any other S3 naming rule still fail synth with `ValidationFailed`.
- 63b154f: feat(core): multi-compute routing — per-namespace RPC paths + shared-gateway fan-out

  Make the shared REST API gateway route each API namespace to the compute that hosts it, in two parts.

  **Per-namespace paths.** The typed RPC client now POSTs to `/aws-blocks/api/{namespace}` (the namespace in the path) instead of the shared `/aws-blocks/api` — a gateway routes by URL path, not the JSON-RPC body, so giving each namespace its own path is what lets one gateway fan out to multiple computes. `{namespace}` is the backend export name. The body still carries `namespace.method`, and that is what the runtime handler and the local dev server dispatch: a per-namespace path must be exactly `/aws-blocks/api/{namespace}` and name the same namespace, or the request is rejected with a JSON-RPC `-32600` Invalid Request rather than silently running either one. `POST /aws-blocks/api` keeps working unchanged, so raw HTTP callers that use it are unaffected.

  Migration note for `ApiNamespaceClientOptions.url`: pass the **base** URL (e.g. `/aws-blocks/api`, or `https://d123.cloudfront.net/aws-blocks/api`) — the client now appends `/{namespace}` itself. A pre-qualified URL that already includes the namespace routes to `{url}/{namespace}` and is not supported.

  Deploy order: a web client built with this release calls `/aws-blocks/api/{namespace}`, which needs the gateway resource this release adds. Deploy the backend before, or together with, clients built against it; a gateway deployed from an earlier release may reject the per-namespace path (403). If you run your own proxy or rewrite in front of the API (nginx, a framework rewrite, your own CloudFront behavior), make it forward the whole `/aws-blocks/api/*` subtree, not just the exact `/aws-blocks/api` path — `Hosting` already does.

  The native clients call the same per-namespace paths from `aws-blocks-swift` 0.2.0, `aws-blocks-kotlin` 0.3.0 and the next Dart `blocks_runtime` release. Native clients from earlier releases POST to the bare `/aws-blocks/api` URL, which keeps working and runs every call on the default compute.

  **Gateway fan-out.** The shared gateway now routes each namespace's path to the compute that hosts it. The default compute's function stays behind the catch-all resources, so the RPC root, auth, `RawRoute`s, and any namespace left on the default compute all reach it; a new `/aws-blocks/api/{proxy+}` resource carries the per-namespace RPC paths for those namespaces. Every non-default compute gets its own Lambda integration plus a literal `/aws-blocks/api/{namespace}` (`ANY`) resource for each namespace it hosts. A literal resource wins over the sibling `{proxy+}`, so requests fan out within a single gateway — and a single CloudFront origin under `apiFrontDoor: 'cloudfront'`. Routes key on each namespace's export name — what the client calls — read from the backend module after it is imported, and each namespace's compute is resolved then (the namespace's own `compute` option, else the compute of the scope it was built in). A non-default compute's function gets one API-scoped invoke permission however many namespaces it hosts. Synth fails with a clear error for a namespace on a compute that takes no API traffic, or for an export name API Gateway can't use as a path segment.

  For an app that gives no namespace its own compute (every app before the `ApiNamespace` `{ compute }` option), every namespace resolves to the default compute and the only synthesized change is the additive `/aws-blocks/api/{proxy+}` resource; existing gateway resources keep their logical IDs. The `createSharedGateway` signature (it now takes the per-compute namespace routes + default compute) is `@internal`, and so is the `ComputeBase.namespaces` list this replaces.

- 8565ef7: fix(core): name the customer's `Compute` in shared-gateway synth errors

  The synth errors for a compute that can't serve API namespaces, and for an
  export name API Gateway can't route, named the compute by its construct id —
  for a `Compute` block that is its internal `backing` child. They now give the
  compute's full construct path (for example `MyStack/app/reports/backing`), which
  includes the id you passed to `new Compute(...)`.

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

- f8bfab1: fix(hosting): pages that render on demand inside a Nuxt/Nitro ISR folder no longer 404

  With an ISR or SWR route rule that names a folder in `public/` (for example `routeRules: { '/blog/**': { isr: 60 }, '/blog/featured': { prerender: true } }`), the Nitro adapter used to emit a blanket static `/blog/*` route for the folder. Every front door takes the first match, so `/blog/any-other-post` went to the static asset origin and returned 404, including when the prerendered page sat one folder deeper (`/blog/2024/featured`).

  The folder no longer gets a blanket static route. Instead:

  - Its real files keep their own static routes: each file directly in the folder (`/blog/hero.png`), and one route per sub-folder that holds no pages (`/blog/img/*`). They're still served from S3.
  - A page frozen by an explicit `prerender: true` rule keeps its own routes and is still served frozen from S3.
  - Every other path under the folder goes to the server and renders on demand.

  `RouteBehavior` has a new optional `exact` field. A route marked `exact` keeps its own row in the front door's route table: it isn't merged with its siblings into a `<parent>/*` wildcard, and it isn't switched to the server when ISR/SWR is active. The Nitro adapter sets it for the routes above. A site-wide rule (`'/**'`) and apps without ISR/SWR rules are unchanged.

- 3ae22e6: fix(hosting): build Next.js apps with a verified OpenNext version, and explain Edge-route and version mismatches

  - **`@opennextjs/aws` not installed.** Hosting declares OpenNext as an optional peer dependency, so nothing installs it for the app, and a bare `npx @opennextjs/aws build` downloaded the newest release, which is often outside the version range the Next.js adapter is verified against. When the project doesn't declare it, the adapter now builds with `@opennextjs/aws@4.0.3` and prints the command to declare it (`npm install --save-dev @opennextjs/aws@~4.0.3`). If that build fails, it throws `OpenNextNotFoundError` with the same command. Before this change that error could never be raised.
  - **Next.js outside OpenNext's `next` peer range.** When the app's `next` version is outside the range the building OpenNext declares (for example `next@15.5.7` with `@opennextjs/aws@4.0.3`, which requires `>=15.5.18 <16 || >=16.2.6`), the adapter now prints a warning naming both versions and the range. Package managers that skip peer checks would otherwise build an untested pair without a word.
  - **Edge routes on a stack without a region.** A Next.js route with `runtime = 'edge'` is built as Lambda@Edge, which needs the stack's region at synth time. On a stack with no explicit `env.region`, synth failed with CDK's `stacks which use EdgeFunctions must have an explicitly set region`. Hosting now throws `EdgeComputeRequiresRegionError`, which names the route's compute and shows the `env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }` fix.
  - **Package versions in workspaces and monorepos.** The Next.js, Astro, Nuxt and SvelteKit adapters now read `next`, `@opennextjs/aws`, `astro`, `@astrojs/node`, `nitropack`, `@nuxt/image`, `@sveltejs/kit` and `@sveltejs/adapter-node` from the app's own directory. They previously started at its parent, so an app that pins a different version than the one hoisted to the workspace root got the root's version. For example, a Next.js 15 app under a root `next@16` had the Next.js 16 image-optimizer patch applied and missed the peer-range warning.
  - **Local images on Next.js 15.5.16+ and 16.2.0–16.2.4.** The adapter patches OpenNext's call to Next.js's `fetchInternalImage` when Next.js takes an extra `maximumResponseBody` argument. It decided by major version (patch on 16, skip on 15), but that argument arrived in patch releases: it is in 15.5.16 and later, and in 16.2.5 and later, but not in 16.0.x, 16.1.x or 16.2.0–16.2.4. So `/_next/image` returned 500 (`TypeError: … is not a function`) for local images on Next.js 15.5.16+ and on 16.2.3–16.2.4. The adapter now reads the signature from the installed `next` (falling back to those version boundaries).
  - The `@opennextjs/aws` peer dependency range is now bounded: `>=3.10.0 <5.0.0`.
  - `@aws-blocks/create-blocks-app`: the `nextjs` template declares `@opennextjs/aws` (`~4.0.3`) as a devDependency, so new Next.js apps build with a pinned, verified OpenNext.

- 48c35f6: Scripts that use a local `Database` or `DistributedDatabase` now exit when they finish. Before, a short-lived script that imported your backend under local development (a seed script, a one-off CLI step, a test) kept running forever after its last query, because the local database engine held the process open. The local engine also now shuts down cleanly when the process exits, so the next start no longer logs `Removed stale postmaster.pid`. Your local data in `.bb-data/` persists as before, and `npm run dev` is unaffected: the dev server keeps running and serving queries until you stop it.
- d366907: fix: closing a local Database or DistributedData engine no longer hangs with PGlite 0.5.10

  PGlite 0.5.10's `close()` never resolves while the instance is still initializing. An engine destroyed before its
  first query, for example in a test teardown or a process shutting down early, would hang forever. `destroy()` now waits
  for PGlite's initialization to settle (or fail) before closing.

- 48c35f6: fix(core): let API errors clear cookies, and deliver cookies on HTTP API / Function URL events

  - **An API method that throws can now clear cookies in the same response**,
    both locally and on AWS. Before, an error response dropped every
    `Set-Cookie` the method had set, so a method could not, for example, reject
    with a 401 _and_ clear a stale session cookie in one call. Now cookies that
    are being deleted (`Max-Age` of 0 or less, or an `Expires` in the past) are
    delivered with the error. Any other cookie set before the throw is still
    dropped, so a method that signs a user in and then rejects them (for example
    a post-sign-in access check that throws a 403) never hands out a live
    session. The error itself is unchanged, the method's other response headers
    are still not sent with an error, and errors without cookies are returned
    exactly as before. Successful responses and `RawRoute`s are unaffected.
  - **Multiple cookies now work when the Lambda handler is invoked with the
    API Gateway HTTP API / Function URL event format (payload version 2.0).**
    `Set-Cookie` values are returned in that format's `cookies` list, for both
    API methods and `RawRoute`s. The default deployment (API Gateway REST API)
    is unaffected.

- 48c35f6: fix(core): cookies set by an API method are no longer dropped on AWS when more than one is set

  When an `ApiNamespace` method set more than one cookie in a single response
  (for example `context.response.headers.set('set-cookie', …)` followed by
  `append('set-cookie', …)`), only one of them reached the browser on AWS — the
  others were silently lost. Local development was unaffected, so the problem
  only appeared after deploying. Every `Set-Cookie` value is now delivered,
  matching how `RawRoute` responses already behaved. This also fixes `Auth`
  responses that set both the session cookie and the auto-sign-in cookie.

- 72e3259: fix(core): stop `npm run sandbox` printing a DEP0190 deprecation warning on Node 24

  The sandbox started the local dev server by splitting its command on spaces and passing the pieces as separate args together with `shell: true`. Node 24 warns about that combination (DEP0190, args are concatenated rather than escaped). The command now goes to the shell as a single string, so the warning is gone and the dev server starts exactly as before.

- b16e5b6: feat(create-blocks-app): add a one-shot `npm run sandbox:deploy` script to every deployable template

  `npm run sandbox` deploys and then keeps running (CDK watch plus the local dev server), so it never exits and can't be used from scripts or CI. The new `npm run sandbox:deploy` runs the same sandbox script with `--deploy-only`: it deploys once, writes `.blocks-sandbox/config.json`, prints the `BLOCKS_DEPLOYED api=…` line, generates the typed client, and exits. Wait for exit code 0 rather than for the line, since the client is generated after it. `npm run sandbox` is unchanged. The template READMEs and the scaffolded `AGENTS.md` list the new script.

  Existing apps can adopt it by adding `deployOnly: process.argv.includes('--deploy-only')` to the `startSandbox({ ... })` call in `aws-blocks/scripts/sandbox.ts`, and a `"sandbox:deploy": "tsx aws-blocks/scripts/sandbox.ts --deploy-only"` script to `package.json`.

- 48c35f6: `npm run sandbox` telemetry now reports which Building Blocks your app uses (when telemetry is enabled); before, it always reported none. The sandbox now generates the deployed client before deploying, as `npm run deploy` does, so `aws-blocks/client.js` is ready before the deploy starts and an error in the backend surfaces before the deploy rather than after it. The deploy itself is unchanged.
- 0d4ede3: refactor(core, bb-kv-store, bb-distributed-table): share one DynamoDB PITR + encryption resolver

  No synth output change: the same CloudFormation template and the same synth warnings are produced.

  The point-in-time-recovery and encryption resolution — the `retentionDays` 1–35 validation, the `aws-managed`/`customer-managed`/`fromKmsKey` encryption selection, and the auto-created-CMK removal-policy alignment — was duplicated almost line-for-line between the two Blocks-provisioned DynamoDB tables (`bb-kv-store`, `bb-distributed-table`). Both blocks now resolve that behaviour through one shared internal helper in `@aws-blocks/core`. Durability (`removalPolicy`/`deletionProtection`) stays in each block, since the two surface it through different options.

- 63b154f: Document the shared API gateway. The `@aws-blocks/core` README gains a "Shared API gateway" section covering how every path reaches the backend, per-namespace paths, default throttling, opt-in access logs, the 29-second / 10 MB limits, and attaching WAF to the gateway stage or to Hosting's CloudFront distribution. The `bb-lambda-compute` design notes now describe the multi-compute routing: catch-all resources go to the default compute, and per-namespace resources go to the others.
- b6b8ade: fix(core): find the `ApiNamespace` handler by position when generating the native-client spec

  The OpenRPC spec generator took the **last** `new ApiNamespace(...)` argument as
  the handler. Given an argument after the handler (an options object), it read
  that instead: the namespace's methods came out with `unknown` types in the
  Swift, Kotlin and Dart bindings, and methods tagged `@blocksSkipCodegen` leaked
  into the spec. It now uses the handler argument itself, whatever follows it.

- 48c35f6: Vendorized apps using `DistributedTable` with an index, `Database` with migrations, or `DistributedDatabase` now synthesize. A vendorized copy (`npm run vendorize -- <Block>`) contains only the TypeScript sources, so these blocks' deploy-time Lambdas (the GSI manager and the migration runner) previously failed synth with `Cannot find asset` or `Cannot find entry file`. Their handlers are now bundled from the vendorized source at synth, so your edits to them deploy too. Installed (non-vendorized) apps are unchanged: their Lambda assets are byte-for-byte the same.

  The helpers that do this, `deployTimeLambdaCode()` and `deployTimeLambdaEntry()`, are framework-internal (`@aws-blocks/core/cdk/internal`), for Building Blocks in this repository that ship a pre-bundled or compiled Lambda handler; they are not on the public `@aws-blocks/core/cdk` or `@aws-blocks/blocks/cdk` entry.

- Updated dependencies [5dc1d98]
- Updated dependencies [48c35f6]
- Updated dependencies [d1d129f]
- Updated dependencies [0765f84]
- Updated dependencies [5572341]
- Updated dependencies [43603b0]
- Updated dependencies [88747f5]
- Updated dependencies [1076ccc]
- Updated dependencies [763f67e]
- Updated dependencies [aaa90b6]
- Updated dependencies [72c8165]
- Updated dependencies [33edca2]
- Updated dependencies [928c48a]
- Updated dependencies [4d5ea86]
- Updated dependencies [90c1b12]
- Updated dependencies [1d58d60]
- Updated dependencies [dbe7df6]
- Updated dependencies [c3a3b44]
- Updated dependencies [72b5fe0]
- Updated dependencies [7114399]
- Updated dependencies [92909f8]
- Updated dependencies [ee69cd7]
- Updated dependencies [8cff0bb]
- Updated dependencies [943d405]
- Updated dependencies [23fc09f]
- Updated dependencies [50b8c94]
- Updated dependencies [a3969b5]
- Updated dependencies [a3969b5]
- Updated dependencies [943d405]
- Updated dependencies [943d405]
- Updated dependencies [943d405]
- Updated dependencies [943d405]
- Updated dependencies [943d405]
- Updated dependencies [943d405]
- Updated dependencies [943d405]
- Updated dependencies [943d405]
- Updated dependencies [943d405]
- Updated dependencies [a3969b5]
- Updated dependencies [a3969b5]
- Updated dependencies [48c35f6]
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
- Updated dependencies [492d744]
- Updated dependencies [414df36]
- Updated dependencies [d1b4900]
- Updated dependencies [d366907]
- Updated dependencies [91ed1fc]
- Updated dependencies [48c35f6]
- Updated dependencies [d062eeb]
- Updated dependencies [c22eeee]
- Updated dependencies [1546160]
- Updated dependencies [a3969b5]
- Updated dependencies [e68e653]
- Updated dependencies [9aa8ae2]
- Updated dependencies [92c4b20]
- Updated dependencies [27c35e5]
- Updated dependencies [1d8ed6c]
- Updated dependencies [2f59ce5]
- Updated dependencies [3142985]
- Updated dependencies [9c96135]
- Updated dependencies [0ee86e1]
- Updated dependencies [48c35f6]
- Updated dependencies [ea57feb]
- Updated dependencies [63b154f]
- Updated dependencies [8565ef7]
- Updated dependencies [ce5dfa9]
- Updated dependencies [2c73654]
- Updated dependencies [515089c]
- Updated dependencies [a02549a]
- Updated dependencies [dde6340]
- Updated dependencies [f8bfab1]
- Updated dependencies [7477b6e]
- Updated dependencies [3ae22e6]
- Updated dependencies [c8c26f7]
- Updated dependencies [d79a0bd]
- Updated dependencies [d79a0bd]
- Updated dependencies [6a53068]
- Updated dependencies [3803f19]
- Updated dependencies [3b5a419]
- Updated dependencies [dd5e807]
- Updated dependencies [48c35f6]
- Updated dependencies [14ee6f1]
- Updated dependencies [d366907]
- Updated dependencies [db15b5e]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [72e3259]
- Updated dependencies [d79a0bd]
- Updated dependencies [48c35f6]
- Updated dependencies [8565ef7]
- Updated dependencies [3d83cb6]
- Updated dependencies [48c35f6]
- Updated dependencies [0d4ede3]
- Updated dependencies [63b154f]
- Updated dependencies [c0f6a83]
- Updated dependencies [b6b8ade]
- Updated dependencies [82ea78a]
- Updated dependencies [e44ac0c]
- Updated dependencies [33e8d73]
- Updated dependencies [b003705]
- Updated dependencies [f704a68]
- Updated dependencies [48c35f6]
  - @aws-blocks/bb-agent@0.7.0
  - @aws-blocks/bb-knowledge-base@0.3.0
  - @aws-blocks/core@0.8.0
  - @aws-blocks/bb-compute@0.2.0
  - @aws-blocks/bb-app-setting@0.4.0
  - @aws-blocks/bb-async-job@0.3.0
  - @aws-blocks/bb-auth-cognito@0.2.0
  - @aws-blocks/bb-auth-oidc@0.3.0
  - @aws-blocks/bb-container-compute@0.2.0
  - @aws-blocks/bb-cron-job@0.4.0
  - @aws-blocks/bb-dashboard@0.3.0
  - @aws-blocks/bb-data@0.5.0
  - @aws-blocks/bb-distributed-data@0.3.0
  - @aws-blocks/bb-distributed-table@0.3.0
  - @aws-blocks/bb-email-client@0.2.0
  - @aws-blocks/bb-file-bucket@0.4.0
  - @aws-blocks/bb-kv-store@0.4.0
  - @aws-blocks/bb-lambda-compute@0.7.0
  - @aws-blocks/bb-logger@0.3.0
  - @aws-blocks/bb-metrics@0.2.0
  - @aws-blocks/bb-realtime@0.5.0
  - @aws-blocks/bb-secret@0.3.0
  - @aws-blocks/bb-tracer@0.3.0
  - @aws-blocks/hosting@0.5.0
  - @aws-blocks/bb-auth-basic@0.2.0
  - @aws-blocks/auth-common@0.3.0

## 0.8.0

### Minor Changes

- ec7eebe: feat(bb-secret): add the `Secret` Building Block — a single application secret backed by AWS Secrets Manager

  Introduces `@aws-blocks/bb-secret`, re-exported from `@aws-blocks/blocks` as `Secret` (and `SecretErrors`, `SecretOptions`). Each instance is one high-value credential — a third-party API key, OAuth client secret, database connection string, webhook signing key, or encryption key — stored in AWS Secrets Manager (distinct from `AppSetting`, which is backed by SSM Parameter Store).

  - `get(options?): Promise<T | null>` — reads the value, returning `null` when unset or missing (no throw for not-found). `options.version` reads `'current'` (default), `'previous'` (the value before the last change — a rotation grace window), or a specific `SecretVersion` from `listVersions()`.
  - `put(value): Promise<void>` — sets or updates the value at runtime; the prior value becomes the `'previous'` version.
  - `listVersions(): Promise<SecretVersionInfo[]>` — lists retained versions (metadata only, newest first — never values); a returned item passes straight to `get({ version })`.
  - `Secret.fromExisting(arn)` — reference a secret owned outside the stack (no create/seed/delete/tag; read/write + grant only). The sanctioned path for centrally-managed secrets shared across many installations.
  - `name?` — an explicit, well-known Secrets Manager secret name so a team or CI/CD pipeline can set/rotate the value out-of-band via the `aws` CLI; defaults to a name derived from the scope tree.
  - `generate?` — when `true`, seed a random value on first create (signing/HMAC keys that only need to exist); the mock seeds an equivalent value so local and deployed behavior match. **A BB-created secret is otherwise empty by default** — `get()` returns `null` until a value is set, matching the mock and the configure-after-deploy model. (Don't combine `generate` with `schema`: a random string isn't valid JSON.)
  - Optional `schema` (any StandardSchemaV1 — Zod/Valibot/ArkType) for typed JSON secrets with validation on `get`/`put`.
  - `cacheTtlSeconds?` — the runtime caches each fetched value in-process so steady-state reads skip the API; a cached value is held for this long before the next `get()` re-fetches. **Defaults to 300s (5 minutes)**, matching the AWS Secrets Manager agent, so even a long-running process can't serve a rotated value indefinitely; `0` disables caching, and `put()` always clears the cache. Ignored by the mock.
  - `removalPolicy` per-instance override; otherwise follows the stack-wide defaults (production retains, sandbox destroys).

  **Versions & rotation.** `get({ version })` + `listVersions()` expose the current/previous values and the labeled version list, so a key rollout can validate against the previous value during a grace window. `listVersions()` returns the labeled versions (current + previous); anything beyond that is left to the AWS SDK against the secret ARN (exposed on the CDK construct as `secret.secretArn`; the runtime/mock classes deliberately don't expose AWS primitives). The read surface is an options object with a `SecretVersion` / `SecretVersionInfo` (base/subtype) handle contract, so deeper access can be added non-breaking. Automatic rotation is intentionally out of scope — it is credential-type-specific (AWS ships hosted rotators only for database engines); rotate via `put()`/console/CLI, or drive `put()` from a `CronJob` for a custom schedule.

  **Management & lifecycle.** A declaration carries only the name, never the value. Values are set out-of-band via three complementary approaches: auto-generated (random, via `generate: true`, for opaque values); the built-in `/aws-blocks/settings` route (redirects to the settings resource group in the console when deployed, opens `.bb-data/settings.json` locally); or a well-known `name` + the `aws secretsmanager` CLI for CI/CD. There is intentionally no constructor-time value seeding (no source literals, no env-seeding) — consistent with how hosting `secret()` separates declare from set.

  **Resource group + local settings route (`@aws-blocks/core`).** BB-created secrets are tagged `aws-blocks-stack=<stackName>` and the stack's `-settings` resource group now matches `AWS::SecretsManager::Secret` alongside `AWS::SSM::Parameter`, so secrets appear next to `AppSetting` parameters in the console. The local mock persists to the shared `.bb-data/settings.json` (the same file `AppSetting` uses), and the `/aws-blocks/settings` route copy now covers both AppSetting and Secret values — one route for settings and secrets, local and deployed.

  The CDK layer provisions one `secretsmanager.Secret`, grants the shared execution role scoped `GetSecretValue` + `PutSecretValue`, requests the Secrets Manager interface VPC endpoint, and passes the ARN to the runtime via `registerConfig` (`BLOCKS_SECRET_ARN_<ID>`). Runtime methods are `synthGuard`-stubbed on the construct. The browser entry throws `NotSupported`. Covered by unit tests (mock + CDK synth) and the shared `test-apps/comprehensive` e2e suite (local/sandbox/production).

- 8f725b6: fix(bb-data): enable Aurora storage encryption, backup retention, and log export

  Hardens the Aurora Serverless v2 cluster synthesized by `Database`:

  - **Storage encryption at rest** is opt-in via the
    `@aws-blocks/bb-data:encryptStorageByDefault` context flag — set in the new
    `create-blocks-app` cdk.json templates, so new projects encrypt by default with
    the AWS-managed `aws/rds` key. A new optional `storageEncryptionKeyArn` (the ARN
    of a customer-managed KMS key) turns encryption on regardless of the flag and
    also encrypts the auto-generated credentials secret. When neither is set, the
    `StorageEncrypted` property is left unset (so an existing cluster is untouched)
    and a synth warning explains how to opt in.
  - **Automated backups** are on by default and retained **15 days**; this is also
    the point-in-time-recovery window. A single `pointInTimeRecovery` option
    controls it (mirroring every other Blocks block): `true` enables the 15-day
    window, `{ retentionDays: n }` pins a 1–35-day window, and `false` clamps to the
    1-day minimum (Aurora cannot disable automated backups). When omitted it follows
    the stack-wide `defaults.pointInTimeRecovery` (on under `production`, off under
    `sandbox`).
  - **CloudWatch log export** — the PostgreSQL engine log is exported to CloudWatch
    Logs, with retention following the stack-wide `defaults.logRetention`.
  - `iamAuthentication` remains intentionally off (access is exclusively via the RDS
    Data API), and automatic secret rotation is documented as a follow-up.

  `@aws-blocks/create-blocks-app` scaffolds this default into new projects: every
  template's `cdk.json` now sets the `@aws-blocks/bb-data:encryptStorageByDefault`
  context flag, and the Amplify overlay sets the same flag via `setContext`. As a
  result, a `Database` created in a newly scaffolded project encrypts its storage at
  rest by default.

  **Breaking for existing stacks (0.x minor = breaking channel):** the
  backup-retention and CloudWatch log-export changes alter synthesized cluster
  properties, so existing stacks will show a CloudFormation diff.

  Storage encryption is **opt-in** specifically so it does **not** silently replace
  existing clusters: with neither the context flag nor a `storageEncryptionKeyArn`
  set, the `StorageEncrypted` property is left unset and the existing cluster is
  untouched. Opting in (setting the flag, or supplying a key) on an
  already-provisioned, unencrypted cluster requires a **replacement**, and the
  replacement is destructive: RDS cannot encrypt an existing cluster in place, so
  CloudFormation creates a **new, empty** encrypted cluster and repoints the stack.
  There is no in-place path. The migration CustomResource does **not** re-run on a
  cluster swap — its only CloudFormation properties are the service token and the
  migrations hash, neither of which changes when the cluster is replaced — so the new
  cluster comes up with **no schema**; migrations run only when a migration file
  changes (which changes the migrations hash). Under production (RETAIN) the old
  cluster is orphaned/unreferenced; under sandbox (DESTROY) it and its data are
  deleted; under `removalPolicy: 'snapshot'` it is snapshotted as it is replaced
  (though under production's `deletionProtection: true` the follow-up delete may fail
  and leave it in place, unverified on a real deploy). The only safe route is to
  snapshot the existing cluster, restore it with encryption enabled, then cut over.
  Review the diff and snapshot before deploying. The replacement is symmetric:
  turning encryption back off — removing the flag (or `storageEncryptionKeyArn`) from
  a project that already deployed encrypted, e.g. deleting the cdk.json line or a
  merge dropping it — also changes `StorageEncrypted` and so likewise replaces the
  cluster (back to unencrypted), with the same new-empty-cluster / no-schema outcome.

- 4ae500e: feat(create-blocks-app): add a dev:stop command for the local dev server

  Adds a first-class, sanctioned way to stop the local dev server, so there is an
  alternative to `pkill -f tsx` / `killall node` — which match by process name and
  can kill the caller's own shell/agent process.

  - `@aws-blocks/core/scripts` (re-exported by `@aws-blocks/blocks/scripts`) gains
    `stopDevServer`, the CLI entry `runStopCli`, `stopMessage`, and the
    `StopResult` type. Stop acts ONLY on the supervisor identity the dev server
    recorded in its own pidfile (`{pid, ppid, port}`): it SIGTERMs the recorded
    `tsx watch` watcher — the only thing that actually ends `npm run dev` — and
    falls back to the recorded child's listener tree only when the watcher is
    gone. It never scans a port and signals an arbitrary listener, so a stale
    pidfile or an unrelated same-port process is never touched, and the pidfile is
    removed only once the port is confirmed free. Idempotent; never throws;
    `runStopCli` exits non-zero when the stop leaves the port bound.

  - `@aws-blocks/create-blocks-app`: every standalone template gains a `dev:stop`
    npm script and a thin `stop.ts` wrapper; the existing-project and Amplify
    integration paths get `dev:stop` / `blocks:stop` too. The scaffolded
    `AGENTS.md` and the singleton-guard message point at `npm run dev:stop`
    instead of `pkill` / the blunt cleanup script.

- 6d764f7: `AWS_BLOCKS_DISABLE_TELEMETRY` now accepts `true` and `yes` in addition to `1` (case-insensitive, trimmed).

  Previously only the exact value `1` disabled telemetry, so `AWS_BLOCKS_DISABLE_TELEMETRY=true` kept telemetry on. Both packages now accept `1`, `true` and `yes`; `0`, `false`, empty and unset keep telemetry enabled. The `blocks-telemetry --help` output lists the accepted values, and the D-010 usage note in `docs/DECISIONS.md` is updated to match.

  Behavior change (0.x minor = breaking channel): if you already export `AWS_BLOCKS_DISABLE_TELEMETRY=true` or `=yes` for another tool, Blocks telemetry is now disabled where it was previously still on.

- 94a914a: A native package's Dart `name` and `library` are now validated against the
  grammar the Dart generator interpolates them into, and a binding's `export`
  against the one every generator upper-camel-cases, instead of both only being
  checked for a non-blank string. A Dart `name` of `blocks_runtime` is rejected
  because every generated client already imports that library. A value such as
  `My-Package`, `lib/x.dart` or `device link` used to pass spec generation and then
  break codegen in the customer's app, where the block that declared it is no
  longer visible. Swift and Android fields are unaffected.

  `@aws-blocks/blocks` gets the same bump because it re-exports `@aws-blocks/core/scripts`.

- cb0ec01: `blocks.spec.json` can now carry two top-level OpenRPC extensions,
  `x-blocks-native-packages` and `x-blocks-native-bindings`, so native codegen can
  resolve a transferable tag to a package export instead of a hard-coded switch.
  `generateSpec` and `writeSpec` take a new trailing `SpecGenerationOptions`
  carrying the declarations, and invalid metadata throws `NativeCatalogError`
  before any file is written. Nothing populates the declarations yet, so a
  generated spec is unchanged.

  `@aws-blocks/blocks` gets the same bump because it re-exports `@aws-blocks/core/scripts`.

- 005c095: feat(core): read native package and binding declarations from each block's package.json

  A Building Block declares its native packages and transferable bindings under an
  `aws-blocks.native` key in its own `package.json`. `blocks-generate-spec` reads
  that key from every `node_modules` level from the spec project upward and emits the
  `x-blocks-native-packages` and `x-blocks-native-bindings` catalogs, which until
  now nothing populated. Each import specifier resolves to its nearest installed copy,
  as in Node's own resolution. The new `readNativeDeclarations` export supplies the
  same declarations to a project that calls `writeSpec` directly instead of through
  the bin.

  A spec generated for an app where no block declares the key is byte-identical to
  before.

  `blocks-generate-spec` names the packages whose declarations it read, so an author
  can see that an installed dependency contributed a native binding. The line is
  omitted when nothing declares any.

  Generation now exits non-zero without writing a file when an installed block's
  declarations are invalid, or when an installed `package.json` cannot be parsed
  while it carries the `aws-blocks` key — such a manifest cannot be ruled out as a
  declarer, so it is not treated as declaring nothing. A `node_modules` directory
  or a manifest that cannot be read for a reason other than absence, and an
  unparseable manifest that does not carry `aws-blocks` as a JSON key, are warned
  and skipped. A byte-order mark is accepted, as npm accepts one. A `packages` or
  `bindings` set to `null` is now reported rather than read as absent.

  A native declaration error raised before any block could be named now reports
  the position the pass had reached.

  `NativeDeclarationInput` is the same shape with `packages` and `bindings` typed
  `unknown`, which is what a `package.json` yields before anything checks it.
  `SpecGenerationOptions.nativeDeclarations` accepts it, and a typed
  `NativeDeclarationSource` built in code still assigns and stays readable. Code
  that reads `SpecGenerationOptions.nativeDeclarations` back narrows it to the
  exported `NativeDeclarationSource`.

  `@aws-blocks/blocks` gets the same bump because it re-exports `@aws-blocks/core/scripts`.

- 66f4be2: BREAKING: remove `BlocksStack.handler`, `BlocksBackend.handler`, and `Scope.handler`.

  These returned the default compute's Lambda function, so anything wired through them reached only that one function — not every compute an app runs on. Use the stack-wide equivalents instead, which reach every compute:

  | Before                                              | After                                                                                                                                         |
  | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
  | `blocksStack.handler.addEnvironment('KEY', value)`  | `registerConfig(blocksStack, 'KEY', value)` — loaded into `process.env` on every compute at cold start, before the backend module is imported |
  | `resource.grantRead(blocksStack.handler)`           | `resource.grantRead(blocksStack.executionRole)`                                                                                               |
  | `blocksStack.handler.addToRolePolicy(statement)`    | `blocksStack.executionRole.addToPrincipalPolicy(statement)`                                                                                   |
  | `this.handler` inside a custom Building Block       | `this.executionRole` / `registerConfig(this, …)`                                                                                              |
  | `handler.addEnvironment('CORS_ALLOWED_ORIGINS', …)` | `defaults: { ...BlocksPresets.production, allowedOrigins: [...] }`                                                                            |

  `registerConfig` and `executionRole` are exported from `@aws-blocks/blocks/cdk` (and `@aws-blocks/core/cdk`).

  **Precedence differs from `addEnvironment`.** `addEnvironment` wrote a real Lambda environment variable, so the last call won. `registerConfig` entries are loaded at cold start only into keys that aren't already set, so a real environment variable of the same name always wins — for example one the framework sets itself (`NODE_ENV`, `BLOCKS_STACK_NAME`) or one set on the function outside CDK. When that happens with a different value, the compute now logs a warning at cold start naming the ignored keys (names only, never values).

  `registerConfig` can be called from app code after `BlocksStack.create()` / `BlocksBackend.create()` resolves. This already worked for every stack, because the framework always registers config of its own; finalize now creates the config deployment unconditionally, so it no longer depends on that.

- 122c49c: fix(telemetry): honor opt-out when `--telemetry-file` is set

  The flag let an opted-out run build an event, which persisted the installation ID to `~/.blocks/telemetry/installation-id` and printed the first-run notice, and in `@aws-blocks/core` also persisted a project ID into `<project>/.blocks/config.json`. Consent is now checked before the event is built, and in `@aws-blocks/create-blocks-app` again before it is emitted, so an opt-out landing mid-command is honored too. A disabled run writes no identifiers, prints no notice, writes no file and sends no HTTP. `--telemetry-file` now also ignores a whitespace-only path in the space-separated form, matching the `=` form.

  Behavior change (0.x minor = breaking channel): to capture events without sending them, use `BLOCKS_TELEMETRY_ENDPOINT=http://127.0.0.1:1 <cmd> --telemetry-file=<path>` rather than combining the flag with `AWS_BLOCKS_DISABLE_TELEMETRY`. The detached send worker still runs and fails fast against port 1. That run is consented, so it still writes the installation ID and prints the notice.

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

- f8fbc6e: fix(bb-agent): capture the concrete S3 error shape when a deployed Agent's session snapshot cannot be read

  A brand-new conversation has no session snapshot; `S3Storage` already returns
  `NoSuchKey`/`NoSuchBucket` as `null` (and a missing manifest as empty), which
  Strands' `SessionManager` treats as "start fresh", so a genuine first turn is
  not affected. When a snapshot read fails for some OTHER reason — `AccessDenied`,
  a 5xx, a corrupt object — the error now carries actionable diagnostics: the
  deepest cause's `name`, `httpStatusCode` and `requestId` are flattened out of
  the non-enumerable `.cause` (which `bb-logger` otherwise never serializes) and
  logged at `error` level by `runAgent`, so the concrete production error shape is
  recorded for the first time instead of only the opaque `S3 error reading <key>`
  message.

  The read paths deliberately still RETHROW a non-missing fault rather than
  starting fresh: `SessionManager` overwrites `snapshot_latest.json` after a fresh
  start, so swallowing a transient read fault would silently overwrite an
  established conversation's saved history with a blank one. Surfacing the error
  (and now capturing its shape) is the correct behaviour. No public API change —
  `createDeployedSnapshotStorage` is internal and gains a `log: ChildLogger`
  parameter `(bucket, log, S3StorageImpl?)` so the logger is threaded to the
  storage seam.

- 59c9dde: docs(bb-auth-basic): add the frontend login-UI mount + gate seam

  The Quick Start documented the backend (`createApi()`, `requireAuth`) but not
  the frontend half, so builders and agents provisioned `AuthBasic` and assumed a
  login UI would appear — nothing rendered, leaving every authenticated route
  unreachable. The README now shows the end-to-end seam: import
  `Authenticator` / `AuthenticatedContent` from `@aws-blocks/blocks/ui`, mount the
  login UI in the SPA entrypoint, and gate the app shell behind an authenticated
  session, with a pointer to the already-shipped testid contract
  (`authenticator-<field>` / `authenticator-action-<action>`) in
  `auth-common/CUSTOMIZING-AUTH-UI.md`.

  Documentation only — no runtime or API change.

- e682ba7: `LambdaCompute` now reports `bbName`/`bbVersion` to `Scope`, so it appears in telemetry like every other Building Block.

  `LambdaCompute` passed no `bbName` to `Scope`, and `Scope` records a block in its registry only when `bbName` is set, so `Scope.getRegisteredBlocks()` could never name the default compute and `product.buildingBlocks` omitted it. The package already carried the standard `prebuild` (`generate-version.mjs LambdaCompute`), which generates the `BB_NAME`/`BB_VERSION` its constructor now passes through — the same wiring the other blocks use.

  `LambdaCompute` has no customer-facing export, so it is deliberately absent from the umbrella's `aws-blocks.vendorize` map that `scripts/generate-bb-names.mjs` reads. The generator now also emits a `NON_VENDORIZED_BB_NAMES` list, adding it to `OFFICIAL_BB_NAMES` so it is reported as an official block rather than filtered as an unnamed custom one. `@aws-blocks/core` is bumped because that generated file changes; the `cdk` entry point is left alone, as telemetry is reported by the runtime class, not the synth-time construct.

  The default compute is built only at CDK synth, in a child process whose registry no telemetry path reads, so nothing constructs one where telemetry is emitted. Importing `@aws-blocks/blocks` through its default (Node) entry now declares it instead: `Scope._setDefaultBlockForTelemetry` records its name and version, and `getRegisteredBlocks()` folds that in only when telemetry actually reads the registry.

  Declaring rather than constructing keeps the import inert — a process that imports the umbrella and emits no telemetry leaves `totalCount` untouched — and the entry is appended after the blocks the app constructed, so it never displaces them in `product.buildingBlocks`. An app-constructed `LambdaCompute` takes precedence over the declaration, so it is never counted twice. `getRegisteredBlocks()` still exposes only names already on the official list, and customer-chosen block names remain counted-but-unnamed.

- e9241b5: Add umbrella integration-test coverage asserting the shared REST API gateway wiring through the `LambdaCompute` surface. Test-only; no runtime or public API change.
- 3a7eb9e: fix: export runtime values missing from the `cdk` entry points

  Some values exported by a Building Block's default and `aws-runtime` entry points were missing from its `cdk` entry,
  so a backend file importing them crashed `cdk synth` at load time — for example, the `InterruptError` import shown in
  the `bb-agent` README failed with `does not provide an export named 'InterruptError'`. The `cdk` entries now also
  export:

  - `@aws-blocks/bb-agent`: `InterruptError`
  - `@aws-blocks/bb-async-job`: `BatchSubmitFailedError`
  - `@aws-blocks/bb-auth-cognito`: `SessionStore`; standalone session tables also enable DynamoDB TTL when a positive
    session lifetime is configured.
  - `@aws-blocks/bb-data`: `RLSEnabledDatabase`, `PgClientEngine`

  `@aws-blocks/blocks`: picks up the fixed `cdk` entries of the Building Blocks above. The conditional-export parity
  test now also checks every Building Block's `cdk` entry.

- 78f4396: CORS guidance now points at the stack's `defaults.allowedOrigins` everywhere, the stack-level setting every Blocks compute picks up. The runtime warning for a disallowed origin says to add it to `defaults.allowedOrigins` instead of setting the `CORS_ALLOWED_ORIGINS` environment variable; the core README's production example configures `defaults.allowedOrigins` instead of calling `handler.addEnvironment`, credits the sandbox preset (not the CLI) for the localhost pattern, and explains where allowed origins come from (`defaults.allowedOrigins` and, with `Hosting`, the distribution's own domain); the umbrella security checklist follows suit.
- 440ecce: When the AWS credential check before `npm run deploy` and `npm run sandbox` fails, the message now names the profile and the command that fixes its credentials. A profile without credentials gets sign-up and `aws login` guidance, with an AWS CLI install or update hint when the installed CLI does not have `aws login`. Expired `aws login` and IAM Identity Center (SSO) sessions get `aws login` or `aws sso login` for that profile. Rejected access keys, `credential_process`, web identity, a role assumed with environment keys, and environment credentials get guidance for that source. Rejected or expired credentials from outside the AWS config files, such as an instance role, get a hint to check that source instead of sign-up guidance. When AWS cannot be reached, including the SSO portal, the deploy still continues, and the warning now says that AWS could not be reached. The deploy docs and the generated app's `AGENTS.md` describe this behavior.

  `@aws-blocks/core` now requires AWS SDK for JavaScript clients 3.936.0 or later, the first version that reads credentials from `aws login` profiles.

- 92fa27b: Internal: route named-error minting through `@aws-blocks/core`'s `blocksError`. No behavior change.
- 023f02c: Internal: route the remaining per-package error mint sites through core's `blocksError`, and tighten the brand-coverage guard to per-site. No behavior change; two latent unbranded realtime timeout rejects are now wire-safe.
- 5d6656a: feat(core): add the `apiFrontDoor` prop, the `cloudfront` tier, and `publicApiUrl`

  A Blocks app's API is served by the stack's single shared API Gateway REST API. By
  default clients call that gateway's own `execute-api` endpoint — the `'apigateway'`
  tier. You can now put a Blocks-managed CloudFront distribution in front of it
  instead, with a new prop on `BlocksStackProps` / `BlocksBackendProps`:

  ```ts
  await BlocksStack.create(app, "App", {
    // …
    apiFrontDoor: "cloudfront", // default: 'apigateway'
  });
  ```

  - `'apigateway'` — clients call the API Gateway endpoint directly. Nothing extra to
    deploy; unchanged from before.
  - `'cloudfront'` — one CloudFront distribution in front of the gateway (CloudFront →
    API Gateway → Lambda), and the gateway is built as a regional endpoint so there is
    a single CloudFront layer. One catch-all behavior forwards every request to the
    gateway — uncached, all methods, everything except `Host`, HTTP→HTTPS. The
    distribution's URL is published to the runtime as `BLOCKS_PUBLIC_ORIGIN`, so
    absolute URLs the backend builds (such as AuthOIDC's sign-in callback) use it.

  **`publicApiUrl`** on `BlocksStack` / `BlocksBackend` is the URL clients should call
  under either tier: the CloudFront URL + `/aws-blocks/api` under `'cloudfront'`, else
  `apiUrl`. `apiUrl` stays the gateway's own URL (what `Hosting` forwards to). A
  `BlocksStack`'s `ApiUrl` output — what `deploy` / `sandbox` hand a client as
  `BLOCKS_API_URL` — is `publicApiUrl`; with `BlocksBackend`, emit it yourself. The
  Amplify template now publishes `publicApiUrl` as `blocks_api_url`.

  The default is a constant `'apigateway'` — it is **never** derived from the app's
  shape, so adding or removing Building Blocks never silently changes how the API is
  exposed. Any value other than `'apigateway'` or `'cloudfront'` fails synth.

  When an app fronts its frontend with `Hosting`, the API is served from Hosting's
  distribution; under `'cloudfront'` the managed distribution then stands down — one
  distribution, same origin as the frontend, no CORS and no second hop.

  ⚠️ **Switching tiers — or adding or removing `Hosting` under `'cloudfront'` —
  changes the API's endpoint domain.** Browser auth cookies and sessions are bound to
  the origin they were set on, so the change signs every user out. (A stable custom
  domain, a future feature, would avoid this.) Pick a tier, and decide on Hosting,
  before you have real users, and treat a later change as a breaking migration.

- 8b5ef4a: fix(hosting): stop the SSR REST API from leaking an IAM role on every teardown

  The SSR origin's `RestApi` relied on CDK's default `cloudWatchRole: true`, which
  provisions an account-level `AWS::ApiGateway::Account` plus a CloudWatch Logs IAM
  role with `RemovalPolicy.RETAIN`. The SSR stage enables neither execution nor
  access logging, so the role was unused, and because it is retained, every
  `cdk destroy` of a hosting SSR stack left one orphaned IAM role behind — enough,
  over repeated deploys, to exhaust the account's 3000 `RolesPerAccount` quota and
  make all subsequent deploys fail with `ServiceLimitExceeded`. The SSR `RestApi`
  now sets `cloudWatchRole: false` (matching `bb-lambda-compute`), so no role or
  `ApiGateway::Account` is created. Existing stacks drop both resources on their
  next deploy; the previously retained role is not removed by CloudFormation and
  can be deleted manually — but first check `aws apigateway get-account`: if the
  region's `cloudwatchRoleArn` still points at that role, deleting it breaks
  logging for every other API Gateway stage in the region.

- 382dac6: fix(hosting): the image-optimization Lambda no longer follows redirects on remote image fetches

  The IPX image Lambda validated a remote image URL against the allowlist
  (`IMAGE_ALLOWED_HOSTNAMES` / `remotePatterns`) once, before fetching — and the
  fetch then followed HTTP redirects without re-validating the target. An allowlisted
  host with an open redirect (a user-content CDN, say) could therefore steer the fetch
  to any host, including `127.0.0.1` inside the Lambda sandbox.

  Remote fetches now use `fetchOptions: { redirect: 'error' }`, so a 3xx fails the
  image request instead of being followed, and the allowlist holds for every request
  the Lambda makes. **If an allowlisted image host serves its images through a redirect,
  allowlist the final location instead.** The generated Lambda also pins `ipx` to an
  exact version (`3.1.1`) rather than `^3.0.0`, so the fetch behavior this guard relies
  on can't change at deploy time.

- c6d9e49: fix(hosting): the image-optimization Lambda's SVG gate now decides by content, not file extension

  With `dangerouslyAllowSVG` / `IMAGE_ALLOW_SVG` off, the image Lambda rejected SVG
  sources only when the URL ended in `.svg`. An origin's content type isn't tied to its
  path, so an SVG served from `/logo` or `/logo.png` passed the gate and was returned as
  `image/svg+xml` from the application's own origin. SVGO, which IPX runs on SVG input,
  is an optimiser rather than a sanitiser and keeps some script-capable constructs.

  The Lambda now sniffs the image bytes from both the S3 originals bucket and allowlisted
  remote hosts, and rejects SVG content with a `415` before IPX processes it. That also
  covers rasterizing requests such as `?f=png`. As a backstop it refuses any SVG output
  unless SVG is enabled. The `.svg` extension check remains as a cheap pre-filter.
  Nothing changes when SVG is enabled, or for raster images.

- 8a1a4a9: test: cover npm's `ci/<vendor>` user-agent token in the shared `isCI()` case table

  Test-only change: `isCI()` reads `ci-info` and four extra environment variables; it does not look at `npm_config_user_agent`, so an npm user agent carrying a `ci/<vendor>` token is not CI on its own. Nothing pinned that: re-adding a user-agent check left the 30-case table fully green. The table now has a case for the token and one for a `ci/` substring inside another token, so a reintroduced check fails in both `@aws-blocks/core` and `create-blocks-app`, which share the table. The table is excluded from the published package, so no runtime or public API change.

- 2be3318: Test-only: the `bb-knowledge-base` CDK test stub no longer mimics the default-compute `handler` accessor; it grants through the shared `executionRole` like the Building Block does. No runtime or public API change.
- 38ce80c: fix: the local dev surface is no longer reachable from the network or from other websites

  - **Dev server binds loopback.** `npm run dev` now listens on `127.0.0.1` instead of every
    interface. It serves your whole API against local mock data with no authentication, so it
    must not be reachable from other machines. For a container or remote devbox, opt in with
    `BLOCKS_DEV_HOST=0.0.0.0` (or `startDevServer({ host })`); a warning is printed when the host
    isn't loopback.
  - **Local realtime WebSocket matches the deployed one.** A client-sent `publish` was broadcast
    to every subscriber with no authorization. The deployed WebSocket has no client publish, so
    the local server now rejects it as well; publish from the server with `Realtime.publish()`.
  - **Local realtime tokens are signed with a per-process random secret** instead of a constant
    published in this repository, so they can't be forged.
  - **The `/realtime` WebSocket upgrade checks `Origin`.** Only loopback origins can connect, plus
    the opted-in host: with `BLOCKS_DEV_HOST=0.0.0.0`, a same-origin page opened by IP address; with
    a concrete `BLOCKS_DEV_HOST` hostname, that hostname. This closes cross-site WebSocket hijacking from any
    page the developer visits. Non-browser clients that send no `Origin` still connect.
  - **`GET /aws-blocks/settings` opens an editor only under the local dev server.** It no longer
    spawns a process or echoes the working directory when the built-in routes run in a deployed
    Lambda, and it opens the file with `execFile` instead of a shell command.
  - **The `nextjs` template's frontend dev server binds loopback** (`next dev --hostname
127.0.0.1`), like the Blocks dev server.

- fd10117: Fix `cognitoFederated()` failing at `cdk synth` with `CannotFindAsset`.

  The published `@aws-blocks/bb-auth-oidc` package was missing the bundled Lambda that registers the identity provider on the user pool (`dist/idp-registration-lambda/index.js`), so any app using `cognitoFederated()` failed to synthesize. This affected both the Cognito-hosted domain prefix and custom domains. The release build now produces the bundle, so it ships with the package again.

- 03ce866: Keep the local dev server alive when a PGlite init trap aborts constructor-time migrations, and recover from it

  A `Database` / `DistributedDatabase` configured with `migrationsPath` runs its
  migrations eagerly in the constructor, before any query awaits them. If PGlite's
  WASM `_pg_initdb` aborts (notably under memory pressure, where the WASM linear
  heap can't grow), that eager, unawaited promise rejected with no handler — an
  unhandled rejection that terminated the whole `npm run dev` process. A shared
  `trackEager` helper (in `@aws-blocks/data-common`) now attaches a logging handler
  so the dev server survives; the same rejection still reaches callers via the
  ready-gate, so a query after a failed init surfaces a branded
  `QueryFailedException` rather than being swallowed.

  A transient trap no longer wedges the data layer: on an init trap the cached
  rejected promise is cleared, so the next query re-runs the idempotent migrations
  once memory eases (matching the engine's own recover-on-retry behaviour).

- 2da2fd4: Sanitize RawRoute uncaught exceptions so raw driver/SDK details no longer leak.

  A RawRoute whose handler throws an uncaught exception previously forwarded that error's raw name and message to the client, the same leak class the RPC path was already fixed for. The RawRoute catch (both the deployed `lambda-handler` and the local `dev-server` paths) now runs the caught throw through core's shared sanitizer: a Building Block or `ApiError` keeps its BB-authored name and message, and everything else — a driver/SDK exception or a bare `Error` — collapses to a generic `500` / `"Internal error"`, with the full error still logged server-side. A handler's own deliberate `ctx.response` writes are untouched; only the uncaught-exception path is sanitized.

  Two small behavior notes: a RawRoute uncaught exception that previously forwarded its raw name/message now returns a generic 500, and an `ApiError` built with the default name no longer emits `name: "ApiError"` on the wire (status is detected via `isApiErrorLike`, not a name compare).

- 30fc4c2: Use `dsql-lint` for local and synth-time Aurora DSQL compatibility checks, allow
  foreign keys, and refresh the PostgreSQL compatibility guidance.
- 32a4b73: Report `AuthOIDC` as the parent block of its session store, and assert the rendered chain on the wire.

  `AuthOIDC` built its session store with the scope it was given rather than itself, so the store's requests reported only `bb/KVStore` and no owning block. It cannot pass `this`: the store becomes the engine's session store, and the engine is an argument to `super()`. It now passes a parent carrying the block's own name, version and fully-qualified ID, built by the new `buildingBlockParent` helper, and the store's own ID is shortened to `sessions` so the session table name is unchanged.

  `core` adds two exports: `computeScopeFullId`, the rule `Scope.fullId` already applies, and `buildingBlockParent`, which wraps it for a block that must construct a child before `super()` has run. Both replace a copy of that rule inside `bb-auth-oidc`. The Cognito env var prefix moves into the package's shared `utils.ts` alongside the cookie-secret name, so the CDK writer and the runtime reader derive both names from one function.

  Two names change, in local and other non-Lambda `aws-runtime` runs only, where `BLOCKS_STACK_NAME` is unset and the app's root is a `Scope`. In that case the old helper walked one scope too far and produced a leading-dash ID, so the cookie-secret and Cognito env var names it looked up were not the ones the CDK side wrote, and session cookies were named `oidc_-my-app-auth`. Both now resolve. A deployed Lambda always has `BLOCKS_STACK_NAME` set and is unaffected. Under the default condition, which is what a scaffolded app's dev server resolves, the cookie prefix also changes to `oidc_my-app-auth`, from `oidc_my-app_auth` under a plain root and `oidc__my-app_auth` under a `Scope` root, because the dev entry now names cookies with the same expression as the AWS runtime instead of its own. Existing sessions in those two setups are signed out once.

  Nothing covered the chain inside the rendered header, so a change that stopped it reaching the wire would still have passed. `bb-kv-store`'s request-capture helper now takes a parent scope, and `bb-auth-oidc` gains a suite that runs under `--conditions=aws-runtime`, where the session store is the real AWS client, and asserts the captured `user-agent` header carries both blocks root-to-leaf. The CDK suite pins the literal env var names the synth side writes, which nothing checked before, and `core` gains tests for the new helper covering attribution, the official-name gate, and the derived ID.

- da6d4c7: Scope shared Blocks synth state to the owning backend root (`BlocksStack`/`BlocksBackend`) instead of the enclosing `cdk.Stack`, so two `BlocksBackend`s in one stack — and multiple stacks in one synth — stay independent.

  - **Registries** (config, compute, dashboard, tracer, VPC requirements) now key on the backend root, resolved by walking the construct tree (`getBlocksRoot`), not on `cdk.Stack.of(scope)`.
  - **Shared-infra Building Blocks** now provision and dedup their per-backend resources under the backend root: the realtime WebSocket API, the cron scheduler role, and the agent AgentCore runtime grants. Previously a second backend in the same stack could attach to the first's shared infra — most seriously, the agent's Bedrock grants could land on the wrong backend's execution role.
  - **RawRoute** registrations are tagged with their owning backend root; `Hosting` now adds CloudFront behaviors only for routes owned by the backend its distribution fronts, instead of every route in the process-global registry. The per-owner tag also scopes duplicate-route detection, so two backends may register the same method+path.
  - **`Hosting` now registers its origin config against the backend it fronts.** `BLOCKS_PUBLIC_ORIGIN` and `CORS_HOSTING_ORIGINS` are written to the backend named by `props.api`, matching the route-behavior owner — not to `this`, which (when two backends share a stack) resolved via the ambient pointer to the last-created backend and left the fronted backend without its origin config.
  - The config bucket is parented under the resolved backend root rather than read from an ambient process-global, removing a construction-order hazard.
  - **Stack-scoped exceptions — these deliberately keep a stable logical ID.** The app-setting secret bulk-init (`BlocksSecretsBulk`) and the distributed-table GSI manager provider (`BlocksGsiProvider`) stay direct stack children. Both are referenced by existing resources through immutable fields (a SecureString's physical name; a custom resource's `ServiceToken`), so a logical-ID change would force a replacement that CloudFormation either rejects (`ServiceToken` is immutable → failed upgrade) or that silently deletes the SecureString. Keeping them stack-scoped preserves the logical ID; their deploy-time IAM is still scoped (lazily) to only the parameters/tables that register. (Joins the API Gateway account resource as a documented stack-scoped exception.)

  **Compatibility.** Single-`BlocksStack` apps (the common case) are byte-identical — no resource replacement. Apps that embed a `BlocksBackend` inside a customer `cdk.Stack` and use **realtime** or **cron** will see those resources re-parent from the stack to the backend construct, which CloudFormation treats as a replacement on upgrade; neither carries persistent data. For realtime specifically, the WebSocket API URL changes and its stack output key changes from `RealtimeWsUrl` to `BlocksRealtimeWsUrl<hash>` — scripts that read that output by name must update. Secret AppSettings and GSI-backed tables are **not** affected (their shared resources stay stack-scoped).

- ec7eebe: docs: recommend `Secret` for production secrets; position `AppSetting(secret: true)` as a free fallback

  Aligns the Secret ↔ AppSetting guidance with AWS's recommendation that credentials belong in a dedicated secret store. Customer- and agent-facing docs (READMEs, exported-symbol JSDoc) now steer users to `Secret` for any credential protecting a production app and describe `AppSetting` with `secret: true` as a free, encrypted fallback for a low-value secret only — phrased in Blocks terms (`Secret` / `AppSetting`) with a link out to the AWS guidance rather than naming the underlying services inline. The per-BB `DESIGN.md` docs carry the explicit service-level rationale (AWS Secrets Manager vs SSM Parameter Store SecureString).

  Also corrects an inaccurate security tip in the umbrella README that said to "never use `.env` files" — the framework documents legitimate `.env` usage for local dev (e.g. hosting, `bb-data`). The tip now says what it means: don't hardcode secret values in source, and don't ship real secrets to a deployed app through plaintext environment variables — set them through `Secret`/`AppSetting`.

- f1eb149: fix(telemetry): keep every event written to `--telemetry-file` instead of only the first

  The sink created the file with `O_CREAT | O_EXCL` and swallowed the resulting `EEXIST`, so a run that emitted more than one event recorded only the first. In `@aws-blocks/core` a `dev` server that retries a port bind emits `dev/FAIL` then `dev/SUCCESS`, and the success was lost. Events after the first are now appended to the same JSON array. A path that already existed when the run started is still left untouched. The container is unchanged — a JSON array, 2-space indented — so a consumer reading the first element is unaffected, but a file can now hold more than one event: anything asserting exactly one needs updating.

- 7c19c4f: feat: `npm run deploy -- --wait-live` holds `BLOCKS_DEPLOYED` until the new build is actually served

  `cdk deploy` returning is not the same as the new frontend build being served.
  Two edge windows stay open after CloudFormation reports complete, and emitting
  `BLOCKS_DEPLOYED` while either is open lets a caller's immediate self-test hit a
  stale bundle and silently miss a regression.

  - **New opt-in `--wait-live` flag.** When set, `npm run deploy` only prints
    `BLOCKS_DEPLOYED` once the new build is confirmed live, so a request issued
    immediately after the signal returns the new asset.
  - **Per-build config match (the KVS cutover).** Each deploy stamps its build id
    into the runtime config (`/.blocks-sandbox/config.json`) and surfaces it as a
    `HostingBuildId` stack output; the poll declares the config live only when the
    body CloudFront serves carries that exact id, distinguishing the new build from
    a byte-identical config still served by an edge POP routing to the previous
    build during cutover — the common re-deploy case.
  - **Invalidation wait (the compute/SSR window).** For a compute deploy the `/*`
    CloudFront invalidation that flushes the previous build's edge-cached SSR HTML
    is fire-and-forget, so CloudFormation returns before it propagates. The deploy
    now surfaces the invalidation id as a `HostingInvalidationId` stack output and,
    under `--wait-live`, polls `GetInvalidation` until `Completed` before signalling
    — closing the window where the edge still serves old SSR HTML (referencing old
    hashed assets → 403). Pure-static deploys issue no invalidation and skip this.
  - **Bounded probing.** Each config probe carries a per-request timeout
    (`AbortSignal`), so one stalled response cannot hold the deploy past its budget.
    `--wait-live-timeout=<seconds>` tunes the overall budget (default 180); if
    liveness can't be confirmed in time, the deploy — which itself succeeded — prints
    a clear warning and exits non-zero rather than emitting a false "live" signal.
  - **No-op for backend-only apps** (no frontend to verify) and off by default, so the
    existing deploy flow is unchanged unless you opt in.

- Updated dependencies [ec7eebe]
- Updated dependencies [f8fbc6e]
- Updated dependencies [59c9dde]
- Updated dependencies [c20cbfd]
- Updated dependencies [8f9510a]
- Updated dependencies [fbef372]
- Updated dependencies [8f725b6]
- Updated dependencies [e682ba7]
- Updated dependencies [3a7eb9e]
- Updated dependencies [e7e96e6]
- Updated dependencies [9ebda66]
- Updated dependencies [78f4396]
- Updated dependencies [440ecce]
- Updated dependencies [92fa27b]
- Updated dependencies [1a5c18e]
- Updated dependencies [4ae500e]
- Updated dependencies [6d764f7]
- Updated dependencies [4fe7be4]
- Updated dependencies [023f02c]
- Updated dependencies [5d6656a]
- Updated dependencies [60616b1]
- Updated dependencies [a50fb46]
- Updated dependencies [8b5ef4a]
- Updated dependencies [382dac6]
- Updated dependencies [c6d9e49]
- Updated dependencies [8a1a4a9]
- Updated dependencies [2be3318]
- Updated dependencies [38ce80c]
- Updated dependencies [94a914a]
- Updated dependencies [cb0ec01]
- Updated dependencies [005c095]
- Updated dependencies [fd10117]
- Updated dependencies [b8649dc]
- Updated dependencies [03ce866]
- Updated dependencies [2da2fd4]
- Updated dependencies [30fc4c2]
- Updated dependencies [66f4be2]
- Updated dependencies [32a4b73]
- Updated dependencies [da6d4c7]
- Updated dependencies [e3e5e22]
- Updated dependencies [ec7eebe]
- Updated dependencies [e9241b5]
- Updated dependencies [f1eb149]
- Updated dependencies [122c49c]
- Updated dependencies [8ca3692]
- Updated dependencies [7c19c4f]
  - @aws-blocks/bb-secret@0.2.0
  - @aws-blocks/core@0.7.0
  - @aws-blocks/bb-agent@0.6.0
  - @aws-blocks/bb-auth-basic@0.1.11
  - @aws-blocks/bb-data@0.4.0
  - @aws-blocks/bb-lambda-compute@0.6.0
  - @aws-blocks/bb-async-job@0.2.3
  - @aws-blocks/bb-auth-cognito@0.1.12
  - @aws-blocks/bb-app-setting@0.3.2
  - @aws-blocks/bb-dashboard@0.2.2
  - @aws-blocks/bb-email-client@0.1.9
  - @aws-blocks/bb-file-bucket@0.3.1
  - @aws-blocks/bb-kv-store@0.3.1
  - @aws-blocks/bb-metrics@0.1.9
  - @aws-blocks/bb-distributed-table@0.2.2
  - @aws-blocks/bb-knowledge-base@0.2.6
  - @aws-blocks/bb-cron-job@0.3.0
  - @aws-blocks/bb-realtime@0.4.0
  - @aws-blocks/hosting@0.4.1
  - @aws-blocks/bb-auth-oidc@0.2.2
  - @aws-blocks/bb-distributed-data@0.2.2
  - @aws-blocks/auth-common@0.2.0
  - @aws-blocks/bb-logger@0.2.2
  - @aws-blocks/bb-tracer@0.2.2

## 0.7.0

### Minor Changes

- 20be3f0: fix(bb-kv-store): wire point-in-time recovery from the stack preset and add customer-managed encryption

  `KVStore` now honors `defaults.pointInTimeRecovery` (PITR on under `production`, off under `sandbox`) and accepts per-block `pointInTimeRecovery` and `encryption` options — mirroring `DistributedTable`. `encryption: 'customer-managed'` provisions a dedicated CMK, and `KVStore.fromKmsKey(arn)` reuses an existing key across stores. Previously `KVStore` ignored the preset, so production-preset consumers believed PITR was enabled when it was not.

  The default encryption now emits the AWS-managed `aws/dynamodb` KMS key (`SSESpecification: { SSEEnabled: true }`), where before no `SSESpecification` was emitted at all (the AWS-owned key). On an already-deployed table this is an in-place SSE change applied on upgrade, and the `aws/dynamodb` key bills per-request KMS charges that the AWS-owned key does not.

  **Behavior change on next production deploy of an existing app:** an existing `production`-preset `KVStore` table gains Point-in-Time Recovery in place on the next deploy (an in-place update, no table replacement); continuous backups are billed per GB-month of table size. Separately, passing `removalPolicy`, `deletionProtection`, or `ttl` alongside `fromExisting()` now warns at synth (previously only `pointInTimeRecovery` and `encryption` did), so a pipeline running `cdk synth --strict` will fail until those options are removed from the wrapped-table call.

### Patch Changes

- 8da1d1f: feat(bb-agent): compute-agnostic client streaming API — `createChat` + `realtimeTransport`

  Adds a redesigned client streaming surface that hides the runtime behind a single
  transport seam, so the same frontend code works across runtimes:

  - `createChat({ transport, api })` — the client API. The common case is one call
    (`chat.sendMessage('Hello')`); subscribe and run are fused so the
    subscribe-before-send race can't surface. The flexible primitives `run()`
    (produce) and `subscribe()` (consume) are exposed for fan-out, observer-only
    attach, and decoupled produce/consume.
  - `realtimeTransport(...)` — the Lambda + Realtime implementation of the
    `ChatTransport` seam. Configure it once; call sites never name the runtime. A
    future runtime supplies a different transport; nothing else on the client changes.

  Additive and non-breaking. The `stream()` / `getChannel()` / `resume()` server
  methods are unchanged (the new transport is built on them). Only the `useChat`
  client hook is now marked `@deprecated`, superseded by `createChat`.

- 773cef2: fix(astro): allow an empty `dist/client` for pure-SSR builds

  A server/hybrid Astro app with no static assets — no `public/` files and no
  prerendered pages — produces an empty `dist/client`. The adapter treated that as
  a missing build output and threw `AstroBuildOutputMissingError`, blocking synth
  and deploy. `dist/server/entry.mjs` is the real required artifact; an empty (or
  absent) `dist/client` is valid, since CloudFront routes every request to the SSR
  Lambda. The adapter now requires only the server entry and ensures `dist/client`
  exists (creating it when absent, with a build-log breadcrumb) instead of failing.

- ea5f91c: fix(bb-auth-basic): echo the username on the confirm-signup / confirm-reset forms

  AuthBasic's `confirmingSignUp` and `confirmingPasswordReset` states rendered
  `username` as an empty, visible text field — so after signing up (or requesting a
  reset) the user had to **retype** their username on the confirmation step, and a
  mismatch silently broke the flow. The username is now echoed as a **hidden**
  field prefilled with the value just entered (mirroring `bb-auth-cognito`), so the
  confirm form carries it automatically. The `code` / `password` / `newPassword`
  fields are unchanged.

- 2e72825: fix(bb-auth-cognito): `requireRole` reads group membership live so admin group changes take effect without a re-login

  `requireRole` checked the signed-in user's `cognito:groups` **token claim**, which
  is a snapshot from sign-in. After an admin ran `auth.admin.addUserToGroup(user,
'admins')`, that user's live session kept getting **403** until their token
  refreshed or they re-logged in — the "admin surface is unreachable / `requireRole`
  returns 403 for everyone" symptom. The mirror bug: `removeUserFromGroup` did **not**
  revoke a live session, so a removed member kept access until their stale token
  expired.

  `requireRole` now reads membership live at call time — AWS: `AdminListGroupsForUser`
  (paginated); mock: in-process `state.groups` — mirroring how `fetchUserAttributes`
  reads live rather than trusting the token. The returned `CognitoUser.groups`
  reflects the live read. Grants and revocations now apply on the user's next
  request, with no re-login.

  - Costs one extra Cognito call per guarded request. The cheaper identity reads
    (`requireAuth` / `getCurrentUser` / `signIn`) still surface the cached
    `cognito:groups` claim — use `requireRole` when you need live membership.
  - `cognito-idp:AdminListGroupsForUser` is now granted to the execution role
    unconditionally (it backs a client-facing guard), independent of the opt-in
    `admin` surface. Every other `Admin*` action still requires opt-in.
  - Added `admin.test.ts` cases covering the sign-in-then-mutate ordering in both
    directions (grant is honored, revocation locks out); updated the CDK IAM
    least-privilege test for the new baseline grant.

- 4456fd7: Document the full `AuthState` shape returned by `getAuthState()`/`setAuthState()` (`errorName`, `retriable`, and the `confirmingSignIn` state) in the auth READMEs, and note that `bb-auth-cognito` / `bb-auth-oidc` consumers import the type from `@aws-blocks/auth-common`.
- 39628cb: fix(core): anchor and escape CORS allowlist origins

  CORS allowlist entries are compiled to regular expressions. Two matching gaps let a
  plain-looking origin match more broadly than intended:

  - An entry beginning with `^` was used verbatim with no end anchor, so
    `^https://app\.example\.com` also matched `https://app.example.com.extra`.
    `parseCorsPatterns` now compiles every entry as `^(?:<entry>)$`, so the anchors
    bind the whole expression — including every branch of a top-level `|` alternation,
    not just the last.
  - The framework-injected hosting origin (the CloudFront/custom domain) was compiled
    into the regex allowlist as a raw string, so its `.` characters were treated as
    regex metacharacters rather than literals. Hosting origins now travel in a separate
    literal channel (`CORS_HOSTING_ORIGINS`): the origin is registered raw at synth (so
    its CloudFormation token resolves to the real domain) and escaped literally at
    runtime, so a domain like `d123.cloudfront.net` matches its dots literally.

  User-supplied `CORS_ALLOWED_ORIGINS` entries remain regex patterns (the `.*` escape
  hatch and subdomain patterns are unchanged); literal dots in an origin should be
  escaped (`https://app\.example\.com`), as the README documents.

  **Migration.** Automatic end-anchoring of `^`-prefixed entries is a tightening: an
  entry like `^https://app\.example\.com` previously also matched
  `https://app.example.com:8443`, and now does not. If you relied on that prefix
  behavior, append an explicit suffix such as `(:\d+)?` or `.*` to the entry.

  `CORS_HOSTING_ORIGINS` must now be a **raw** origin (it is escaped once at runtime); a
  pre-escaped value would be escaped a second time and stop matching.

- d4b32f2: Add `README.md` and `DESIGN.md` to `@aws-blocks/create-block` and ship them in the published package (`files`), matching the first-party package convention.

  Tidy two `extract-ts-types` test nits (test/comment only, no runtime change): replace a redundant re-assert with a direct check of the documented lingering-bare-key behavior, and link the array/tuple & nested-destructuring boundary to its tracking issue (#552).

- a649895: Emit a machine-readable completion signal on a successful `npm run deploy` **and** `npm run sandbox`.

  `deploy()` now prints one stable last line — `BLOCKS_DEPLOYED url=<frontend> api=<backend>` (a backend-only app omits `url=`) — so a caller (a coding agent, a CI step, a script) can detect "deploy finished + where it lives" by grepping one line instead of parsing streamed CloudFormation output or polling the stack for the URL. `sandbox()` prints the same line on its success path (backend-only — `BLOCKS_DEPLOYED api=<backend>`, since the sandbox serves the frontend locally), so a programmatic caller greps the identical token after either command. The existing human-readable `✅ Deployment complete!` / `📡 API URL` / `🌐 Frontend URL` lines are unchanged; the signal is additive. The formatting is extracted into a pure `formatDeploySignal()` helper with unit coverage, shared by both entry points. The scaffolded `AGENTS.md` documents the line so agents grep it rather than poll.

  For `npm run deploy` specifically (which streams a real CloudFormation deploy), the heartbeat now also names the resource currently converging — e.g. `waiting on HostingDistribution (AWS::CloudFront::Distribution)` — and surfaces a rolling-back resource as a warning rather than silently clearing it, and the frontend URL is surfaced early (on the in-progress path) so a deploy killed at a caller timeout has still reported where the app lives.

- 251aed2: fix(bb-file-bucket): align unknown-`versionId` behavior between the mock and AWS

  On a versioned bucket, an unknown `versionId` diverged between runtimes. S3 does
  **not** signal an unknown `versionId` as `NoSuchVersion` (verified against real
  S3): an id it cannot resolve comes back as `InvalidArgument` ("Invalid version id
  specified") on `GetObject`/`DeleteObject` and `InvalidRequest` on `CopyObject`;
  `NoSuchVersion` is reserved for a well-formed id that no longer exists. The AWS
  runtime now normalizes all of these so the observable contract matches the mock:

  - `get()` — returns `null` for an unknown `versionId` (matching the mock and
    `get()`'s documented "null if it does not exist" contract), instead of throwing.
  - `delete()` — is a silent no-op for an unknown `versionId` (matching the mock),
    instead of throwing.
  - `restoreVersion()` — throws a clean, matchable `FileBucketErrors.VersionNotFound`
    (`NoSuchVersion`) via core's `blocksError` producer, so both `.name`
    (`isBlocksError(e, FileBucketErrors.VersionNotFound)`) and the `.message` agree
    across runtimes — instead of the raw S3 error, whose enumerable `$metadata`
    (request IDs, ARNs) would leak to the client on serialization.

  The raw S3 codes are folded only when a `versionId` was actually supplied, so an
  unrelated `InvalidArgument`/`InvalidRequest` still surfaces. Also adds the public
  `FileBucketErrors.VersionNotFound` constant, and encodes the caller-supplied
  `versionId` in `CopySource` (a value with `&`, `#`, `?`, or a space would
  otherwise corrupt the `x-amz-copy-source` header).

- 6b7fe4c: fix(hosting): retain the ISR tag-table seed custom resource on stack delete

  The `IsrTagTableSeed` custom resource is backed by a Lambda through a CDK
  `Provider`. On stack delete CloudFormation tore the provider's framework Lambda
  down before it sent the custom resource its `Delete`, so the delete invoke hit
  an already-gone function, received no response, and hung to the 30-minute
  custom-resource timeout -- failing the whole stack delete with `DELETE_FAILED`
  and re-failing identically on every retry. The seed custom resource now carries
  `RemovalPolicy.RETAIN`, so CloudFormation drops it on delete without a delete
  invoke and the stack tears down cleanly. This is behavior-preserving: the
  OpenNext `dynamodb-provider` `remove()` path is a no-op, and the seeded rows
  live only in the ISR tag table, which is destroyed with the stack -- so
  retaining the custom resource orphans nothing.

- dae7a86: fix(hosting): warn when a compute resource pins an end-of-life Node.js runtime

  `resolveRuntime` still accepts an explicitly pinned `nodejs18.x` or `nodejs20.x`
  (so an existing/deployed function isn't hard-broken at synth), but both are past
  their AWS Lambda deprecation dates (Node 18: Apr 2025; Node 20: Apr 2026). It now
  emits a CDK synth-time **deprecation warning** for those runtimes, pointing at
  `nodejs22.x` / `nodejs24.x` (or omitting the runtime to use the default). A
  supported runtime, or omitting it, warns nothing; the accepted set and the
  hard error for unrecognized runtimes are unchanged.

- 5454763: fix(bb-kv-store): align `delete()` conditional detection with the mock and `put()`

  The AWS `delete()` path detected the value-equality condition with
  `'ifValueEquals' in conditions` (key presence), while the mock and AWS `put()`
  use `!== undefined`. Two consequences, both mock↔AWS parity breaks:

  - `delete(key, { ifValueEquals: undefined })` was a silent no-op on the mock but,
    on AWS, emitted `#value = :expected` with `:expected = JSON.stringify(undefined)`
    (`undefined`) — a DynamoDB DocumentClient marshalling error instead of an
    unconditional delete.
  - The `if/else if` applied only `attribute_exists(#pk)` when both `ifExists` and
    `ifValueEquals` were set, silently dropping the value check — so on AWS the
    item was deleted regardless of its value, while the mock (correctly) required
    both.

  `delete()` conditions are now composed conjunctively (`attribute_exists(#pk) AND
#value = :expected`) with `!== undefined` detection, matching the mock branch-for-
  branch. Added `parity.test.ts` cases asserting the `DeleteCommand` shape for each
  combination (value-only, exists-only, both, none, explicit `undefined` no-op, and
  `null` as a real condition).

- a23b8d8: Stop leaking raw backend exception details in RPC error responses, while forwarding Building Block error names AND their BB-authored messages.

  `errorResponseFromCatch` sorts a caught throw into three cases: an `ApiError` crosses the wire verbatim (status, `message`, `name`, `retriable`); a Building Block error carrying the wire-safe brand forwards BOTH its BB `name` in `data.name` AND its BB-authored `message` (per D-003, the wire carries `name` alongside `message`), so `isBlocksError()` keeps matching on the client and the caller sees the real, actionable message ("Batch contains 150 payloads, exceeds the 100 limit"); and everything else — a driver/SDK exception, a bare `Error`, or a non-`Error` throw — collapses to a nameless generic `500` / `"Internal error"`. The full error (including `cause`) is still logged server-side in every case.

  The brand is a non-enumerable symbol stamped by core's new `brandBlocksError()` helper, and the serializer keys the name-and-message-forwarding decision on that brand rather than on `.name !== 'Error'`. Every Building Block that mints a named error now routes it through that one helper — core's `blocksError()`, each package's own local `blocksError()`, and the inline named-error sites across the runtime and mock layers — so a BB error keeps its `name` and message on the wire no matter which package or layer threw it. A raw driver exception whose class name happens to be non-generic (`PostgresError`, `DynamoDBServiceException`) is never branded, so neither its class name nor its raw message ever reaches the client.

  The load-bearing invariant, now that messages cross the wire: **a branded error's message must never embed raw driver/SDK text.** Two message-embedding sites are therefore given stable, BB-authored messages (`bb-kv-store` and `bb-distributed-table`'s item-too-large remaps, which previously copied DynamoDB's raw `err.message`), keeping the raw driver error only as `cause`.

  Re-tag paths are branded, with a stable message. The catch-all re-tag paths in `bb-data` (`wrapError` / `translatePgError`) and `bb-distributed-data` (`translateDsqlError`) — which classify a caught driver error as `QueryFailed` / `ConnectionFailed` — now build a fresh BRANDED error carrying the BB `name` and a stable BB message (e.g. "The database query failed"), keeping the raw driver error as `cause`. This preserves the client-side `isBlocksError(e, DatabaseErrors.QueryFailed | .ConnectionFailed)` retry contract the `bb-data` README teaches for auto-pause-resume, and — because the message is a stable BB string, not the driver's — a re-tagged error still never leaks driver internals over the wire. The 40001 / 23505 conflict paths already crossed as `ApiError` (409) with stable messages and are unchanged. Also branded in this pass: `bb-auth-oidc`'s `InvalidRelayError` (a class-field error not reached by the `.name =` sweep) and `bb-distributed-data`'s mock DDL-guard error (name `DsqlPermissionException`, the internal `DSQL_PERMISSION_ERROR_NAME`; now branded with a stable message, its name kept internal and mock-only, not a public `DistributedDatabaseErrors` constant).

  The two `bb-realtime` client-middleware `brandBlocksError` calls are commented as intentionally inert (a client-side subscription rejection matches on `err.name`, never routes through the server serializer). The realtime e2e's `ConnectionFailedException` assertions run against `channel.subscribe()` in-process on the client, not across the RPC serializer.

  ## Breaking change (why `@aws-blocks/core` is a minor)

  App code that throws a plain `Error('Todo not found')` from an API method now surfaces as a generic `500` / `"Internal error"` on the client instead of the raw message (a customer-defined `Error` also loses its `.name`). This is the intended safety net — an unbranded throw is treated as an unhandled internal error — but it changes client-visible behavior, so `@aws-blocks/core` ships as a minor (we are pre-1.0). To send a specific status, name, and message to the client, throw an `ApiError`:

  ```ts
  // before — message collapses to "Internal error" on the client
  throw new Error("Todo not found");

  // after — status, message, and name all reach the client
  throw new ApiError("Todo not found", 404, { name: "TodoNotFoundException" });
  ```

  Building Block errors (`isBlocksError` / `blocksError`) are unaffected — their name and message continue to cross the wire.

- 7b7a59f: fix(bb-cron-job,hosting): scope service-principal grants to the deploying account

  - **bb-cron-job**: the EventBridge Scheduler role's trust policy is now limited to
    schedules in the stack's account and region (`aws:SourceAccount` and an `aws:SourceArn`
    schedule-group pattern).
  - **hosting**: removed a redundant CloudFront `kms:Decrypt` statement from the SSE-KMS key
    policy. The Origin Access Control wiring already grants CloudFront decrypt on the bucket key,
    conditioned on `AWS:SourceArn` matching the account's CloudFront distributions.

- 465a002: fix(telemetry): use ci-info for CI detection so Taskcluster (`TASK_ID` + `RUN_ID`), Netlify, Vercel, and 40+ other CI providers are identified; also keep the previously checked `CODEBUILD_BUILD_ID`, `JENKINS_URL`, `BITBUCKET_BUILD_NUMBER` and `TASKCLUSTER_ROOT_URL` variables, and honor `CI=false`
- e57da06: Report bbName/bbVersion in telemetry.
- Updated dependencies [8da1d1f]
- Updated dependencies [773cef2]
- Updated dependencies [ea5f91c]
- Updated dependencies [bd9a1b8]
- Updated dependencies [2e72825]
- Updated dependencies [4456fd7]
- Updated dependencies [fac0e75]
- Updated dependencies [3fac52c]
- Updated dependencies [0e18d5b]
- Updated dependencies [20be3f0]
- Updated dependencies [5501cb6]
- Updated dependencies [7c24547]
- Updated dependencies [b58f248]
- Updated dependencies [39628cb]
- Updated dependencies [d4b32f2]
- Updated dependencies [a649895]
- Updated dependencies [27646ac]
- Updated dependencies [1f8a412]
- Updated dependencies [fa0406b]
- Updated dependencies [251aed2]
- Updated dependencies [6b7fe4c]
- Updated dependencies [5515483]
- Updated dependencies [dae7a86]
- Updated dependencies [5454763]
- Updated dependencies [757d4a9]
- Updated dependencies [b0be240]
- Updated dependencies [cbedb3c]
- Updated dependencies [f1d2cd5]
- Updated dependencies [de3c17c]
- Updated dependencies [a23b8d8]
- Updated dependencies [7b7a59f]
- Updated dependencies [9e02b82]
- Updated dependencies [465a002]
- Updated dependencies [e57da06]
- Updated dependencies [de3c17c]
- Updated dependencies [9608dce]
  - @aws-blocks/bb-agent@0.5.0
  - @aws-blocks/hosting@0.4.0
  - @aws-blocks/bb-auth-basic@0.1.10
  - @aws-blocks/bb-auth-cognito@0.1.11
  - @aws-blocks/auth-common@0.1.9
  - @aws-blocks/bb-auth-oidc@0.2.1
  - @aws-blocks/bb-app-setting@0.3.1
  - @aws-blocks/bb-kv-store@0.3.0
  - @aws-blocks/core@0.6.0
  - @aws-blocks/bb-file-bucket@0.3.0
  - @aws-blocks/bb-async-job@0.2.2
  - @aws-blocks/bb-data@0.3.1
  - @aws-blocks/bb-distributed-table@0.2.1
  - @aws-blocks/bb-email-client@0.1.8
  - @aws-blocks/bb-knowledge-base@0.2.5
  - @aws-blocks/bb-realtime@0.3.0
  - @aws-blocks/bb-distributed-data@0.2.1
  - @aws-blocks/bb-cron-job@0.2.2
  - @aws-blocks/bb-dashboard@0.2.1
  - @aws-blocks/bb-metrics@0.1.8
  - @aws-blocks/bb-lambda-compute@0.5.1
  - @aws-blocks/bb-logger@0.2.1
  - @aws-blocks/bb-tracer@0.2.1

## 0.6.0

### Minor Changes

- d7312f9: Make observability **compute-driven** so it composes correctly once an app has more than one compute. Logging, tracing, and the dashboard now key off compute state rather than off the Logger / Tracer / Dashboard blocks poking a single implicit compute.

  **Logging is always on; retention is a compute-level setting.** Every compute captures stdout to its own log group unconditionally — there is no "enable logging" step. The retention of that group is set per compute via a new `logRetention` prop on `LambdaCompute` (`@aws-blocks/bb-lambda-compute`), falling back to `defaults.logRetention`. Log **level** is purely per-instance runtime behavior: set it via a `Logger`'s `level` option (default `'info'`). There is no app-wide log-level default and no `LOG_LEVEL` env var.

  **Tracing is presence-gated.** Creating any `Tracer` in the app now enables X-Ray on **every** compute (X-Ray provisions real, costed infrastructure, so it stays off until the app opts in by constructing a Tracer). This replaces the previous model where a Tracer turned on tracing for one implicit compute. `@aws-blocks/core/cdk` adds `registerTracer()` (records Tracer presence) and `finalizeTracing()` (enables tracing on all computes at finalize); `create()` runs it before finalizing dashboards. `Compute.enableTracing()` is now idempotent.

  **The dashboard is organized by compute, with display toggles.** `DashboardOptions` gains `logs?: boolean` (default `true`) and `traces?: boolean` (default `true`) — app-wide display toggles applied uniformly to every compute section. `logs:false` hides the (always-captured) logs section; `traces:false` hides traces even when tracing is enabled.

  The dashboard covers **every** compute in the app (resolved at finalize, so construction order never matters). Each compute renders a health section always, a logs section (unless `logs:false`), and a traces section only when tracing is enabled on it (unless `traces:false`). Metrics remain app-scoped and are passed explicitly. No `computes` selector is exposed yet — it would leak the internal `Compute` type before customers can construct a compute; it arrives with the multi-compute surface.

  **⚠️ Behavior / API changes:**

  - **`Logger` no longer reconfigures log retention.** The CDK `Logger` is now a no-op placeholder (logging is always on and retention moved to the compute). The `retention` option was removed from `LoggingOptions`; set `logRetention` on the compute instead.
  - **A `Tracer` now enables X-Ray on all computes, not one.** Any Tracer in the app turns on tracing fleet-wide.
  - **`Logger` no longer reads the `LOG_LEVEL` environment variable.** Log level is set solely via the per-`Logger` `level` option (default `'info'`); the previously supported `LOG_LEVEL` env-var override has been removed, and Blocks stamps no app-wide log-level config. `BlocksDefaults` has no `logLevel` field.
  - **Removed the deprecated `LoggerBBRef` / `TracerBBRef` dashboard types.** They were no longer consumed — the dashboard reads compute state directly. Loggers and Tracers were never passed to the Dashboard in this model.

### Patch Changes

- 7b86b8e: fix(auth-oidc): make `cognitoFederated()` deployable by registering the IdP via a deploy-time custom resource

  `@aws-blocks/bb-app-setting` now also exports `SECRETS_BULK_CONSTRUCT_ID` — the
  construct id of the shared per-stack secret-init custom resource — so sibling
  blocks can order a resource after the SecureString values are written without
  hard-coding the string. `bb-auth-oidc`'s IdP-registration custom resource uses
  it to take an explicit dependency on that resource (compile-time coupling, so a
  rename can't silently break the ordering guarantee).

  `cognitoFederated()` previously produced a CloudFormation template that always
  failed to deploy (#447). It registered the federated identity provider with a
  native `AWS::Cognito::UserPoolIdentityProvider` resource, writing the IdP
  `client_id` / `client_secret` into `ProviderDetails` as
  `{{resolve:ssm-secure:...}}` dynamic references. CloudFormation only permits
  `ssm-secure` references on a small allowlist of properties that excludes
  `ProviderDetails`, so `cdk synth` succeeded but every deploy failed at
  change-set creation — before any resource was created — leaving the stack in
  `REVIEW_IN_PROGRESS` with `SSM Secure reference is not supported in [...ProviderDetails...]`.

  The IdP is now registered by a **deploy-time custom resource**: a small
  Lambda-backed provider reads and decrypts the IdP credential SecureString
  parameters via the SDK at deploy time and calls Cognito's
  `CreateIdentityProvider` / `UpdateIdentityProvider` / `DeleteIdentityProvider`.
  Only the parameter _names_ cross into the CloudFormation template — the secret
  values never appear in it. The handler's role is least-privilege: scoped to
  `cognito-idp:{Create,Update,Delete}IdentityProvider` on the pool ARN,
  `ssm:GetParameter` on the specific parameter ARNs, and `kms:Decrypt` conditioned
  on `kms:ViaService = ssm.<region>`.

  A `secret: true` `AppSetting` is an SSM SecureString at `/<fullId>` (not an AWS
  Secrets Manager entry — the `blocks secret` CLI does not apply). Set its value by
  writing the SecureString directly (`aws ssm put-parameter … --type SecureString
--overwrite`) or via the `AppSetting` runtime `put()`. Because the credentials
  are read at deploy time and are not stack properties, the custom resource
  re-reads SSM on every `cdk deploy`, so a credential set or rotation takes effect
  on the next deploy. A synth-time check rejects two providers configured with the
  same `identityProvider`.

  Verified end-to-end against a real account: `cdk deploy` succeeds (no change-set
  rejection) and the identity provider is created on the User Pool, including the
  path where a real `AppSetting(secret: true)` provisions the SecureString during
  the same deploy.

  This is a `minor` bump for `@aws-blocks/bb-auth-oidc` (pre-1.0 minor = a behavior
  change): the synthesized template for a `cognitoFederated()` provider no longer
  contains a native `UserPoolIdentityProvider` resource — the IdP is now a custom
  resource — so anyone asserting on that resource in a snapshot will see a diff.
  The public API is unchanged.

- 4342149: fix(bb-dashboard): depend on `@aws-blocks/bb-lambda-compute@^0.4.0`

  `bb-dashboard` declared its `@aws-blocks/bb-lambda-compute` devDependency as
  `^0.3.0`, which excludes the current workspace version (`0.4.0`). npm therefore
  installed the published `0.3.0` tarball into `bb-dashboard` instead of linking
  the local workspace, and two failures followed: the root `package-lock.json`
  fell out of sync (breaking `npm ci` repo-wide), and `bb-dashboard`'s CDK test
  crashed with `ERR_PACKAGE_PATH_NOT_EXPORTED` importing
  `@aws-blocks/bb-lambda-compute/cdk` — a subpath the old `0.3.0` did not export.

  Aligning the range to `^0.4.0` links the local workspace (which exports
  `./cdk`), fixing both. Dev-dependency-only; no runtime or API change.

- e2c3c62: fix(bb-distributed-data): re-run the DSQL role grant when the app's IAM role is replaced

  `DistributedDatabase` maps the app's IAM role ARN to a DSQL database role with
  `AWS IAM GRANT`. The migration/provisioning CustomResource is documented as running
  on every deploy so the mapping "stays in sync if the app Lambda's IAM role is
  recreated", but its properties were `{ migrationsHash, dbRole }` only — the role ARN
  reached the Lambda as an environment variable and nothing else.

  CloudFormation re-invokes a CustomResource only when its **properties** change. When
  an IAM role replacement changed the ARN while migrations stayed the same, both
  properties were unchanged, so CloudFormation skipped the resource entirely. The
  Lambda's `APP_ROLE_ARN` env var was updated but the function was never called, leaving
  the DSQL grant pointing at the old, deleted ARN. Every query then failed with SQLSTATE
  `28000` (`invalid_authorization_specification`, "unable to accept connection, access
  denied") while the deploy itself reported success and the IAM policy still showed a
  correct `dsql:DbConnect` — the breakage lived in DSQL's internal role mapping, which is
  invisible from the CloudFormation layer.

  `appRoleArn` is now a CustomResource property, so a role replacement re-invokes the
  resource and `provisionAppRole()` re-issues the grant as part of the deploy. The value
  is a CDK token, so it differs only when the role is genuinely replaced — this does not
  force the resource to run on every deploy.

  This was latent from the initial version and stayed dormant while each Lambda kept its
  own stable execution role. It surfaced once the shared execution role landed (#320,
  #341): upgrading `@aws-blocks/core` across that range replaces the per-Lambda
  `HandlerServiceRole` with the shared `BlocksRole`, which is exactly the role-ARN change
  that the CustomResource failed to notice.

  `@aws-blocks/blocks` gets a `patch` bump because it re-exports `bb-distributed-data`
  (satisfies the umbrella publish guard); no umbrella source changed.

  Fixes #556.

- f552ebe: fix(core): follow a factory-returned, destructured `ApiNamespace` when extracting spec schemas (#444)

  `blocks-generate-spec` lost the TypeScript parameter/result schemas for an
  `ApiNamespace` that was constructed inside a factory, returned as a property,
  destructured, and then exported (e.g. `const { api } = new Factory().build()`).
  The extractor's indirect pass only handled a simple identifier binding
  (`const api = …`), so a destructured binding fell through and the method's
  schema was attributed to a bare, unqualified key — which, under a method-name
  collision with another namespace, cross-assigned or degraded to
  `{ "type": "unknown" }` (the same class of bug as #445, via the factory path).

  The indirect pass now also handles **object binding patterns**: for each
  destructured binding it resolves the property's type off the initializer and
  extracts the methods keyed by the local (exported) namespace name — so a
  factory-returned namespace keys qualified (`api.method`) exactly like a
  directly-constructed one, and same-named methods across namespaces no longer
  collide. Renamed bindings (`const { foo: bar } = …`) read the correct property.

- 9aa0814: `blocks-generate-spec`: stop cross-assigning schemas between namespaces that share a method name.

  The TypeScript type extractor keyed method schemas by the bare method name, so when two `ApiNamespace`s each exposed an operation with the same name (e.g. `widgets.create` and `subscriptions.create`), one namespace's parameter/result schemas silently overwrote the other's in the generated OpenRPC document — producing incorrect client types. Method schemas are now keyed by the namespace-qualified name (`namespace.method`), matching how the spec routes operations; the consumer falls back to the bare name for methods the extractor couldn't attribute to a namespace, so no previously-working case regresses.

- 81609a8: `KVStore.put`: allow `ifNotExists` and `ifValueEquals` to compose.

  Previously the two conditional-write options were mutually exclusive — the AWS runtime silently ignored `ifValueEquals` when `ifNotExists` was also set, and the mock rejected the write outright, so passing both was unusable (and the two layers diverged). They now compose with **OR**: the write succeeds when the key is absent **or** its current value matches, and fails only when the key exists **and** the value differs. This is the optimistic "create it, or update it only if unchanged" pattern (`attribute_not_exists(pk) OR value = :expected`). Each option used alone is unchanged.

- 5eee114: Add npm keywords for discoverability via `npm search keywords:aws-blocks`

  Every published package now carries an npm `keywords` array: the shared `aws-blocks`
  discovery tag plus 2–5 functional keywords describing the package's domain and the
  AWS services it uses (e.g. `realtime`, `websocket`, `pubsub` for `bb-realtime`;
  `ci-cd`, `pipelines`, `deployment` for `pipeline`). Metadata only — no runtime,
  API, or behavior change.

- 21443ba: fix(data): map optimistic-concurrency conflicts to JSON-RPC 409 (Conflict) instead of 500

  Optimistic-concurrency / conditional-write conflicts now surface to clients as
  JSON-RPC error **code 409 (Conflict)** instead of a generic **500**. Previously
  these conflicts were thrown as plain named `Error`s (or re-thrown raw driver
  errors), and the JSON-RPC serializer maps any non-`ApiError` to 500 — so a
  routine, expected conflict was indistinguishable from an internal server error.

  Each affected conflict is now an `ApiError` with `status: 409`, so on the client
  `error.status === 409`. The structured `error.name` is preserved end-to-end, so
  `isBlocksError(e, ...)` keeps matching by name on both server and client, and the
  existing typed error constants are unchanged:

  - `@aws-blocks/bb-kv-store` — a failed `ifNotExists` / `ifExists` /
    `ifValueEquals` write or delete (`KVStoreErrors.ConditionalCheckFailed`). The
    AWS runtime now also normalizes DynamoDB's raw `ConditionalCheckFailedException`
    on both `put` and `delete`, matching the mock.
  - `@aws-blocks/bb-distributed-table` — a failed `ifNotExists` / `ifExists` /
    `ifFieldEquals` condition (`DistributedTableErrors.ConditionalCheckFailed`),
    in both mock and AWS `put`/`delete`.
  - `@aws-blocks/bb-distributed-data` — a DSQL serialization failure / OCC
    conflict, SQLSTATE `40001` (`DistributedDatabaseErrors.SerializationFailure`),
    in both the mock and real engines.
  - `@aws-blocks/bb-data` — a serializable-isolation conflict, SQLSTATE `40001`
    (`DatabaseErrors.SerializationFailure`), across the PGlite, pg-client, and
    Data API engines.

  The `retriable` flag is scoped to genuine optimistic-lock conflicts: it is
  `true` for value/field-equals conflicts (`ifValueEquals` / `ifFieldEquals`) and
  the 40001 serialization failures, and omitted/`false` for existence/uniqueness
  assertions (`ifNotExists`, `ifExists`), where a blind identical retry would fail
  identically. Status (409) and `error.name` are unchanged in every case.

  This is a `minor` bump. Every package here is pre-1.0, where `minor` is this
  repo's signal for a change that can alter existing behavior: callers that
  branched on `error.status === 500` for these conflicts (or on the JSON-RPC error
  code) will now see `409`. Code that matches conflicts by name via
  `isBlocksError` — the documented pattern — is unaffected.

  `@aws-blocks/core` and `@aws-blocks/blocks` get a `patch` bump for a docs-only
  change: a clarifying sentence was added to the `ApiError.retriable` JSDoc
  (no behavior or API change).

- acd1628: Share the RawRoute registry across duplicate copies of `@aws-blocks/core` so routes registered through one copy are dispatched (and synthesized into CloudFront behaviors) by another, instead of silently returning 404. Unmatched routes now log a diagnostic, and a duplicate core copy warns once.
- 6496713: Simplify VPC implementation: replace `registerVpcEndpoint` (instanceof-based) with two explicit methods (`registerVpcGatewayEndpoint` / `registerVpcInterfaceEndpoint`), simplify `BlocksVpcOptions` to `{ network, subnets?, provisionEndpoints? }`, and strip persistent test VPC to bare minimum.
- bd67438: feat(auth-oidc): let `stubIdp()` declare test users inline

  `stubIdp()` gains an optional `users?: StubUser[]`. Previously the stub IdP's
  identity directory could only be seeded from a `users.json` file in the mock
  data dir (with a single default user otherwise), so declaring test users meant
  committing/gitignoring a data file. Inline `users` are now the authoritative
  directory for the login screen and the `users` handed to `onAuthorize`, taking
  precedence over `users.json` and the built-in default. Omitting it is unchanged
  (file → default fallback), so existing apps and the AWS runtime are unaffected.

- a47d71c: fix(data): map duplicate-key unique-constraint violations to JSON-RPC 409 (Conflict) instead of 500

  A duplicate-key / unique-constraint violation (SQLSTATE `23505`,
  `UniqueConstraintViolation`) now surfaces to clients as JSON-RPC error
  **code 409 (Conflict)** instead of a generic **500**. Previously the engine
  translators set `error.name` on the raw driver error and re-threw a plain named
  `Error`; the JSON-RPC serializer maps any non-`ApiError` to 500, so a routine,
  expected duplicate-key conflict was indistinguishable from an internal server
  error. This mirrors the `40001`/OCC → 409 mapping already established for these
  Blocks.

  Each affected conflict is now an `ApiError` with `status: 409`, so on the client
  `error.status === 409`. The structured `error.name` is preserved end-to-end, so
  `isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)` (and the
  `DistributedDatabaseErrors` equivalent) keeps matching by name on both server and
  client; the typed error constants are unchanged.

  - `@aws-blocks/bb-data` — a duplicate-key violation (SQLSTATE `23505`,
    `DatabaseErrors.UniqueConstraintViolation`) across the PGlite, pg-client, and
    Data API engines (both the SQLState-parsed and message-matched Data API paths),
    routed through a shared `uniqueConstraintConflict()` helper.
  - `@aws-blocks/bb-distributed-data` — a DSQL duplicate-key violation (SQLSTATE
    `23505`, `DistributedDatabaseErrors.UniqueConstraintViolation`) in
    `translateDsqlError`, in both the mock and real engines.

  The conflict is **not** flagged `retriable`: a duplicate key is deterministic, so
  a blind retry of the same insert fails identically (unlike the `40001`
  serialization failures, which stay retriable). The client-visible message is a
  fixed, stable string; the raw driver text (which can name columns / constraints)
  is retained only as `cause` for server-side diagnostics. Genuine infrastructure
  errors (`ConnectionFailed`, `QueryFailed`) are unchanged and correctly stay 500,
  and the `SerializationFailure`/OCC paths are untouched.

  This is a `minor` bump. Both data packages are pre-1.0, where `minor` is this
  repo's signal for a change that can alter existing behavior: callers that
  branched on `error.status === 500` for these conflicts (or on the JSON-RPC error
  code) will now see `409`. Code that matches conflicts by name via
  `isBlocksError` — the documented pattern — is unaffected.

  `@aws-blocks/blocks` gets a `patch` bump because it re-exports `bb-data` and
  `bb-distributed-data` (satisfies the umbrella publish guard); no umbrella source
  changed.

  Fixes #508.

- 0385f7e: `useChat`: widen `UseChatOptions.api.sendMessage` and `resume` return types from `Promise<void>` to `Promise<unknown>`.

  The natural backend methods return objects (`agent.stream()` → `{ channelId }`, `resume` wrappers → `{ ok: true }`), but `Promise<{ channelId }>` is not assignable to `Promise<void>` (TS2322), which forced customers into an await-and-discard wrapper. `useChat` awaits both calls only for completion and discards the resolved value, so `Promise<unknown>` — assignable-from both object results and `void` — lets natural-shape backends wire up directly while existing `void`-returning backends keep compiling. Type-only change; no runtime behavior change.

- daf523a: docs(bb-agent): add a concrete React `useChat` example

  The `useChat` docs only showed the framework-agnostic callback form and warned
  that it is "a factory function, not a React hook — call it once, not on every
  render," without demonstrating the fix. Added a primary React example that holds
  the instance in a `useRef` (created lazily so it survives re-renders), bridges
  `onMessagesChange` / `onLoadingChange` into `useState`, cleans up with
  `chat.destroy()` on unmount, and renders messages plus a send handler — directly
  resolving the "call once" footgun. Included a one-line Next.js note (same
  component, keep the `'use client'` directive) and kept the existing
  framework-agnostic example as the baseline.

- 6496713: fix(bb-data): place shared-VPC Aurora in the subnets the VPC actually has

  When `Database` runs inside a bring-your-own VPC, its Aurora cluster was pinned
  to `PRIVATE_ISOLATED` subnets. The VPC in every docs example
  (`new ec2.Vpc(app, 'AppVpc', { maxAzs: 2, natGateways: 1 })`) has no isolated
  tier, so following the documented setup and adding a `Database` failed synth
  with "no isolated subnet groups in this VPC."

  Aurora is reached over the RDS Data API (HTTPS via the interface endpoint), not
  a raw Postgres socket, so the placement tier does not affect reachability — it
  only has to be a tier the VPC actually has. The shared-VPC path now prefers the
  isolated tier when the VPC has one (keeping the DB off any NAT path) and falls
  back to `PRIVATE_WITH_EGRESS` otherwise, via the VPC context's `selectSubnets`.
  The standalone path is unchanged — it still builds its own VPC with a dedicated
  isolated tier.

  This is a `patch` bump: pre-1.0, where this repo reserves `minor` for breaking
  changes. The behavior change only affects the shared-VPC path that previously
  failed synth, so it is strictly a fix. The umbrella `@aws-blocks/blocks` gets
  the same bump because it re-exports `Database`.

  Also adds `Template.fromStack` unit coverage for `finalizeVpc` in
  `@aws-blocks/core` — asserting the provisioned `AWS::EC2::VPCEndpoint` set, the
  gateway/interface dedup, and the always-on CloudWatch Logs + SSM endpoints —
  which previously had no test exercising the provisioning path.

- 6496713: feat(core): constructor-forced VPC requirements, lazy VPC, and Database subnet control

  Continues the VPC review follow-ups (net-new, unreleased VPC feature).

  **Building Blocks declare VPC requirements via the constructor, not a method.**
  `BuildingBlockScope` is no longer abstract: its constructor takes the block's VPC
  requirements (a value, or a callback for values that depend on `fullId`) and
  registers them in a central per-stack registry. This keeps the compile-time
  forcing the previous `abstract getVpcRequirements()` provided — a block can't
  silently omit its requirements — without a standing method on every subclass, and
  gives the framework one place to read, deduplicate, and answer "does anything here
  need a VPC?". All Building Blocks were migrated to pass requirements to `super()`.

  **VPC is now a derived resource, not a hard prerequisite.** A block that cannot
  function without a VPC declares `requiresVpc: true`; when one is needed and the
  customer didn't bring their own, Blocks lazily creates a single shared VPC
  (generalizing the create-if-absent behavior `bb-data` already used for Aurora) and
  emits a notice about the NAT cost. Setting `defaults.vpc = { network }` remains the
  bring-your-own override.

  **`Database` accepts an optional `subnets` placement.** A CDK-free mirror of
  `ec2.SubnetSelection` (tier as a string, subnets by id) lets you steer where the
  Aurora cluster lands — for a bring-your-own VPC that lacks an isolated tier, or a
  compliance requirement to use specific subnets. Omit it to keep the default
  (prefer isolated, fall back to `private-with-egress`).

- 6496713: fix(core): harden VPC integration — scoped endpoint SG, runtime-subnet validation, instructive subnet errors

  Second-pass hardening of VPC support based on review feedback.

  **Interface endpoints are no longer reachable from the whole VPC.** They now get
  a dedicated security group that allows 443 only from the Blocks Lambda SG, and
  the endpoints are created with `open: false` to suppress CDK's default
  "allow 443 from the entire VPC CIDR" rule. On a bring-your-own VPC this stops
  unrelated workloads from reaching every Blocks interface endpoint.

  **`VpcRequirements.subnetRole` is replaced by `requiresEgress`.** The old field
  was declared but never consumed. `requiresEgress` expresses a real, validated
  capability: whether the BB's parent runtime (the shared handler Lambda) must be
  able to reach the internet. `finalizeVpc` validates it against the runtime's
  actual placement and fails synth with an actionable message on a mismatch — it
  never relocates the runtime (that's the customer's explicit choice).
  `bb-distributed-data` (DSQL) declares `requiresEgress: true`, turning a
  previously silent runtime failure (DSQL in isolated subnets deploys clean, then
  every call times out) into a build-time error.

  **`VpcContext.selectSubnets` is now instructive.** It takes the requesting BB and
  verifies the VPC actually has the requested subnet tier, throwing a BB-named,
  actionable error instead of the opaque CDK "no subnet groups" error. It accepts
  an explicit `{ fallback }` so a BB can opt into graceful degradation (e.g. Aurora
  over the Data API works from `private-with-egress` when there is no isolated
  tier); the downgrade is never silent. `bb-data` uses this.

  **Other fixes:** Lambda placement now fails fast with an actionable error when a
  VPC has no private-with-egress tier and none was specified; `bb-data` drops its
  unused 5432 ingress rule (Aurora is reached over the RDS Data API, not a socket);
  removed `any` casts from the Lambda props and endpoint/CIDR handling; de-duplicated
  the VPC/non-VPC branches in `BlocksStack`.

  All pre-1.0 `patch` bumps — no breaking changes to shipped, consumed API
  (`subnetRole` had no consumers). The umbrella `@aws-blocks/blocks` re-exports the
  affected types.

- 6496713: fix(core): VPC review follow-ups — egress capability, endpoint trim, S3 gateway

  Refines VPC support based on review feedback (all changes to the net-new,
  unreleased VPC feature).

  **`VpcRequirements.runtimeSubnet` becomes `requiresEgress?: boolean`.** A BB's
  runtime need is a capability ("my code must reach the internet"), not a specific
  subnet tier. Modeling it as a single role wrongly rejected a valid placement
  (e.g. a BB needing egress placed in a `public` subnet). `finalizeVpc` now resolves
  whether the runtime's placement actually provides egress — from the selected
  subnets, not a guessed role — and validates `requiresEgress` against that. When
  egress can't be determined (e.g. an imported VPC whose subnets aren't known at
  synth) it warns rather than fabricating a pass/fail. `bb-distributed-data` (DSQL)
  now declares `requiresEgress: true`.

  **SSM interface endpoint is no longer always provisioned.** Only `AppSetting` and
  the auth blocks (which compose `AppSetting`) use SSM, so it now flows from Building
  Block requirements. An app that uses neither no longer pays for an unused interface
  endpoint. CloudWatch Logs stays always-on (every in-VPC Lambda needs it for log
  delivery).

  **The S3 gateway endpoint is now always provisioned.** The runtime pulls config,
  secrets, and migrations from S3 at cold start. Gateway endpoints are free
  (route-table entries, no ENI), so this closes a real cold-start access gap at no
  cost.

- 302090a: Local dev server: handle raw-socket errors during the WebSocket upgrade instead of crashing.

  The `upgrade` handlers routed the HTTP upgrade without attaching an `'error'` listener to the raw `net.Socket` first. A stale WebSocket client that reset its connection inside the upgrade window emitted ECONNRESET on a socket with no handler, so Node's default unhandled-`'error'` behaviour killed the dev server process right after port bind. Both upgrade paths now attach `socket.on('error', () => socket.destroy())` as their first statement, the HTTP server answers malformed/aborted requests via a `clientError` handler, and the `noServer` `WebSocketServer` logs server-level errors rather than throwing. The fix is scoped to the vulnerable socket — a genuine error anywhere else still crashes as before.

- Updated dependencies [7b86b8e]
- Updated dependencies [4342149]
- Updated dependencies [e2c3c62]
- Updated dependencies [2806ae2]
- Updated dependencies [f552ebe]
- Updated dependencies [9aa0814]
- Updated dependencies [012cd89]
- Updated dependencies [81609a8]
- Updated dependencies [5eee114]
- Updated dependencies [d7312f9]
- Updated dependencies [d7312f9]
- Updated dependencies [21443ba]
- Updated dependencies [acd1628]
- Updated dependencies [6496713]
- Updated dependencies [bd67438]
- Updated dependencies [a47d71c]
- Updated dependencies [0385f7e]
- Updated dependencies [daf523a]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [302090a]
  - @aws-blocks/bb-auth-oidc@0.2.0
  - @aws-blocks/bb-app-setting@0.3.0
  - @aws-blocks/bb-dashboard@0.2.0
  - @aws-blocks/bb-distributed-data@0.2.0
  - @aws-blocks/core@0.5.0
  - @aws-blocks/hosting@0.3.1
  - @aws-blocks/bb-kv-store@0.2.0
  - @aws-blocks/auth-common@0.1.8
  - @aws-blocks/bb-agent@0.4.1
  - @aws-blocks/bb-async-job@0.2.1
  - @aws-blocks/bb-auth-basic@0.1.9
  - @aws-blocks/bb-auth-cognito@0.1.10
  - @aws-blocks/bb-cron-job@0.2.1
  - @aws-blocks/bb-data@0.3.0
  - @aws-blocks/bb-distributed-table@0.2.0
  - @aws-blocks/bb-email-client@0.1.7
  - @aws-blocks/bb-file-bucket@0.2.1
  - @aws-blocks/bb-knowledge-base@0.2.4
  - @aws-blocks/bb-lambda-compute@0.5.0
  - @aws-blocks/bb-logger@0.2.0
  - @aws-blocks/bb-metrics@0.1.7
  - @aws-blocks/bb-realtime@0.2.1
  - @aws-blocks/bb-tracer@0.2.0

## 0.5.0

### Minor Changes

- 9111c0c: feat(bb-agent): cap model and tool calls per turn to bound runaway cost

  Adds two per-turn safety caps to `AgentConfig`, both defaulting to `20`:

  - `maxLlmCalls` — the maximum number of model (Bedrock) invocations in a single
    turn. Model calls are the unit Bedrock bills for, so this is the most direct
    guard against an agent that loops its reason→act cycle indefinitely; because
    every tool round needs a model call, it transitively bounds tool loops too.
  - `maxToolIterations` — the maximum number of tool calls in a single turn
    (parallel tool batches count each call).

  When either cap is exceeded the turn is cancelled and the client receives an
  `error` chunk (so `complete()` rejects) instead of `done`. Both caps are
  enforced with in-loop Strands hooks, so they work identically on every compute
  target with no cross-process signaling.

  Behavior change: turns are now capped at 20 model calls and 20 tool calls by
  default. This is generous for a single turn, but agents that legitimately reason
  over many steps or chain many tools must raise `maxLlmCalls` /
  `maxToolIterations`, or set a cap to `false` to disable it. The caps bound call
  _count_, not tokens or wall-clock — pair them with a billing or CloudWatch alarm
  on Bedrock spend for real cost protection.

  This is a `minor` bump. Every package here is pre-1.0, where `minor` is this
  repo's signal for a change that can alter existing behavior. The two options are
  new and optional and there's an opt-out (raise the cap, or set it to `false`),
  but the new default changes the runtime behavior of every existing agent — a
  turn that legitimately exceeds 20 model or tool calls is now cut off unless the
  customer opts out — so it ships as `minor` rather than `patch` to surface that
  clearly. The counts cover a whole logical turn: they live in the agent's
  persisted session state, and the per-turn reset is keyed on a turn id applied
  lazily (the session snapshot is restored inside `stream()`, so an up-front reset
  would be overwritten and the budget would leak into the next turn), so a turn
  paused on a human-in-the-loop interrupt keeps its budget across `resume()` while
  a new message always starts a fresh one. A cap value must be a positive integer
  or `false`; anything else throws `InvalidModelConfigException`. The umbrella
  `@aws-blocks/blocks` gets the same bump because it re-exports `AgentConfig`.

- c45eb92: Extend stack-wide `BlocksDefaults` (introduced in the Infrastructure Options work) with three additive fields, and adopt them across the Blocks-managed infrastructure. Each field is read independently via `option ?? scope.defaults.field` — a per-block option always wins, and no field is derived from another.

  `@aws-blocks/core/cdk` now adds to `BlocksDefaults` (and both `BlocksPresets`):

  - `logRetention: RetentionDays` — how long Blocks-managed CloudWatch log groups keep events. Preset sandbox `ONE_WEEK`, production `ONE_YEAR`.
  - `throttling: { rateLimit, burstLimit }` — request-rate limits applied to every Blocks API Gateway stage. Preset sandbox `200 / 400`, production `1000 / 2000`.
  - `accessLogging: boolean` — structured JSON access logs on every Blocks API Gateway stage. **Off by default in both presets** (opt-in), because enabling it mutates the account/region-level API Gateway CloudWatch role singleton.

  Also newly exported from `@aws-blocks/core/cdk`: the `BlocksThrottling` type and `ensureApiGatewayAccount()` (provisions the account-level API Gateway CloudWatch Logs role once per stack). `Scope` gains a `handlerLogGroup` getter for the shared handler log group.

  **Log retention** — Blocks-managed log groups now follow `defaults.logRetention` instead of AWS's infinite default: the shared handler Lambda (now owned by `BlocksStack`/`BlocksBackend` as `scope.handlerLogGroup`), the `bb-distributed-table` GSI-manager Lambdas, the `bb-distributed-data` DSQL migration Lambda, the `bb-data` Aurora migration Lambda, and the `bb-app-setting` secret-init Lambda. `bb-logger` reconfigures the shared handler group's retention — **only when an explicit per-Logger `retention` is set** (a bare `Logger` no longer writes it back, so it can't clobber another Logger's value) — rather than creating its own `/aws/lambda/<fn>` group. (Note: the framework `custom-resources.Provider` Lambdas these BBs wrap still use AWS's default retention — the L2 `Provider` exposes no log-group/retention override.)

  **Throttling** — applied to the core REST API stage and the `bb-realtime` WebSocket stage. On a WebSocket stage the throttle unit is messages/second across the connection.

  **Access logging** — when enabled, each stage writes structured JSON access logs to a dedicated CloudWatch log group (retention = `defaults.logRetention`, removal policy = `defaults.removalPolicy` so production **RETAIN**s the audit trail on teardown). The account-level API Gateway CloudWatch Logs role is provisioned once per stack and shared across stages.

  **⚠️ Behavior changes on upgrade:**
  - **Throttling now caps the core REST API and WebSocket stages.** Before this change these stages had no stage-level throttle (they ran at the API Gateway account default, ~10k rps). After upgrade, sandbox is capped at 200 rps / 400 burst and production at 1000 rps / 2000 burst. Apps serving above the production ceiling will see `429`s — raise it with a per-stack `throttling` override (`defaults: { ...BlocksPresets.production, throttling: { rateLimit, burstLimit } }`).
  - **The shared handler Lambda log group changes.** The handler previously logged to Lambda's auto-created `/aws/lambda/<fn>` group (infinite retention); it now logs to a framework-owned group with the default retention. On upgrade the old auto group is left orphaned in CloudWatch (unmanaged, still infinite) — delete it manually if you want its history/cost gone. Likewise a `bb-logger`-created retention group from a prior version is replaced.
  - **Access logging** is **opt-in (off in both presets)**. When enabled it requires the account-level API Gateway CloudWatch Logs role — an account/region-level singleton, so enabling it is safe for **one Blocks stack per region** (see `ensureApiGatewayAccount()` for the multi-stack teardown caveat). It defaults off (rather than on for production) so an upgrade never mutates that account-wide singleton without an explicit opt-in.
  - **`BlocksDefaults` gains three required fields** (`logRetention`, `throttling`, `accessLogging`). Apps that spread a `BlocksPresets` preset (the documented path) are unaffected; code that hand-rolls a literal `BlocksDefaults` object will need to add the new fields to compile.

  `bb-dashboard` now points its log widgets at the framework-owned handler log
  group (`scope.handlerLogGroup.logGroupName`) instead of reconstructing
  `/aws/lambda/<fn>` — the handler now writes to a dedicated group with a
  CDK-generated name, so the old convention would leave the "Recent Errors" /
  "Log Volume" widgets querying an empty group.

  Hosting adoption of these defaults (SSR REST API + compute log groups) ships in a separate change.

- 4a830a6: feat: route event-block resources to their resolved compute

  AsyncJob, CronJob, and Realtime now attach their compute-bound resources to a
  compute resolved at synth rather than the stack's shared handler:

  - AsyncJob attaches its SQS event source to the resolved compute's function;
  - CronJob points its EventBridge Scheduler target at the resolved compute's function;
  - Realtime binds its shared WebSocket API integrations to the stack's **default**
    compute (its routes are a stack-level singleton) and grants `postToConnection`
    to the shared execution role, so `publish()` works from any compute.

  Each block requires a Lambda compute today and fails at synth with a typed
  `UnsupportedCompute` error (assertable via `isBlocksError`) on any other type.
  The check uses a duplicate-copy-safe brand (`LambdaCompute.isLambdaCompute`,
  backed by a `Symbol.for` marker) instead of `instanceof`, so it does not misfire
  when two copies of `bb-lambda-compute` resolve in one dependency tree.

  On the default single-Lambda setup the resolved/default compute is the stack's
  default, whose function is the shared handler — so this is non-breaking with no
  change to synthesized infrastructure. AsyncJob also grants SQS send to the shared
  execution role rather than the handler directly.

  New public surface (hence `minor`):

  - `@aws-blocks/core` exports `blocksError(name, message)` (the producer half of
    the `isBlocksError` contract) and `sanitizeConfigKey(id)` from `./bb-utils`
    (the single env-var-key sanitizer both config writers and runtime readers use).
  - `@aws-blocks/bb-lambda-compute` adds a `./cdk` subpath exposing the CDK-typed
    `LambdaCompute` and its `LambdaCompute.isLambdaCompute` guard.
  - `bb-async-job` / `bb-cron-job` / `bb-realtime` add an `UnsupportedCompute`
    error member.

  `@aws-blocks/bb-agent` builds AsyncJob and Realtime internally, so its CDK test
  moves onto the `BlocksStack.create` harness instead of a handler-only stub.
  Test-only change — no runtime behavior change to the Agent.

- f2f186c: fix(hosting): DeleteOldBuilds no longer expires the build that is currently served (#480)

  The `DeleteOldBuilds` S3 lifecycle rule expired every object under `builds/`
  after `buildRetentionDays` (default 30), including the build that CloudFront KVS
  `meta.b` currently points to. An app that did not deploy within the retention
  window had its live build's objects expired out from under an otherwise-healthy
  stack — the router kept rewriting to the now-empty prefix, so every static path
  returned 403 (hosting ≤ 0.1.4) or 404 (≥ 0.1.5) while the API path stayed 200.
  Recovery required a redeploy.

  **Fix.** The lifecycle rule now matches only objects tagged
  `aws-blocks:build-state=superseded`. At the KVS cutover, after the pointer flips
  to the new build, the cutover handler tags the _outgoing_ build's objects
  superseded (best-effort; list + tag/untag only — the handler is granted **no** S3
  delete-object permission). The live build is never tagged, so it is never expired,
  regardless of deploy cadence. Superseded builds are still cleaned up after
  `buildRetentionDays`. S3 lifecycle `TagFilters` are inclusion-only (there is no
  "NOT tagged" predicate), which is why the superseded build is tagged rather than
  the live build excluded.

  **Rollback-safety hardening.** The same cutover also _clears_ the build-state tag
  on the _incoming_ build's objects, symmetric to tagging the outgoing one. Without
  this, a rollback that re-points `meta.b` back to a retained build that was tagged
  superseded by an earlier cutover would hand the now-live build to
  `DeleteOldBuilds` — #480 again. Clearing is best-effort and uses
  `s3:DeleteObjectTagging` (tags only, never objects).

  **`buildRetentionDays` is now configurable from `@aws-blocks/core`.** Previously
  `HostingProps` dropped it (only `retainOnDelete` was forwarded), so the only way
  to change retention was an L1 bucket override. It now flows through to the
  hosting bucket lifecycle rule. Must be at least `skewProtection.maxAge`
  (converted to days) or synth throws `InvalidSkewProtectionMaxAgeError`, as
  before.

  **New advisory guard.** An optional `storage.deployIntervalDays` hint emits a
  synth-time **warning** (never an error) when the deploy cadence is at or beyond
  `buildRetentionDays`, i.e. when superseded builds could age out before the next
  deploy and shrink the rollback window. The live build is unaffected, so this is
  a rollback-window note, not a correctness gate.

  Pre-1.0 `minor` per this repo's convention: the change alters the synthesized
  lifecycle rule and the `KvKeys` custom resource (a benign in-place bucket-config
  - Lambda-role update on the next deploy; no bucket replacement), and adds a new
    IAM grant (`s3:ListBucket` + `s3:PutObjectTagging` + `s3:DeleteObjectTagging`,
    scoped to `builds/*`) to the
    cutover handler. Build artifacts uploaded before the upgrade carry no
    `build-state` tag and are therefore never expired by the new rule — including
    the live build — so the upgrade cannot delete a running build; from the next
    deploy onward each superseded build is tagged and reclaimed normally.

- 46b7c89: Generate the local `aws-blocks` package's client entry point on fresh checkouts, under the correct export conditions.

  The templates declare `./client.js` as the package's `browser`/`import` entry and gitignore it as generated, so a scaffold built on any machine other than the one that scaffolded it failed to resolve the package, and `cdk synth` failed with it (the Hosting block builds the frontend during synthesis).

  `@aws-blocks/blocks` gains a `blocks-generate-client` bin (mirroring `blocks-generate-spec` and `blocks-vendorize`) that spawns the core generator worker with `--conditions=aws-runtime`, so the emitted client imports `aws-middleware` rather than `mock-middleware` regardless of how the hook is invoked. `@aws-blocks/core` exports the existing `generate-client-worker` subpath so the bin can resolve it. The templates wire `"prebuild": "blocks-generate-client"` (including `backend`, where the hook is dormant until a `build` script exists) and gitignore `.hosting/`, the Vite output written during synthesis.

- 2cb9d74: refactor(bb-agent): remove inert `structuredOutput` field from `AgentConfig`

  `AgentConfig` declared `structuredOutput?: z.ZodType`, but the field was never
  implemented, read, or consumed anywhere — no JSDoc, no consumer, no docs, no
  tests. It advertised a capability that does not exist, so setting it was a silent
  no-op. The declaration is removed (along with its line in the generated
  `API.md` report); no runtime behavior changes, because nothing ever read it.

  Structured output remains a planned future LLM-BB feature, tracked separately.
  This change only deletes the dead placeholder surface — it does not add or design
  any real structured-output support.

  This is a `minor` bump. Removing a property from an exported interface is a
  breaking change to the public type surface, but every package here is pre-1.0,
  where this repo's convention is that `minor` — not `major` — is the signal for a
  breaking or behavior-altering change (see the `maxLlmCalls`/`maxToolIterations`
  caps, which shipped as `minor` for exactly that reason). Practically the blast
  radius is a compile error only: code that set `structuredOutput` was already
  getting no-op behavior, so the error points at configuration that never did
  anything and the fix is to delete it. The umbrella `@aws-blocks/blocks` gets the
  same bump because it re-exports `AgentConfig`.

### Patch Changes

- fe0f04a: fix(blocks): drop `jobQueueUrl` from the `Agent` `getSdkIdentifiers` overload

  The Agent BB no longer runs its loop on an internal AsyncJob (it moved to a Bedrock AgentCore Runtime),
  so it no longer registers a `jobQueueUrl` identifier. The umbrella `getSdkIdentifiers(agent)` overload
  still declared it, promising a field that resolves to `undefined` at runtime. Remove it; the overload
  now returns only `conversationsTableName`, `messagesTableName`, `sessionBucketName`, `realtimeWsUrl`,
  and `realtimeCallbackUrl`.

- 585feea: Document AuthCognito setAuthState error-state semantics, including retriable challenge failures and CodeMismatch handling.
- 64ddd74: refactor(core): retarget the config registry to the shared role and every compute

  `finalizeConfigRegistry` no longer takes a single handler function. It now takes
  the owning construct plus the shared execution role and the stack's computes
  (`finalizeConfigRegistry(root, executionRole, computes)`) and:

  - grants `s3:GetObject` on the config object **once to the shared execution
    role** instead of to one function's role, so every compute that assumes the
    role can read it; and
  - stamps `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY` on **every compute** via
    `compute.setEnv(...)` rather than on a single hardcoded handler.

  Adds a per-stack compute registry (`registerCompute` / `getComputes`): computes
  self-register on their owning stack in the `Compute` base constructor (state
  keyed on the stack, resolved via `cdk.Stack.of()`, like the config registry), so
  a multi-stack synth keeps each stack's computes isolated. `create()` reads the
  registry directly via `getComputes(stack)`.

  Behavior-preserving for the default single-compute app: the same config object
  is written to S3, the same two coordinates reach the runtime, and the same
  `s3:GetObject` permission is available — now via the shared role. Internal
  refactor; no public API or runtime-config-loading change.

- 165093b: `CronJob`: validate the schedule (and timezone) at synth so an invalid expression fails fast instead of after minutes of deploy.

  The CDK layer passed `schedule`/`timezone` straight into the EventBridge `CfnSchedule` with no validation, so an invalid expression — e.g. `rate(10 seconds)` (EventBridge's minimum is 1 minute) or a malformed `cron(...)` — passed `cdk synth` and was only rejected by EventBridge minutes into provisioning. The mock already validated these, so local dev and deploy diverged.

  The schedule parser and timezone check are now a shared `schedule` module used by both the mock and the CDK construct. `CronJob`'s constructor validates up front and throws `CronJobErrors.InvalidSchedule` / `CronJobErrors.InvalidTimezone` at synth, before any infrastructure is created.

  The synth gate is deliberately lenient for `cron(...)` — it checks the 6-field shape and defers field-level semantics (`L`/`W`/`#`, year fields, named days) to EventBridge — so it never rejects an advanced-but-valid schedule. The local mock, which must actually simulate the schedule, still can't model those forms; it now throws the new `CronJobErrors.ScheduleNotSupported` (rather than `InvalidSchedule`) for them, so local dev doesn't call a deployable schedule "invalid". No behavior change for valid, mock-supported schedules.

- 8de4a56: `DistributedTable` mock: order GSI sort-key ties deterministically to match DynamoDB.

  When a GSI sort key was shared by multiple items, the mock's `query` fell back to Map insertion order for the tied rows — so results depended on write order / disk-reload order and diverged from deployed behavior. The mock now tie-breaks on the base-table primary key (partition key, then sort key), matching DynamoDB's observed ordering for index rows with equal sort keys, and reverses the whole order (ties included) under `order: 'desc'`. AWS doesn't document a contractual guarantee for the tie order, so the mock is intentionally deterministic even where DynamoDB's contract is unspecified. No change for unique sort keys.

- Updated dependencies [9111c0c]
- Updated dependencies [fe0f04a]
- Updated dependencies [1b66571]
- Updated dependencies [d8a3901]
- Updated dependencies [585feea]
- Updated dependencies [64ddd74]
- Updated dependencies [df667c5]
- Updated dependencies [df667c5]
- Updated dependencies [64ddd74]
- Updated dependencies [df667c5]
- Updated dependencies [646614b]
- Updated dependencies [165093b]
- Updated dependencies [ed158cf]
- Updated dependencies [c45eb92]
- Updated dependencies [8de4a56]
- Updated dependencies [4a830a6]
- Updated dependencies [f2f186c]
- Updated dependencies [46b7c89]
- Updated dependencies [1da58fd]
- Updated dependencies [4b74c7f]
- Updated dependencies [2cb9d74]
- Updated dependencies [1da58fd]
  - @aws-blocks/bb-agent@0.4.0
  - @aws-blocks/bb-file-bucket@0.2.0
  - @aws-blocks/bb-auth-cognito@0.1.9
  - @aws-blocks/bb-knowledge-base@0.2.3
  - @aws-blocks/core@0.4.0
  - @aws-blocks/bb-cron-job@0.2.0
  - @aws-blocks/bb-data@0.2.7
  - @aws-blocks/bb-logger@0.1.6
  - @aws-blocks/bb-realtime@0.2.0
  - @aws-blocks/bb-distributed-table@0.1.7
  - @aws-blocks/bb-distributed-data@0.1.8
  - @aws-blocks/bb-app-setting@0.2.1
  - @aws-blocks/bb-dashboard@0.1.5
  - @aws-blocks/bb-lambda-compute@0.4.0
  - @aws-blocks/bb-async-job@0.2.0
  - @aws-blocks/hosting@0.3.0
  - @aws-blocks/auth-common@0.1.7
  - @aws-blocks/bb-auth-basic@0.1.8
  - @aws-blocks/bb-auth-oidc@0.1.10
  - @aws-blocks/bb-email-client@0.1.6
  - @aws-blocks/bb-kv-store@0.1.8
  - @aws-blocks/bb-metrics@0.1.6
  - @aws-blocks/bb-tracer@0.1.8

## 0.4.0

### Minor Changes

- 08ab129: Add `pointInTimeRecovery: boolean | { retentionDays: number }` to `BlocksDefaults` (and to `BlocksPresets`: `true` in `production`, `false` in `sandbox`).

  This extends the stack-wide infrastructure-defaults posture with the continuous-backup knob, so a Building Block whose service supports it (DynamoDB Point-in-Time Recovery) can resolve its default from `scope.defaults.pointInTimeRecovery` — read independently, the same way as `removalPolicy` and `deletionProtection`. `true` enables backups with the service default window, `false` disables them, and `{ retentionDays: n }` pins the window (the block validates `n` against its service's range) — on/off and window are one field since a window only means anything when backups are on. Blocks whose service has no equivalent simply ignore it. `bb-distributed-table` is the first consumer.

  > The property **name** (`pointInTimeRecovery`) and its `{ retentionDays }` shape are a public `@aws-blocks/core/cdk` surface addition and want API-BR sign-off before release.

### Patch Changes

- 1ff9d03: `AppSetting`: support a customer-managed KMS key for secrets via `kmsKeyArn`.

  Secret (`SecureString`) parameters were always encrypted with the default `aws/ssm` AWS-managed key, so their decrypt scope couldn't be controlled (e.g. for cross-account access or a dedicated key policy). Passing `kmsKeyArn` (also accepted by `AppSetting.fromExisting`) now encrypts the secret with that customer-managed key:

  - the bulk-init Custom Resource creates the parameter with the CMK (`KeyId`);
  - the shared handler is granted `kms:Decrypt`/`Encrypt` scoped to that specific key ARN (instead of the `aws/ssm` `ViaService` wildcard);
  - the runtime `put()` re-specifies the key on overwrite so it doesn't silently fall back to `aws/ssm`;
  - adding/changing/removing `kmsKeyArn` on an already-deployed secret re-encrypts its current value under the new key at deploy time, so decryption keeps working after a key rotation.

  `kmsKeyArn` is only valid with `secret: true` and must be a non-empty ARN. The default (no `kmsKeyArn`) is unchanged.

- 5798492: feat(bb-async-job): batch SQS messages by default, with a configurable batching window

  `AsyncJob` triggered its Lambda with `batchSize: 1`, so every queued job cost a
  full invocation. The default is now `batchSize: 10` with a new
  `maxBatchingWindowSeconds` option (0–300, default 5) that trades latency for
  fuller batches. SQS partial batch failure reporting is always enabled, so only
  the failed records of a batch are redelivered.

  Both options are now range-checked in the `AsyncJob` constructor, so an
  out-of-range value fails fast at synth time with `InvalidOptionException` naming
  the option instead of surfacing as an opaque CloudFormation error mid-deploy:
  `batchSize` must be 1–10 without a batching window (1–10000 with one), and
  `maxBatchingWindowSeconds` must be 0–300.

  Retry semantics are unchanged. SQS tracks `ApproximateReceiveCount` per message
  and partial batch responses redeliver only failed records, so `maxRetries` still
  means "attempts for this message" and the DLQ `maxReceiveCount` keeps its
  meaning at any batch size.

  This is a `patch` bump. Every package here is pre-1.0, where a `minor` bump is
  this repo's signal for a breaking change; this change is not breaking — the new
  default is a behavior change with an opt-out (`batchSize: 1` /
  `maxBatchingWindowSeconds: 0`), and both options are new and optional. The
  umbrella `@aws-blocks/blocks` gets the same bump because it re-exports
  `AsyncJob` and `AsyncJobOptions`.

  `@aws-blocks/core/cdk` now exports `SHARED_HANDLER_TIMEOUT_SECONDS`, the shared
  handler Lambda's timeout, so resources that must size their own timeouts against
  it stop re-hardcoding `900`.

  The main queue's visibility timeout is now `SHARED_HANDLER_TIMEOUT_SECONDS + maxBatchingWindowSeconds`
  seconds instead of a flat `900`. A message becomes invisible when the poller
  receives it, before the batching window elapses and before the handler runs, so
  a flat 900s let SQS redeliver a message whose invocation was still running.

  `bb-agent` opts out of the new defaults with `batchSize: 1` and
  `maxBatchingWindowSeconds: 0`. It submits an internal job per interactive agent
  turn (plus a second on HITL resume) and the caller is blocked on that job
  starting, so a batching window would add up to 5s of latency to a human-facing
  path; `batchSize: 1` also keeps one failing turn from sharing a batch with
  others, which matters because the handler is not idempotent. Both the runtime
  and CDK construction sites set the same options so they synthesize an identical
  event source mapping.

- ca8cfb6: feat(bb-async-job): submitBatch auto-chunks batches larger than SQS limits

  `submitBatch` previously rejected any batch over 10 payloads with
  `BatchTooLarge`, so a caller with more than 10 jobs had to reimplement SQS's
  chunking rules by hand. It now accepts up to 10,000 payloads and packs them
  into `SendMessageBatch` requests bounded by both SQS per-request limits — at
  most 10 entries and at most 256 KB of aggregate message body — sent with
  bounded concurrency (at most 5 requests in flight) rather than one long serial
  loop. Each batch entry's `Id` is the payload's original index, so the returned
  `jobIds` stay in input order and every id is the same SQS `MessageId` that
  `getStatus()` / `waitUntilComplete()` look up. `BatchTooLarge` is now thrown
  only when a batch exceeds the 10,000-payload soft cap — a guardrail against a
  single call fanning out to an unbounded number of SQS requests.

  A batch spanning multiple chunks is **not atomic**: an earlier chunk can land
  before a later one fails. The all-or-nothing signal is unchanged — a partial
  failure still throws `BatchSubmitFailed` — but the thrown error (now a typed
  `BatchSubmitFailedError`) reflects the partial reality across all chunks:
  `.jobIds` carries the real `MessageId` for every entry that made it onto the
  queue (with `null` at each failed index) and `.failed[]` lists every failure
  sorted by index, so a caller can retry only the failed indexes instead of
  re-submitting the whole batch. Two failure kinds feed `.failed[]`: an
  entry-level rejection is scoped to its index, while a transport-level `send()`
  rejection (throttling, connection, auth) fails that whole chunk and
  short-circuits the chunks not yet started (`code: 'BatchSubmitAborted'`) instead
  of hammering an unhealthy endpoint. An entry SQS returns in neither list becomes
  a `MissingResult` failure so a `null` id never escapes as a success.

  On full success the `trackStatus` write is now best-effort — a failure recording
  `queued` (e.g. DynamoDB throttling on a large fan-out) is logged rather than
  thrown, since the handler backfills the record anyway; otherwise a bookkeeping
  error would make a caller re-submit an already-enqueued batch. `recordQueuedBatch`
  also issues its conditional writes in groups of 25 (mirroring `BatchWriteItem`)
  rather than one unbounded `Promise.all`.

  The mock runtime submits one message at a time and never partially fails, so the
  transport/abort paths are AWS-only; it enforces the same soft cap and validates
  every payload before enqueuing any, matching the AWS runtime.

  This is a `patch` bump: pre-1.0, this repo uses `minor` to signal a breaking
  change, and this is not breaking — a batch of ≤10 behaves exactly as before, no
  public type changed (`BatchSubmitFailedError` is additive), and the previous
  `BatchTooLarge` threshold simply moved from 10 to 10,000. `@aws-blocks/blocks`
  gets the same bump because it re-exports `AsyncJob`.

- f00adb0: feat(core): resolve `Scope.compute`; the default compute owns the handler + gateway

  Add a `Scope.compute` getter that resolves the compute a block runs on: the
  nearest `_compute` assigned on the block or an ancestor scope, else the owning
  stack/backend's default compute.

  The default is a `LambdaCompute` that now **owns** the Lambda function + API
  Gateway. `setupBlocksInfra` no longer creates them; `BlocksStack` /
  `BlocksBackend` expose `handler` / `gateway` / `apiUrl` as getters that delegate
  to the default compute. The compute is created in `create()` before the backend
  module is imported, so a block reading `this.compute` in its constructor
  resolves to it. `_compute` is internal (no public option yet).

  Core no longer imports a concrete compute: `create()` requires a
  `defaultComputeFactory` on its props (`CoreBlocksStackProps` /
  `CoreBlocksBackendProps` — the public `BlocksStackProps` / `BlocksBackendProps`
  plus that factory) and calls it to build the default. The umbrella
  `@aws-blocks/blocks` supplies `LambdaCompute` by spreading the factory onto the
  props in a thin `create()` wrapper, so apps built on `@aws-blocks/blocks` are
  unaffected — their call site is unchanged.

  **Breaking (direct `@aws-blocks/core` consumers only):** core no longer provides
  a built-in default compute. `BlocksStack.create()` / `BlocksBackend.create()`
  now require a `defaultComputeFactory` field on the props (typed
  `CoreBlocksStackProps` / `CoreBlocksBackendProps`); props without it no longer
  type-check (and it throws at synth if forced). This break is inherent to moving
  the Lambda + API Gateway out of core — it is not specific to how the factory is
  passed. Migrate by either:

  - using `@aws-blocks/blocks` (`import { BlocksStack } from '@aws-blocks/blocks/cdk'`),
    which injects a Lambda default for you — the recommended path; or
  - supplying your own factory on the props:
    `BlocksStack.create(scope, id, { ...props, defaultComputeFactory: (root) => new LambdaCompute(root, 'DefaultCompute') })`,
    which requires depending on `@aws-blocks/bb-lambda-compute` and the internal
    `@aws-blocks/core/cdk/internal` types.

  **Resource replacement on redeploy:** because the Lambda function and API
  Gateway now live under the default compute's construct path
  (`.../DefaultCompute/...`), their CloudFormation logical IDs change, so a
  redeploy **replaces** the function + API Gateway and the API URL changes. These
  are internal resources, not a customer-facing contract. Any consumer with an
  already-deployed stack — in particular an Amplify Gen2 frontend wired to the
  current API Gateway URL (this repo carries a Gen2 nested-stack regression test,
  so Gen2 integration is real) — should confirm they can absorb a URL change
  before upgrading.

- de4f209: `KnowledgeBase.retrieve`: validate `maxResults` consistently across the mock and AWS runtimes.

  `maxResults` was normalized with `Math.min(Math.max(v ?? 10, 1), 100)`, which silently passed fractional and non-finite values (`1.5`, `NaN`, `Infinity`) straight through — the mock and the AWS `RetrieveCommand` then diverged, and Bedrock rejects a non-integer `numberOfResults`. A new shared `normalizeMaxResults` helper (used by both runtimes) keeps the documented clamp for finite integers and now rejects fractional/non-finite values up front with `KnowledgeBaseErrors.ValidationError`, before any search or Bedrock request.

  Fixes #430.

- f00adb0: `LambdaCompute`: default the function to **arm64 (AWS Graviton)**.

  The compute's Lambda now defaults to `Architecture.ARM_64` instead of CDK's `x86_64` default. arm64 Lambda is ~20% cheaper per GB-second than x86_64 at equivalent performance. Because `LambdaCompute` is the default compute for every `@aws-blocks/blocks` app, the shared handler runs on Graviton out of the box.

  The framework's own Building Blocks are pure-JavaScript esbuild bundles with no architecture-specific native code, so the switch is transparent for them. A backend `entry` bundle is the customer's own handler plus whatever they import, though — so an app that bundles an **x86-only native dependency** into its backend should be aware of the default. There is no per-app override yet; a customer-facing way to pin the architecture (`architecture` on `LambdaComputeProps` is present but internal for now) will be exposed alongside the public compute-configuration surface.

  > **Behavior change on next deploy:** the handler function's architecture is `arm64` (an in-place update on an existing function).

- 27346f3: Make AuthOIDC `requireAuth()` throw `ApiError(401, NotAuthenticatedException)` so the documented `handle401()` 401-redirect pattern works for a signed-out protected call.

  Previously `requireAuth()` threw a bare `Error` with no `status`. Over the JSON-RPC boundary `errorResponseFromCatch` serializes a non-`ApiError` as code `500`, so the client received an `ApiError` with `status === 500`. The README's `if (handle401(e, provider)) return;` helper only acts on `err instanceof ApiError && err.status === 401`, so it never matched and the app never redirected to sign-in — the error just surfaced. This aligns AuthOIDC with AuthCognito, whose `requireAuth()` already throws `ApiError(401, …)`. The error name is preserved, so existing `isBlocksError(e, AuthOIDCErrors.NotAuthenticated)` checks are unaffected.

- 5bfae0a: Reject oversized JSON-RPC request bodies at the shared parser. `parseRpcRequest` now caps the body at 10 MiB (`MAX_RPC_BODY_BYTES`, the same limit API Gateway enforces in production) and returns a `413` error named `PayloadTooLarge` before parsing or dispatch. In production API Gateway rejects an oversized body at the edge before the Lambda runs; enforcing the same limit at the parser means the local dev server rejects the same body instead of buffering it and wedging the local database (e.g. PGlite). Because both the Lambda handler and the dev server route through this one parser, the cap lives in a single place, and `decodeRpcResponse` surfaces it client-side as `ApiError.status === 413`.
- 0ac3879: `sandbox` / `deploy`: fail fast with an actionable message when AWS credentials are missing or expired.

  Both commands previously spent ~10 seconds synthesizing the CDK app before the first AWS call, so an unconfigured or expired credential surfaced only afterwards — as an opaque CDK/CloudFormation error that didn't name the real cause. `startSandbox` and `deploy` now run a bounded STS `GetCallerIdentity` check up front and, on a real credential error (missing/expired/invalid), exit immediately with guidance (`aws configure` / `aws sso login`, `AWS_PROFILE`, or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) instead of wasting the synth.

  The check is deliberately conservative: it only blocks on a genuine credential error (surfacing the SDK error _name_, never the raw message, which can embed an ARN/account id); a network or service error warns and lets the deploy proceed; and it skips (with a warning) when no region is set in `AWS_REGION` / `AWS_DEFAULT_REGION`, rather than guessing a region in the wrong partition (GovCloud/China). The scaffolded `sandbox` template entrypoint now `.catch`es and exits cleanly, matching `deploy`, so the guidance prints without an unhandled-rejection stack trace.

- Updated dependencies [1ff9d03]
- Updated dependencies [5798492]
- Updated dependencies [ca8cfb6]
- Updated dependencies [08ab129]
- Updated dependencies [f00adb0]
- Updated dependencies [f00adb0]
- Updated dependencies [309a236]
- Updated dependencies [08ab129]
- Updated dependencies [9d4ccea]
- Updated dependencies [de4f209]
- Updated dependencies [f00adb0]
- Updated dependencies [27346f3]
- Updated dependencies [5bfae0a]
- Updated dependencies [0ac3879]
- Updated dependencies [e4dac4a]
- Updated dependencies [9bd5b3e]
  - @aws-blocks/bb-app-setting@0.2.0
  - @aws-blocks/core@0.3.0
  - @aws-blocks/bb-async-job@0.1.5
  - @aws-blocks/bb-agent@0.3.5
  - @aws-blocks/bb-distributed-table@0.1.6
  - @aws-blocks/bb-lambda-compute@0.3.0
  - @aws-blocks/bb-kv-store@0.1.7
  - @aws-blocks/bb-file-bucket@0.1.5
  - @aws-blocks/bb-data@0.2.6
  - @aws-blocks/bb-knowledge-base@0.2.2
  - @aws-blocks/bb-email-client@0.1.5
  - @aws-blocks/bb-auth-cognito@0.1.8
  - @aws-blocks/bb-auth-oidc@0.1.9
  - @aws-blocks/bb-distributed-data@0.1.7
  - @aws-blocks/hosting@0.2.0
  - @aws-blocks/bb-auth-basic@0.1.7
  - @aws-blocks/bb-realtime@0.1.5
  - @aws-blocks/auth-common@0.1.6
  - @aws-blocks/bb-cron-job@0.1.5
  - @aws-blocks/bb-dashboard@0.1.4
  - @aws-blocks/bb-logger@0.1.5
  - @aws-blocks/bb-metrics@0.1.5
  - @aws-blocks/bb-tracer@0.1.7

## 0.3.1

### Patch Changes

- 448a47c: fix(bb-lambda-compute): add package metadata, prebuild, and pin dependency ranges

  Bring `@aws-blocks/bb-lambda-compute`'s package.json in line with its siblings:

  - add the `repository` / `homepage` / `bugs` blocks. Without `repository.url`,
    provenance publishing fails with `E422 … "repository.url" is ""` because npm
    cannot match the package against the sigstore attestation's source repo;
  - add the `prebuild` version-generation script (`generate-version.mjs`);
  - pin `@aws-blocks/core` to `^0.2.0` instead of `*`, matching every other
    package.

  Also pin the umbrella `@aws-blocks/blocks`'s dependency on
  `@aws-blocks/bb-lambda-compute` to `^0.2.0` instead of `*`, now that the package
  publishes a real version.

- Updated dependencies [448a47c]
  - @aws-blocks/bb-lambda-compute@0.2.1

## 0.3.0

### Minor Changes

- 7b4c62d: Add infrastructure `defaults` chosen once at the app entry point, replacing the per-block `sandboxMode` logic and the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin dance for removal-policy and deletion-protection.

  `@aws-blocks/core/cdk` now exports `BlocksDefaults` and the `BlocksPresets.sandbox` / `BlocksPresets.production` starting points. `BlocksStack.create` / `BlocksBackend.create` take a required `defaults` prop; start from a preset and override individual fields with a spread. `defaults` is anchored on the owning `BlocksStack`/`BlocksBackend` (resolved by walking up the construct tree, like `handler`/`executionRole`), so multiple backends in one stack each keep their own posture. Building Blocks read the resolved values via `scope.defaults`, and a per-block option always wins (`option ?? scope.defaults.field`).

  Adopted across the stateful Building Blocks: `bb-kv-store`, `bb-data`, `bb-distributed-data`, `bb-distributed-table`, and `bb-knowledge-base` now take their removal policy and deletion protection from `defaults` instead of reading the `sandboxMode` context themselves. (`bb-distributed-table` reads `defaults` directly for now; a richer per-block `protection` override lands with #282.)

  The `create-blocks-app` scaffolding templates are updated to pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production` (replacing the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin), so newly-generated apps satisfy the required prop.

  **Breaking:** `BlocksStack.create` / `BlocksBackend.create` now require a `defaults` field — pass `BlocksPresets.sandbox` or `BlocksPresets.production` (typically `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`). The previously-shipped experimental `hardening` prop and its `resolve*` helpers are removed; log-retention, API throttling, access-logging and point-in-time-recovery move into `defaults` in follow-up, per-feature changes.

### Patch Changes

- 6df9e2d: fix(data): declare the `data-common` TypeScript project reference in `bb-data` and `bb-distributed-data`

  Both packages depend on `@aws-blocks/data-common` in `package.json`, but neither
  listed it in its `tsconfig.json` `references`. Because `src/` ships in these
  tarballs, `data-common`'s declarations have to already exist for the compiler to
  resolve `@aws-blocks/data-common` — and nothing in the project-reference graph
  guaranteed that.

  Correct build order was therefore supplied by the position of `data-common` in
  the root `workspaces` array (index 8, ahead of `bb-data` at 10 and
  `bb-distributed-data` at 11) rather than by the dependency graph. Any build that
  does not follow that array order fails with:

  ```
  packages/bb-distributed-data/src/validation.ts(12,54): error TS2307:
    Cannot find module '@aws-blocks/data-common' or its corresponding type declarations.
  ```

  That was already reachable from the repo's own scripts: the former
  `npm run build:packages` resolved its `-w` targets in a different order and hit
  exactly this, which is why `scripts/agent-bench/steps/1-init-bench-app.sh`
  carried the comment "`build:packages` runs alphabetically and trips over
  bb-data". Adding the two missing references fixes the root cause, so build order
  now comes from the project-reference graph rather than from the ordering of the
  root `workspaces` array.

  No API, runtime, or packaged-output change — `tsconfig.json` is not in either
  package's `files`, so the published tarballs are unchanged.

- 3614a09: Stop `import.meta.url` from crashing the deployed Lambda. The backend handler is bundled to CommonJS, where `import.meta` is empty, so `fileURLToPath(import.meta.url)` in a handler, a Building Block's `aws-runtime` code, or a dependency became `fileURLToPath(undefined)` and threw at Lambda load (every request 502'd). esbuild only warned, so the broken bundle deployed. The handler bundling now shims `import.meta.url` / `import.meta.dirname` / `import.meta.filename` to their CommonJS equivalents (`pathToFileURL(__filename)`, `__dirname`, `__filename`) — the approach esbuild blesses and Rollup applies by default — so the bundle loads cleanly and a dependency that merely contains `import.meta` no longer trips a build failure. Exposes `blocksNodejsBundling()` from `@aws-blocks/core/cdk` (re-exported by `@aws-blocks/blocks`) so every framework `NodejsFunction` gets the same treatment. Note: inside the bundle these resolve to the bundled output location, not your source tree.
- edbf1aa: fix(bb-knowledge-base): disable `installLatestAwsSdk` on the ingestion custom resource

  The `StartIngestion` `AwsCustomResource` left `installLatestAwsSdk` at its default
  (`true`), so the provider Lambda ran an `npm install` of the AWS SDK on every
  invocation before it could call the API. That costs roughly 15-30s of extra cold
  start and raises the shared provider Lambda to 512MB of memory, though that
  reduction is only realized once every `AwsCustomResource` in the stack opts out —
  the provider is a stack-level singleton and its `memorySize` is resolved once at
  synth. The per-resource cold-start saving applies regardless.

  Nothing needed it. The resource calls `BedrockAgent.startIngestionJob`, a stable
  API already bundled in the Lambda runtime's AWS SDK v3, so the bundled client is
  sufficient and the install is pure overhead. Setting `installLatestAwsSdk: false`
  also silences CDK's `installLatestAwsSdkNotSpecified` synth-time warning for this
  construct.

  The tradeoff being accepted: the provider now uses whichever SDK v3 the Lambda
  runtime bundles at deploy time rather than installing the newest one. That is safe
  here because `startIngestionJob` is a foundational Bedrock Agent operation present
  since the client's initial release, not a recent addition.

  Internal construct wiring only — no public API change. The synthesized
  `Custom::AWS` resource now renders `InstallLatestAwsSdk: false`.

  Upgrade note: because `InstallLatestAwsSdk` renders as a property on the
  `Custom::AWS` resource while the `physicalResourceId` stays stable, the first
  deploy after upgrading is a CloudFormation _Update_ and fires `onUpdate` — so one
  `startIngestionJob` kicks off. This is harmless (ingestion is idempotent and
  fire-and-forget), but expect to see an ingestion start right after upgrading.

- 5262062: feat: extract `LambdaCompute` into `@aws-blocks/bb-lambda-compute`

  The abstract `Compute` base stays in core as a framework primitive; the concrete
  `LambdaCompute` (a `NodejsFunction` fronted by its own API Gateway, assuming the
  shared execution role) moves into a new package, `@aws-blocks/bb-lambda-compute`.

  The package is CDK-only and its sole export is internal — customers cannot
  instantiate a compute yet. Nothing in the default path constructs it, so this is
  additive and non-breaking.

- bfb9a63: Polish the PGlite init-retry helper (`data-common`) following #205 review:

  - Narrow the WASM-trap classifier to specific signatures (`RuntimeError: unreachable`, `wasm trap: unreachable`, Emscripten `Aborted(<reason>)`) instead of matching the bare word `unreachable`, so an unrelated probe failure whose text/stack merely contains "unreachable" (e.g. an `assertUnreachable` helper) is no longer misclassified as retryable. The `Aborted(` prefix (not just the empty `Aborted()`) is matched so memory-pressure aborts like `Aborted(Cannot enlarge memory arrays)` / `Aborted(OOM)` — the case this retry exists for — are caught. A `RuntimeError`-named error whose message contains `unreachable` is also treated as a trap, so the real V8/Node trap (message is literally `"unreachable"`, prefix only in the stack) is caught without depending on the stack surviving.
  - Classify retryability BEFORE consulting the attempt budget in `initializePgliteWithRetry`, so instance cleanup is uniform (a non-retryable error is always rethrown untouched) and `maxAttempts === 1` no longer closes the instance on a non-trap failure.
  - Guard `maxAttempts` against `NaN` (which `?? 3` does not default), preventing an unbounded close/recreate loop on a persistent trap.
  - Wrap a `recreate()` failure so the original init trap is preserved as the error `cause`, keeping debugging pointed at "PGlite kept trapping" rather than only the secondary recreate error.
  - Mark the four init-retry exports (`initializePgliteWithRetry`, `isPgliteUnreachableTrap`, `PgliteLike`, `PgliteInitRetryOptions`) `@internal` — they exist only so the engine packages can share the helper — and document the `PgliteLike` methods.

- e4b1498: Retry PGlite's WASM initialization on the intermittent `_pg_initdb` `unreachable` trap.

  PGlite defers `initdb` to the first query, which can trap with `unreachable` under memory pressure (notably on CI when several PGlite-backed dev servers boot concurrently) and kill the dev server mid-`runMigrations`. `PGliteEngine` (bb-data) and `DsqlMockEngine` (bb-distributed-data) now force initialization through a shared bounded retry (`initializePgliteWithRetry` in data-common) that closes the aborted WASM instance and boots a fresh one, so a transient init trap recovers instead of crashing the process.

- 8966cfb: fix(telemetry): detect Render and Taskcluster as CI

  Telemetry CI detection (`isCI()`) checked a fixed list of CI env vars but
  omitted Render and Taskcluster. Render sets `RENDER=true` on every build and
  service; Taskcluster tasks always set the namespaced `TASKCLUSTER_ROOT_URL`.
  Runs on those platforms were therefore reported as real user sessions instead
  of `ci:true`, inflating user metrics. `RENDER` and `TASKCLUSTER_ROOT_URL` are
  now included in both `isCI()` implementations (`@aws-blocks/core` and
  `@aws-blocks/create-blocks-app`). The umbrella `@aws-blocks/blocks` gets a patch
  bump because it re-exports `@aws-blocks/core`.

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [6df9e2d]
- Updated dependencies [3614a09]
- Updated dependencies [edbf1aa]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [e4b1498]
- Updated dependencies [406ba89]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-kv-store@0.1.6
  - @aws-blocks/bb-data@0.2.5
  - @aws-blocks/bb-distributed-data@0.1.6
  - @aws-blocks/bb-distributed-table@0.1.5
  - @aws-blocks/bb-knowledge-base@0.2.1
  - @aws-blocks/bb-lambda-compute@0.2.0
  - @aws-blocks/bb-realtime@0.1.4
  - @aws-blocks/auth-common@0.1.5
  - @aws-blocks/bb-agent@0.3.4
  - @aws-blocks/bb-app-setting@0.1.4
  - @aws-blocks/bb-async-job@0.1.4
  - @aws-blocks/bb-auth-basic@0.1.6
  - @aws-blocks/bb-auth-cognito@0.1.7
  - @aws-blocks/bb-auth-oidc@0.1.8
  - @aws-blocks/bb-cron-job@0.1.4
  - @aws-blocks/bb-dashboard@0.1.3
  - @aws-blocks/bb-email-client@0.1.4
  - @aws-blocks/bb-file-bucket@0.1.4
  - @aws-blocks/bb-logger@0.1.4
  - @aws-blocks/bb-metrics@0.1.4
  - @aws-blocks/bb-tracer@0.1.6

## 0.2.7

### Patch Changes

- 1e37c67: docs: per-block docs folders + committed BB catalog with CI sync check; CLAUDE/agents docs resolved via require.resolve

  `@aws-blocks/blocks` now ships one docs folder per Building Block under `docs/<block>/`
  (`README.md` / `API.md` / `DESIGN.md`), plus a committed, marker-delimited Building Block
  catalog in the package README that a `sync-docs --check` CI gate keeps in sync. The README's
  catalog section and the scaffolded `AGENTS.md` (`@aws-blocks/create-blocks-app`) now direct
  tools and agents to locate docs programmatically via
  `require.resolve('@aws-blocks/blocks/docs/<block>/README.md')` (and
  `require.resolve('@aws-blocks/blocks/docs/README.md')` for the catalog) rather than assuming a
  `node_modules/` path or following the human-facing relative links. Also adds a Security
  Considerations section to the package README.

- Updated dependencies [cb779c8]
  - @aws-blocks/core@0.1.18

## 0.2.6

### Patch Changes

- 75f5446: Add optional `fallback` parameter to `AuthenticatedContent` for rendering alternative content when the user is not authenticated.
- 2ed4177: Add stable `data-testid` hooks to the auth UI components so e2e suites can target the shipped `Authenticator` instead of forking it. Covers every interactive element (field inputs, hidden ones included, and submit buttons) plus the containers worth asserting against: the root, per-action wrappers, heading, error, the signed-in marker, `AuthenticatedContent`, and `AccountMenuBar`. Presentational markup such as hint text and layout wrappers stays unhooked. The full selector contract, including the `<action>:<provider>` form federated actions produce, is documented in CUSTOMIZING-AUTH-UI.md.

  The `@aws-blocks/blocks` umbrella package receives a `patch` because it re-exports these components from `@aws-blocks/auth-common/ui`. Sibling patch releases stay inside the umbrella's caret ranges, so `changeset version` never bumps it on its own (#212), and it is republished explicitly to stay in step with the components it hands to consumers.

- 5b2aede: `DistributedTable`: reconcile reads with the schema via a new `readValidation` mode (default `'coerce'`).

  **Behavioral change to the read path (preview).** Writes always validated against `schema`, but reads (`get`, `getBatch`, `query`, `scan`) returned the raw stored value. After a schema change, a row written under the old schema no longer conformed to type `T`: a newly added field was absent from the read (so the value silently violated `T`, and a `.default()` was never applied or persisted on write-back), and a required-no-default field made the read-modify-write cycle (`get()` → mutate → `put()`) throw `ValidationFailed`.

  Reads now reconcile stored items with the schema via `readValidation?: 'off' | 'coerce' | 'strict'`:

  - **`'coerce'`** (default) — apply the schema (fill defaults, narrow types) so legacy rows conform to `T` and round-trip cleanly, **without dropping data**: the coerced output is deep-merged over the raw stored item, so attributes not in the current schema (older-schema fields, columns another writer owns) are preserved rather than silently stripped on a read-modify-write. Arrays are replaced wholesale. On a value that can't be coerced, return the raw value + log a warning — **never throws**.
  - **`'strict'`** — throw `ValidationFailed` on any non-conforming item (opt-in; treats a mismatch as corruption).
  - **`'off'`** — return the raw stored value with no validation (the previous default behavior).

  ```ts
  const orders = new DistributedTable(scope, "orders", {
    schema: orderSchemaV2, // adds `currency: z.string().default('USD')`
    key: { partitionKey: "orderId" },
    // readValidation: 'coerce' is the default
  });
  const order = await orders.get({ orderId: "o1" }); // legacy row → currency: 'USD'
  await orders.put({ ...order, total: 20 }); // conforms to T; round-trips
  ```

  Migration note: the default is now `'coerce'` (previously reads returned raw values). Pass `readValidation: 'off'` to restore raw reads. Coercion is best-effort and validator-dependent — transform-bearing schemas (e.g. Zod) fill defaults and narrow types; check-only Standard Schema validators pass values through unchanged. `null` (a missing item) is untouched in all modes.

- feb5be4: Re-export the `auth.admin` types (`AdminOptions`, `AdminUser`, `AdminCreateInit`, `GroupAdmin`, `LifecycleAdmin`, `AdminSurface`, `AdminGetterOf`, `AdminDisabled`) from the umbrella package so consumers using `@aws-blocks/blocks` can name the values `auth.admin` returns and annotate `admin` options.
- 9de27dd: fix(core): stream CloudFormation progress to stdout and stop a stray SIGTERM from killing an in-flight deploy

  `npm run deploy` wrote nothing to stdout for the whole CloudFormation phase, and
  a backgrounded deploy was killed (exit 143) while CloudFormation kept going and
  finished server-side. Callers had no progress signal, could not tell success from
  failure, and re-ran deploys that had actually worked.

  Two causes, both fixed:

  - The CDK CLI picks its log stream as `isCI ? stdout : stderr`, so every
    CloudFormation event went to stderr and `npm run deploy > deploy.log` captured
    zero bytes. The deploy now passes `--ci` (log lines on stdout, errors still on
    stderr) and `--progress events` (one line per resource transition instead of a
    progress bar that needs a TTY).
  - The deploy ran `cdk deploy` through a blocking synchronous spawn with the child
    in this process's group, so signals could not be handled and the default
    SIGTERM disposition killed the CLI mid-deploy. The CDK CLI is now spawned in
    its own process group with its output piped and relayed line by line as it
    arrives, plus an idle heartbeat while a slow resource is converging. A single
    SIGTERM, or any SIGHUP, no longer abandons a converging deploy: it logs and
    keeps streaming. Ctrl-C, or a second SIGTERM, aborts and reaps the CDK process
    tree. Repeat deliveries of the same signal inside the coalescing window log one
    line instead of one per delivery.

  Worth knowing before you upgrade:

  - **The signal resilience is POSIX-only.** It needs process groups (`detached` is
    passed only when `process.platform !== 'win32'`) and real signal delivery, and
    Windows has neither: nothing outside the process delivers SIGTERM/SIGHUP there,
    so a kill on the process tree still ends the deploy and the abort path reaps by
    pid. Streaming, the heartbeat and the `--ci` argv apply on every platform.
  - **The `❌ Deployment failed.` banner moved from stderr to stdout**
    (`console.error` → `console.log`), so a caller capturing only stdout can tell a
    failed deploy from a killed process. Anything grepping _stderr_ for that exact
    string will no longer match it. The failure _reason_ has not moved: the CDK CLI
    keeps error-level output on stderr even under `--ci`, and the deploy entrypoint
    still prints the error itself with `console.error`, so stderr remains the place
    to grep for why a deploy failed. Both halves of that split are now covered by
    tests, including one against the real CDK CLI.

- 58f77dd: Document four things people were reverse-engineering from compiled output.

  - **Runtime config resolution.** The client config is served at the dotted path `/.blocks-sandbox/config.json`; `/config.json` is not a route, so a 404 there means nothing. `{"_placeholder":true}` in the frontend build output is the Hosting construct's synth-time stub (the real `apiUrl` is still an unresolved CloudFormation token), so it is expected pre-deploy rather than a broken config. Covers the resolution order, what each environment should actually return, and what a genuine failure looks like.
  - **`RawRoute`.** Full section in the core README: constructor signature, a `GET` example that sets status, `Content-Type` and body, what you can read off `ctx.request` and write to `ctx.response`, path/parameter/wildcard syntax, and the registration rules (reserved paths, duplicate routes, register-during-load). Also added a "serve a raw HTTP endpoint" entry to the block catalog decision tree, which had no pointer to it.
  - **Server-initiated OIDC sign-in.** New section in the `bb-auth-oidc` README for `GET /aws-blocks/auth/signin/<provider>`: the redirect chain through the IdP and the callback, the pending-auth and session cookies, the JSON error shape, a runnable `curl` walkthrough, when to use it instead of the client PKCE API, and a pointer to the integration tests that assert each response. One route is mounted per configured provider, so an undeclared provider name 404s instead of reporting `ProviderNotConfiguredException`, which comes from `getSignInUrl()`.
  - **Error and RPC semantics.** `ApiError`'s constructor arguments (including `cause` staying server-side and `retriable`), how its `status` becomes the JSON-RPC error code and decodes back into an `ApiError` on the client, `hasAuthError`'s signature and when it applies instead of `isBlocksError`, how `params` is read as positional args vs a named object, that a top-level JSON array body (a batch) is rejected with `-32600`, and that `broadcastAuthChange` comes from `@aws-blocks/blocks/ui` rather than the package root.

  Docs only, plus tests locking in the documented `ApiError`, `params` and batch-rejection behaviour, and the documented `404`s on the OIDC sign-in and sign-out routes.

- b83aaba: Add opt-in TTL support to `KVStore` and use it to expire `AuthCognito` session records.

  `KVStore` gains a `ttl` construct option that enables DynamoDB Time-to-Live on the table, plus per-write expiry via `put(key, value, { ttlSeconds })` or `{ expiresAt }`. Both default to off, so existing tables and every existing `put()` call are unaffected. Because DynamoDB deletes expired items asynchronously, `get` and `scan` also filter expired items on read in every runtime, and the local mock emulates the same expiry semantics. Maintenance sweeps that need to act on rows the reaper has not collected yet can opt out with `scan({ includeExpired: true })`.

  `AuthCognito` now enables TTL on its sessions table and stamps each session write with `now + sessionTtlSeconds`. Session records store live Cognito refresh tokens, so without an expiry the table grew without bound and retained those credentials at rest indefinitely; abandoned sessions are now reaped automatically. Authorization is unchanged — validity is still decided by token revalidation on every request.

  Two things to know before upgrading:

  - **Your next `cdk deploy` enables TTL on the existing sessions table.** Even though this is a patch, `AuthCognito` now passes `{ ttl: true }`, so the deploy issues a one-time `UpdateTimeToLive` against the live table. That is an online, non-disruptive DynamoDB operation — no downtime, no data loss — but it is a mutation of a live resource, so it shouldn't surprise anyone diffing a patch upgrade.
  - **Only sessions written after the upgrade expire.** A missing `ttl` attribute means "never expires" (matching DynamoDB), and existing rows are not backfilled, so sessions created before the upgrade keep their refresh tokens at rest indefinitely. Backfilling would need a one-time migration writing `ttl` onto every existing row. To close the retention gap immediately, revoke the pre-existing sessions instead — the revoke sweep deletes rows regardless of expiry state.

- f583c75: Add opt-in job status tracking to AsyncJob

  Pass `trackStatus: true` and AsyncJob records each job's lifecycle, which you can read with two new methods:

  - `getStatus(jobId)` returns the job's current state plus every state it has passed through.
  - `waitUntilComplete(jobId, options?)` waits until the job reaches `complete` or `failed`, with `timeoutMs`, `pollIntervalMs`, and `AbortSignal` support.

  Transitions are appended rather than overwritten, so intermediate states stay observable no matter when you read them. A handler that finishes in a millisecond still records that it went through `processing`, and a caller that checks once after the job settled sees the whole sequence. That removes the need to pad a handler with an artificial delay just to make the `processing` state catchable, and a retry appends another `processing` entry so attempt counts are visible too.

  Appends are guarded by a compare-and-swap, so the two ways two writers can hold the same record at once cannot drop a transition: a `queued` write arriving after SQS already delivered the message, and a duplicate delivery of the same message on an at-least-once queue.

  When the handler gets there first it creates the record itself, dating the submission from the moment it first saw the job, since that is all it knows. The `queued` write that arrives afterwards replaces that placeholder with the real submission time instead of dropping it, so `submittedAt` and the first transition always report when the job was submitted rather than when it started being processed.

  Enabling the flag provisions one DynamoDB table for the job's status records, with a 24 hour TTL, and adds a write on submit plus one per state change. Leave it off and nothing is provisioned; `submit()` stays a single SQS call and the status methods throw `StatusNotTracked`.

  Status writes on the handler path are logged rather than thrown, so bookkeeping can never retry work that succeeded or mask work that failed. The trade is that a dropped terminal write leaves a finished job without a terminal state, so read `waitUntilComplete()`'s `Timeout` as "status unknown" rather than "still running".

- 3c56267: `AuthBasic` and `Logger` now report `bbName`/`bbVersion` to `Scope`, so they appear in telemetry like every other Building Block.

  Both were listed in the umbrella's `aws-blocks.vendorize` map, so `scripts/generate-bb-names.mjs` had already generated them into `OFFICIAL_BB_NAMES` — but neither passed `bbMeta` to `super()`, and `Scope` only records a block in its registry when `bbName` is set. Their entries in that set were therefore inert: `Scope.getRegisteredBlocks()` could never name either block, so `product.buildingBlocks` under-reported two of the most widely used blocks. Each package now carries the standard `prebuild` (`generate-version.mjs AuthBasic` / `Logger`), which generates the `BB_NAME`/`BB_VERSION` its constructor passes through — the same wiring the other blocks use.

  `Logger` is composed internally by most other blocks (`new Logger(this, 'logger', { level: 'error' })`), so it will now be reported for effectively every application, and `totalCount` rises accordingly. That is the intended reading of the existing `Logger` entry in the vendorize map, not a new disclosure: `getRegisteredBlocks()` still exposes only names already on the official list, and customer-chosen block names remain counted-but-unnamed.

  `@aws-blocks/blocks` takes a `patch` because it re-exports both blocks; sibling releases stay inside its caret range, so `changeset version` would not bump it on its own (#273, #212). `@aws-blocks/core` needs no bump — both names were already present in the generated `OFFICIAL_BB_NAMES`, so that file is byte-identical.

- 0491157: `Metrics`, `Tracer`, and `DistributedDatabase` now report `bbName`/`bbVersion` to `Scope`, so they appear in telemetry like every other Building Block.

  All three were listed in the umbrella's `aws-blocks.vendorize` map, so `scripts/generate-bb-names.mjs` had already generated them into `OFFICIAL_BB_NAMES` — but none passed `bbMeta` to `super()`, and `Scope` only records a block in its registry when `bbName` is set. Their entries in that set were therefore inert: `Scope.getRegisteredBlocks()` could never name them, so `product.buildingBlocks` under-reported them. Each package now carries the standard `prebuild` (`generate-version.mjs Metrics` / `Tracer` / `DistributedDatabase`), which generates the `BB_NAME`/`BB_VERSION` its constructor passes through — the same wiring the other blocks use.

  `bb-tracer` and `bb-distributed-data` ship distinct mock implementations (their default entry does not re-export the AWS class), so both `index.aws.ts` and `index.mock.ts` carry the change; `bb-metrics`'s mock re-exports the AWS class, so its single runtime change covers both conditions. CDK entry points are deliberately left alone — telemetry is reported by the runtime class, not the synth-time construct.

  This is a follow-up to #298 (`AuthBasic`/`Logger`), completing telemetry parity for every vendorized block whose runtime class extends `Scope`. `@aws-blocks/blocks` takes a `patch` because it re-exports all three; sibling releases stay inside its caret range, so `changeset version` would not bump it on its own. `@aws-blocks/core` needs no bump — all three names were already present in the generated `OFFICIAL_BB_NAMES`, so that file is byte-identical.

- Updated dependencies [75f5446]
- Updated dependencies [feb5be4]
- Updated dependencies [2ed4177]
- Updated dependencies [feb5be4]
- Updated dependencies [49b3bd9]
- Updated dependencies [5b2aede]
- Updated dependencies [7b3bb06]
- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [bd59e60]
- Updated dependencies [b83aaba]
- Updated dependencies [a584007]
- Updated dependencies [f583c75]
- Updated dependencies [2d3dfdc]
- Updated dependencies [3c56267]
- Updated dependencies [0491157]
  - @aws-blocks/auth-common@0.1.4
  - @aws-blocks/bb-auth-cognito@0.1.6
  - @aws-blocks/bb-agent@0.3.3
  - @aws-blocks/bb-data@0.2.4
  - @aws-blocks/bb-distributed-table@0.1.4
  - @aws-blocks/core@0.1.17
  - @aws-blocks/bb-auth-oidc@0.1.7
  - @aws-blocks/bb-file-bucket@0.1.3
  - @aws-blocks/bb-kv-store@0.1.5
  - @aws-blocks/bb-distributed-data@0.1.5
  - @aws-blocks/bb-async-job@0.1.3
  - @aws-blocks/bb-auth-basic@0.1.5
  - @aws-blocks/bb-logger@0.1.3
  - @aws-blocks/bb-metrics@0.1.3
  - @aws-blocks/bb-tracer@0.1.5

## 0.2.5

### Patch Changes

- 0f3c73c: Reject `ALTER TABLE DROP COLUMN` at dev time, including the keyword-less Postgres shorthand (`ALTER TABLE t DROP col` / `DROP IF EXISTS col`). It is not in DSQL's supported `ALTER TABLE` subset ("unsupported ALTER TABLE DROP COLUMN statement", 0A000), but the PGlite-based local mock previously accepted it, so the error only surfaced on deploy. Migration and mock validation now fail locally instead. The supported forms — `ALTER COLUMN ... DROP DEFAULT` / `DROP NOT NULL` / `DROP EXPRESSION` / `DROP IDENTITY` and `DROP CONSTRAINT` — are not affected.

  The `@aws-blocks/blocks` umbrella package receives a `patch` because its published `docs/` folder is assembled from sibling block READMEs at build time (`scripts/sync-block-docs.mjs`), so this `bb-distributed-data` README update changes `@aws-blocks/blocks` packaged content.

- Updated dependencies [0f3c73c]
  - @aws-blocks/bb-distributed-data@0.1.4

## 0.2.4

### Patch Changes

- 09b94b8: Bump the Database block's Aurora PostgreSQL engine version from the retired `16.4` to `16.13`, and make the engine version configurable.

  AWS retired Aurora PostgreSQL `16.4` in us-east-1, after which `CreateDBCluster` failed with `Cannot find version 16.4 for aurora-postgresql`, blocking every deployment of a `Database` block. The default now points at the latest available `16.x` minor (`16.13`) for the longest deprecation runway.

  A new optional `postgresVersion` option on `DatabaseOptions` lets callers override the engine version (e.g. `postgresVersion: '16.13'`), so the next AWS retirement is a configuration change rather than a framework code fix. Overrides are validated at synth time (must be `MAJOR.MINOR`, e.g. `16.13`), so a malformed value fails fast with a clear error instead of an opaque `CreateDBCluster` failure.

  The `@aws-blocks/blocks` umbrella package receives a `patch` because its published `docs/` folder is assembled from sibling block READMEs at build time (`scripts/sync-block-docs.mjs`), so this `bb-data` README update changes `@aws-blocks/blocks` packaged content.

- Updated dependencies [09b94b8]
  - @aws-blocks/bb-data@0.2.3

## 0.2.3

### Patch Changes

- fc8cfad: Republish the umbrella `@aws-blocks/blocks` package so its tarball matches the updated re-exported APIs (`@aws-blocks/core`, `@aws-blocks/bb-agent`) and synced block docs. The sibling patch releases stayed within `blocks`' caret dependency ranges, so `changeset version` did not auto-bump the umbrella package, and the publish integrity guard requires a version bump when packed content changes.
- Updated dependencies [c4313cd]
- Updated dependencies [997c736]
  - @aws-blocks/bb-agent@0.3.2

## 0.2.2

### Patch Changes

- d898838: Include synced building block documentation updates.

## 0.2.1

### Patch Changes

- 8de7091: Include synced building block documentation updates.
- Updated dependencies [c7f1e7c]
- Updated dependencies [5491cae]
  - @aws-blocks/bb-distributed-data@0.1.3
  - @aws-blocks/bb-realtime@0.1.3

## 0.2.0

### Minor Changes

- b6fb281: Add `isSynced()` / `waitUntilSynced()` ingestion-sync API to KnowledgeBase.

  Bedrock ingestion runs asynchronously after deploy, so during the initial pre-sync window `retrieve()` returns an empty array even for queries that would later match — making "empty" ambiguous between "not yet synced with your latest data" and "synced, no match". The new methods resolve that ambiguity (mirroring Bedrock's own "Sync" / "sync with your latest data" terminology):

  - `isSynced(): Promise<boolean>` — `true` once the data source's most recent ingestion job is `COMPLETE`; `false` while it is not yet synced with your latest data. This reports data _freshness_, not availability — `retrieve()` is always callable and serves the prior synced snapshot during a re-ingestion. Both local-folder and imported `s3://` sources register a BB-managed data source, so both are tracked (the "no managed data source → synced" shortcut applies only to deployments predating this API, which have no data source id injected). Throws a typed `IngestionFailedException` (including `failureReasons`) if the latest job failed.
  - `waitUntilSynced(options?: { timeoutMs?: number; pollIntervalMs?: number; maxConsecutiveTransientErrors?: number; signal?: AbortSignal }): Promise<void>` — polls until synced (defaults: `timeoutMs` 300000, `pollIntervalMs` 5000, `maxConsecutiveTransientErrors` 3), throwing a typed `KnowledgeBaseTimeoutException` on timeout or propagating `IngestionFailedException` on a failed job. Up to `maxConsecutiveTransientErrors` _consecutive_ transient control-plane errors are tolerated (the counter resets on a clean poll); terminal errors short-circuit immediately. Transient covers both throttling / transient network failures **and** a _not-yet-visible_ knowledge base — during the post-deploy window the control plane can briefly return `ResourceNotFoundException` (the freshly-created KB/data source hasn't propagated yet), which is ridden out rather than treated as terminal; a _missing-KB config_ error (`KB_ID` unset) stays terminal. The poll interval carries ±20% jitter (only the delay between polls varies, never the poll count or the deadline) so many KBs don't poll in lockstep. Pass an optional `signal` (`AbortSignal`) to cancel the wait — checked before each poll and during the inter-poll delay — which rejects with the signal's abort reason (default: a `DOMException` named `'AbortError'`).

  Purely additive — `retrieve()` and all existing signatures are unchanged. The local mock reports synced immediately (no async ingestion window in local dev).

  The umbrella `@aws-blocks/blocks` package now also re-exports the new `WaitUntilSyncedOptions` type (alongside the existing `KnowledgeBase` re-exports) from both its runtime and CDK entry points, so consumers importing from `@aws-blocks/blocks` can reference it directly.

### Patch Changes

- Updated dependencies [b6fb281]
- Updated dependencies [b6fb281]
  - @aws-blocks/bb-knowledge-base@0.2.0

## 0.1.9

### Patch Changes

- Updated dependencies [e839301]
- Updated dependencies [179817f]
  - @aws-blocks/core@0.1.10
  - @aws-blocks/bb-data@0.2.1
  - @aws-blocks/bb-agent@0.3.0

## 0.1.8

### Patch Changes

- Updated dependencies [42fcbdf]
  - @aws-blocks/bb-data@0.2.0

## 0.1.7

### Patch Changes

- Updated dependencies [f946736]
- Updated dependencies [53adfb8]
- Updated dependencies [ce61bb7]
  - @aws-blocks/bb-agent@0.2.0
  - @aws-blocks/bb-auth-oidc@0.1.6

## 0.1.6

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
- Updated dependencies [03b971a]
- Updated dependencies [1da34f1]
- Updated dependencies [683bf49]
  - @aws-blocks/core@0.1.6
  - @aws-blocks/bb-auth-oidc@0.1.4
  - @aws-blocks/auth-common@0.1.3
  - @aws-blocks/bb-auth-basic@0.1.3
  - @aws-blocks/bb-auth-cognito@0.1.5
  - @aws-blocks/bb-kv-store@0.1.4

## 0.1.5

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
- Updated dependencies [f24d3c3]
- Updated dependencies [d4a1390]
  - @aws-blocks/auth-common@0.1.2
  - @aws-blocks/bb-agent@0.1.3
  - @aws-blocks/bb-app-setting@0.1.3
  - @aws-blocks/bb-async-job@0.1.2
  - @aws-blocks/bb-auth-basic@0.1.2
  - @aws-blocks/bb-auth-cognito@0.1.4
  - @aws-blocks/bb-auth-oidc@0.1.3
  - @aws-blocks/bb-cron-job@0.1.3
  - @aws-blocks/bb-dashboard@0.1.2
  - @aws-blocks/bb-data@0.1.2
  - @aws-blocks/bb-distributed-data@0.1.2
  - @aws-blocks/bb-distributed-table@0.1.3
  - @aws-blocks/bb-email-client@0.1.3
  - @aws-blocks/bb-file-bucket@0.1.2
  - @aws-blocks/bb-knowledge-base@0.1.3
  - @aws-blocks/bb-kv-store@0.1.3
  - @aws-blocks/bb-logger@0.1.2
  - @aws-blocks/bb-metrics@0.1.2
  - @aws-blocks/bb-realtime@0.1.2
  - @aws-blocks/bb-tracer@0.1.4

## 0.1.4

### Patch Changes

- 7fd51e0: fix(bb-auth-cognito): discriminate `SignInResult` on a string `status` field

  `SignInResult` (from `signIn` / `confirmSignIn` / `autoSignIn`) now discriminates
  on a string `status` (`'signedIn' | 'continueSignIn'`) instead of the `isSignedIn`
  boolean, so native-client codegen (Swift / Kotlin / Dart) emits clean, named,
  switch-decoded variants. Narrow with `if (result.status === 'signedIn')`.

  Breaking change to the `SignInResult` shape (pre-release): `isSignedIn` is removed,
  not aliased.

- Updated dependencies [7fd51e0]
- Updated dependencies [e98bab4]
  - @aws-blocks/bb-auth-cognito@0.1.3
  - @aws-blocks/core@0.1.3

## 0.1.3

### Patch Changes

- 835c425: docs(bb-agent): document AgentStreamChunk types and Message roles
- Updated dependencies [835c425]
- Updated dependencies [dd07335]
  - @aws-blocks/bb-agent@0.1.2

## 0.1.2

### Patch Changes

- 7b80811: Add in-repo Building Block docs discoverability.

  The `@aws-blocks/blocks` package now ships a `docs/` folder containing every Building Block README (one per block) plus a generated `index.md` with a decision tree and catalog. This gives humans and AI agents a single, stable path to all block documentation — `node_modules/@aws-blocks/blocks/docs/` — instead of scattering them across 19+ individual package paths.

  - `@aws-blocks/blocks`: adds `docs/` to the published package (assembled at build time via `scripts/sync-block-docs.mjs`). README expanded to be a comprehensive guide (architecture, workflow, best practices, common mistakes).
  - `@aws-blocks/create-blocks-app`: AGENTS.md templates updated to point to the blocks README and docs folder as the canonical entry points.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-auth-cognito@0.1.1
  - @aws-blocks/bb-auth-oidc@0.1.1
  - @aws-blocks/auth-common@0.1.1
  - @aws-blocks/bb-app-setting@0.1.1
  - @aws-blocks/bb-distributed-table@0.1.1
  - @aws-blocks/bb-file-bucket@0.1.1
  - @aws-blocks/bb-kv-store@0.1.1
  - @aws-blocks/bb-metrics@0.1.1
  - @aws-blocks/bb-realtime@0.1.1
  - @aws-blocks/bb-agent@0.1.1
  - @aws-blocks/bb-async-job@0.1.1
  - @aws-blocks/bb-auth-basic@0.1.1
  - @aws-blocks/bb-cron-job@0.1.1
  - @aws-blocks/bb-dashboard@0.1.1
  - @aws-blocks/bb-data@0.1.1
  - @aws-blocks/bb-distributed-data@0.1.1
  - @aws-blocks/bb-email-client@0.1.1
  - @aws-blocks/bb-knowledge-base@0.1.1
  - @aws-blocks/bb-logger@0.1.1
  - @aws-blocks/bb-tracer@0.1.1

## 0.1.0

Initial version
