# @aws-cdk-blocks/auth-common

## 1.0.0

The first stable release. The changes since 1.0.0-rc.1 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0 and 1.0.0-rc.1.

### Changes since `@aws-blocks/auth-common` 0.x

- The package is now `@aws-cdk-blocks/auth-common`. Install it in place of `@aws-blocks/auth-common`, and change the import specifiers.
- 5f55dac: Adds `AuthErrors`, the auth error names, with the `AuthErrorName` type and the `isAuthError()` and `isAuthErrorName()` guards.
- 5f55dac: `AuthBasic`, `AuthCognito` and `AuthOIDC` are removed.
- 5f55dac: Show local social and SAML sign-in as unavailable.
- 1c7e0dd: `@aws-cdk-blocks/auth-common/cookies` adds `isLocalDevRequest(ctx)`, which tells the session-cookie policy whether a request comes from local development.
- 5f55dac: `Auth` refreshes a session consistently when requests overlap, and reports a sign-out that could not invalidate the server-side session.
- 5f55dac: A signed-in user can set up an authenticator app (TOTP) through `auth.createApi()`, with no backend code.
- 5f55dac: `subscribeAuthState`, `getAuthStateSnapshot` and a shared auth-state store behind `submitAuthAction`. A sign-in or sign-out reaches every component and tab once.
- 93d533a: Add `allowPlainHttp`, an explicit opt-out for builders who need a plain-HTTP front door in production.
- adb6077: A production synth fails for a front door that would carry sign-in, session cookies or the origin-verify secret over plain HTTP. To keep such a door, set `allowPlainHttp`.

### Since 1.0.0-rc.1

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.1

### Patch Changes

- 6ae587a: The READMEs document `Auth` setup, options, and error handling, and the `auth-common` README lists the auth error names. They note that sessions default to 30 days and that users sign in again after migrating from `AuthCognito`.

## 1.0.0-rc.0

### Major Changes

- e50b9e9: **Breaking: every published package moves from the `@aws-blocks` scope to `@aws-cdk-blocks`, and `@aws-blocks/blocks` becomes the unscoped `aws-cdk-blocks`.**

  To upgrade:

  1. In `package.json`, replace `@aws-blocks/blocks` with `aws-cdk-blocks` and every other `@aws-blocks/` name with `@aws-cdk-blocks/`, for example `@aws-cdk-blocks/core`.
  2. Make the same replacement in the specifier of every import.
  3. Change each `Annotations.of(stack).acknowledgeWarning('@aws-blocks/…')` call to the `@aws-cdk-blocks/` prefix, or `cdk synth --strict` fails on the warning.
  4. Keep the CDK context key `@aws-blocks/bb-data:encryptStorageByDefault` in `cdk.json` as it is, because renaming it makes CloudFormation replace the cluster.
  5. If you publish a block, move its dependency from `@aws-blocks/core` to `@aws-cdk-blocks/core`.

  No export or option moved, and the old `@aws-blocks/*` packages stop receiving releases.

### Minor Changes

- 5f55dac: Adds `AuthErrors`, the shared vocabulary of auth error names, with the `AuthErrorName` type and the `isAuthError()` and `isAuthErrorName()` guards. Match an auth failure by name with `isAuthError(e, AuthErrors.NotAuthenticated)`, on the server and in the browser.

- 5f55dac: **Breaking: `AuthBasic`, `AuthCognito`, and `AuthOIDC` are removed, and `Auth` replaces all three.**

  To upgrade:

  1. From your app's root, run `npx @aws-cdk-blocks/bb-auth migrate --dry-run` to preview the changes.
  2. Run `npx @aws-cdk-blocks/bb-auth migrate` to rewrite the files.
  3. Resolve each `TODO(aws-blocks-auth-migrate)` comment and follow `MIGRATION.md` in `@aws-cdk-blocks/bb-auth`.
  4. Keep every block's id exactly as it is, because changing it replaces the user pool and deletes its users.
  5. If you implement `BlocksAuth` yourself, add `requireRole`, which is now required.

  `AuthBasic` users sign up again, `AuthOIDC` users sign in once more, and a `cognitoFederated()` provider's user pool is replaced. Telemetry in `@aws-cdk-blocks/core` counts `Auth` as an official Building Block, and no longer counts the three removed blocks.

- 5f55dac: In `npm run dev`, `getAuthState()` marks social, SAML, and `type: 'oidc'` sign-in actions on the default store with a new optional `AuthAction.unavailable` reason. The `Authenticator` renders those buttons disabled, and API clients get a `501` JSON error named `ProviderUnavailableException`.
- 1c7e0dd: Adds `isLocalDevRequest(ctx)` to `@aws-cdk-blocks/auth-common/cookies`, which is `true` only when the process itself is local and the request comes from a loopback origin. On deployed compute a request that sends `Origin: http://localhost` cannot drop `Secure` from the cookie.
- 5f55dac: `Auth` refreshes a session consistently when requests overlap, and a refresh that completes after `signOut()` no longer restores the session. `signOut()` reports the new `AuthErrors.SignOutIncomplete`, a 503 `SignOutIncompleteException`, when it can't delete the session row.
- 5f55dac: `setAuthState` from `auth.createApi()` takes `setUpTotp`, `verifyTotpSetup`, `getMfaPreference`, and `updateMfaPreference` actions, and the new `MfaSettings` panel from `aws-cdk-blocks/ui` renders them. Native code that matches exhaustively over the `setAuthState` input needs the four new cases.
- 5f55dac: Adds `subscribeAuthState` and `getAuthStateSnapshot`, exported from `aws-cdk-blocks/ui` and `@aws-cdk-blocks/auth-common/ui`. `submitAuthAction` notifies every `onAuthChange` subscriber in this tab and in other tabs, so use it instead of calling `authApi.setAuthState(...)` directly.
- 93d533a: Adds `allowPlainHttp` to the `alb`, `custom`, and stacked doors, an opt-out for a plain-HTTP front door in production. To keep serving plain HTTP in production, add `allowPlainHttp: true` to the door and acknowledge the `@aws-cdk-blocks/hosting:PlainHttpAllowedInProduction` warning.

- adb6077: **Breaking: a production synth fails when a front door would carry sign-in, session cookies, or the router's origin-verify secret over plain HTTP.**

  To upgrade:

  1. For `{ kind: 'alb' }` with an API, add a `certificate` and `features.domain`, or use the CloudFront or stacked door.
  2. For a `{ kind: 'custom', door }` whose URL is `http://`, return an `https://` url.
  3. For `{ kind: 'stacked', edge: 'cloudfront', router: 'alb' }` with an internet-facing router, give the router a `certificate` and `features.router.domain`, or set `internal: true`.

  A sandbox deploy warns as before, and outside a sandbox `Auth` throws `AuthErrors.InsecureTransport` instead of issuing a session over plain HTTP.

### Patch Changes

- 5f55dac: The `Authenticator` renders each action as a `<form>`, and its inputs carry `autocomplete` hints. A `<button>` without a `type` inside a field's `render` override submits the action, so give a button that should not submit `type="button"`.
- 5f55dac: The cookie helpers' documentation now names `bb-auth` as their caller and refers to `bb-auth-basic`, `bb-auth-cognito` and `bb-auth-oidc` as the removed blocks they replaced.
- 5f55dac: Auth broadcasts are tagged per API, so `onAuthChange` for one API no longer receives another API's user. `broadcastAuthChange(user, api)` takes an optional `api` to tag a message the same way.
- 5f55dac: The `AuthFieldOverride` reference documentation no longer names `bb-auth-supabase`, a package AWS Blocks does not ship.
- 5f55dac: The client auth-state store and `onAuthChange` end at the session's real state when requests overlap, such as another tab's broadcast or answers that arrive out of order. No public API or wire-format changes.
- 5f55dac: `auth.createApi()` is typed by the block's options, so `setAuthState` takes only the actions the configuration supports and `AuthState.user` has the block's own groups and attributes. Adds types such as `AuthActionInputOf<O>`, `AuthStateUser<O>`, and `AuthUserOf<A>`.
- 5f55dac: `Auth` answers 409 `PasskeysNotEnabledException` for a passkey action on a block without `passkeys`, and 409 `MfaNotEnabledException` for an MFA challenge with MFA off. `AuthErrors` in `@aws-cdk-blocks/auth-common` gains `PasskeysNotEnabled` and `MfaNotEnabled`.
- 5f55dac: The `Authenticator` and `AccountMenuBar` show a signed-in user's email address instead of a generated id. `AuthState.user` has an optional `displayName` for display only, so keep keying data on `userId` or `userSub`.
- 5f55dac: `Auth` takes a block-level `store` and one `providers` map, keyed by provider id and tagged with its `type`. The default `store: 'cognito'` keeps users in a Cognito user pool, and `store: 'builtin'` has no user pool, so your backend verifies each provider itself.
- 5f55dac: Fixes made to `AuthCognito`, `AuthOIDC`, and `AuthBasic` since their last release ship in `Auth`. `Auth` has no `metrics` option, no per-username sign-in lockout, and no `additionalCallbackUrls` or `additionalLogoutUrls` options, and you import `AuthActionInput` from `aws-cdk-blocks`.

- 703238f: **Breaking: the scaffolded backend folder is `cdk-blocks/`, not `aws-blocks/`.**

  To upgrade:

  1. Rename the `aws-blocks/` directory to `cdk-blocks/`.
  2. Change the `"workspaces"` entry that names it.
  3. Change the `"name"` in its `cdk-blocks/package.json` to `cdk-blocks`.
  4. Change every `from 'aws-blocks'` import to import `cdk-blocks`.
  5. Rename an `aws-blocks/migrations` directory or set an explicit migrations path, because `DEFAULT_MIGRATIONS_ROOT` is now `./cdk-blocks/migrations`.

  The reserved URL namespace, such as `/aws-blocks/api` and `/aws-blocks/auth/*`, keeps its path, so deployed routes and OAuth callback URLs keep working.

- 1de6ea4: **Breaking: the framework's reserved URL prefix is now `/cdk-blocks/`, and the old `/aws-blocks/` prefix stays served as an alias.**

  To upgrade:

  1. If an external identity provider only allows the `/aws-blocks/auth/callback` redirect URI, register `/cdk-blocks/auth/callback` or set `redirects.callbackPath: '/aws-blocks/auth/callback'`.
  2. If a custom front door or an explicit `apiPaths` routes `/aws-blocks/*` by hand, also route `/cdk-blocks/*` or use `cf.apiBehaviors(origins.api)`.
  3. If the app is at the CloudFront cache-behavior quota, 25 by default, free a behavior or raise the quota, because the built-in front door adds one for `/aws-blocks/*`.

  A sandbox `stubIdp()` issuer moves to `/cdk-blocks/auth/idp/<id>`, so its users get a new `userId`.

- 5f55dac: Docs and editor hover text point at `Auth` instead of the removed `AuthBasic`, `AuthCognito`, and `AuthOIDC`. The `aws-cdk-blocks` README adds a "Choosing a sign-in method" table.
- 0ff1e1f: The Auth docs describe the installed version. The `errorName` example in the auth-common README uses `NotAuthorizedException`, an `AuthErrors` value.

## 0.3.0

### Minor Changes

- aaa90b6: AuthBasic revokes the session at sign-out, so `requireAuth` rejects a replayed cookie with `AuthBasicErrors.SessionRevoked`. `signOut` throws `AuthBasicErrors.SignOutIncomplete` when the revocation write fails, and the next `cdk deploy` enables DynamoDB TimeToLive on the `codes` store in place.
- dde6340: Adds the `frontDoor` prop to `Hosting`, which picks CloudFront, an Application Load Balancer, Amazon API Gateway, a stacked door, no door, or your own door built with `defineFrontDoor`. The top-level settings props are deprecated but still supported, so move each to `frontDoor.features.<x>`.
- f704a68: Adds `StatusMessage` to `@aws-blocks/auth-common/ui`, re-exported from `@aws-blocks/blocks/ui`, a themed status line for loading, success, and error states. `StatusMessage(options?)` returns `{ element, set }`, so you mount `element` and call `set(kind, text)`.

### Patch Changes

- 33edca2: Adds `submitAuthAction(api, input)`, a browser-only helper that calls `setAuthState` and then notifies `onAuthChange` subscribers and `AuthenticatedContent`. A custom auth UI no longer needs to call `broadcastAuthChange` by hand.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.

## 0.2.0

### Minor Changes

- 8ca3692: Adds a `ui-theme` design-token layer with a light and dark palette, used by the shared Auth components and the `create-blocks-app` templates. `@aws-blocks/blocks/ui` exports `injectTheme`, `THEME_CSS`, and `THEME_STYLE_ID`, and the new `@aws-blocks/blocks/theme` subpath exports only the token layer.

## 0.1.9

### Patch Changes

- 4456fd7: The auth READMEs document the full `AuthState` shape returned by `getAuthState()`/`setAuthState()`. `bb-auth-cognito` and `bb-auth-oidc` consumers import the type from `@aws-blocks/auth-common`.
- fac0e75: Pressing Enter submits the Authenticator form from every visible field, not only the last one.

## 0.1.8

### Patch Changes

- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.

## 0.1.7

Dependency updates only.

## 0.1.6

Dependency updates only.

## 0.1.5

Dependency updates only.

## 0.1.4

### Patch Changes

- 75f5446: Add optional `fallback` parameter to `AuthenticatedContent` for rendering alternative content when the user is not authenticated.
- 2ed4177: Adds stable `data-testid` hooks to the auth UI components, so e2e suites can target the shipped `Authenticator` instead of forking it. CUSTOMIZING-AUTH-UI.md documents the full selector contract.
- 58f77dd: The docs cover runtime config resolution, `RawRoute`, server-initiated OIDC sign-in, and error and RPC semantics.

## 0.1.3

### Patch Changes

- 1da34f1: `AuthState` carries an optional `errorName` that `setAuthState()` fills from the thrown `ApiError.name`. Adds the `hasAuthError(state, name)` type guard in `@aws-blocks/core` to branch on the returned state.

## 0.1.2

### Patch Changes

- ba3bf7b: Adds a `DESIGN.md` to each building-block package that describes its architecture, API surface, mock implementation, and key design decisions. It ships on npm alongside `README.md`.
- d4a1390: `onAuthChange` and `Authenticator` paint a synchronous first frame from the last-known user in the shared cache, then refresh from the async hydration.

## 0.1.1

### Patch Changes

- 270c049: Ports documentation from the internal staging repo.
- c0558f3: Minor improvements

## 0.1.0

Initial version
