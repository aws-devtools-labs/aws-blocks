# @aws-blocks/bb-auth-oidc

## 0.1.9

### Patch Changes

- 309a236: refactor(bb): attach IAM grants to the shared execution role
  
  Data and auth blocks now grant permissions to the shared Blocks execution role
  (`this.executionRole`) instead of the handler function directly. Grants land on
  the same role the handler assumes, so the effective runtime permissions are
  identical — this decouples IAM wiring from the concrete Lambda function ahead of
  the multi-compute model.
  
  For `bb-distributed-data`, the DSQL endpoint and region now flow through the
  config registry (loaded into `process.env` at cold start, like every other
  block) rather than being set as direct handler environment variables, and the
  migration Lambda maps the shared execution role's ARN.
- 27346f3: Make AuthOIDC `requireAuth()` throw `ApiError(401, NotAuthenticatedException)` so the documented `handle401()` 401-redirect pattern works for a signed-out protected call.
  
  Previously `requireAuth()` threw a bare `Error` with no `status`. Over the JSON-RPC boundary `errorResponseFromCatch` serializes a non-`ApiError` as code `500`, so the client received an `ApiError` with `status === 500`. The README's `if (handle401(e, provider)) return;` helper only acts on `err instanceof ApiError && err.status === 401`, so it never matched and the app never redirected to sign-in — the error just surfaced. This aligns AuthOIDC with AuthCognito, whose `requireAuth()` already throws `ApiError(401, …)`. The error name is preserved, so existing `isBlocksError(e, AuthOIDCErrors.NotAuthenticated)` checks are unaffected.
- 9bd5b3e: Reject stub IdP redirect_uris whose query carries a reserved OAuth/OIDC response param, or that carry a URI fragment, matching real-IdP behavior. Reserved-param matching is case-sensitive, so a distinctly-cased key such as `State` is passed through as a real IdP would.
- Updated dependencies [1ff9d03]
- Updated dependencies [5798492]
- Updated dependencies [f00adb0]
- Updated dependencies [f00adb0]
- Updated dependencies [309a236]
- Updated dependencies [08ab129]
- Updated dependencies [9d4ccea]
- Updated dependencies [5bfae0a]
- Updated dependencies [0ac3879]
- Updated dependencies [e4dac4a]
  - @aws-blocks/bb-app-setting@0.2.0
  - @aws-blocks/core@0.3.0
  - @aws-blocks/bb-kv-store@0.1.7
  - @aws-blocks/auth-common@0.1.6
  - @aws-blocks/bb-logger@0.1.5

## 0.1.8

### Patch Changes

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-kv-store@0.1.6
  - @aws-blocks/auth-common@0.1.5
  - @aws-blocks/bb-app-setting@0.1.4
  - @aws-blocks/bb-logger@0.1.4

## 0.1.7

### Patch Changes

- 58f77dd: Document four things people were reverse-engineering from compiled output.

  - **Runtime config resolution.** The client config is served at the dotted path `/.blocks-sandbox/config.json`; `/config.json` is not a route, so a 404 there means nothing. `{"_placeholder":true}` in the frontend build output is the Hosting construct's synth-time stub (the real `apiUrl` is still an unresolved CloudFormation token), so it is expected pre-deploy rather than a broken config. Covers the resolution order, what each environment should actually return, and what a genuine failure looks like.
  - **`RawRoute`.** Full section in the core README: constructor signature, a `GET` example that sets status, `Content-Type` and body, what you can read off `ctx.request` and write to `ctx.response`, path/parameter/wildcard syntax, and the registration rules (reserved paths, duplicate routes, register-during-load). Also added a "serve a raw HTTP endpoint" entry to the block catalog decision tree, which had no pointer to it.
  - **Server-initiated OIDC sign-in.** New section in the `bb-auth-oidc` README for `GET /aws-blocks/auth/signin/<provider>`: the redirect chain through the IdP and the callback, the pending-auth and session cookies, the JSON error shape, a runnable `curl` walkthrough, when to use it instead of the client PKCE API, and a pointer to the integration tests that assert each response. One route is mounted per configured provider, so an undeclared provider name 404s instead of reporting `ProviderNotConfiguredException`, which comes from `getSignInUrl()`.
  - **Error and RPC semantics.** `ApiError`'s constructor arguments (including `cause` staying server-side and `retriable`), how its `status` becomes the JSON-RPC error code and decodes back into an `ApiError` on the client, `hasAuthError`'s signature and when it applies instead of `isBlocksError`, how `params` is read as positional args vs a named object, that a top-level JSON array body (a batch) is rejected with `-32600`, and that `broadcastAuthChange` comes from `@aws-blocks/blocks/ui` rather than the package root.

  Docs only, plus tests locking in the documented `ApiError`, `params` and batch-rejection behaviour, and the documented `404`s on the OIDC sign-in and sign-out routes.

- Updated dependencies [75f5446]
- Updated dependencies [2ed4177]
- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [b83aaba]
- Updated dependencies [2d3dfdc]
- Updated dependencies [3c56267]
  - @aws-blocks/auth-common@0.1.4
  - @aws-blocks/core@0.1.17
  - @aws-blocks/bb-kv-store@0.1.5
  - @aws-blocks/bb-logger@0.1.3

## 0.1.6

### Patch Changes

- 53adfb8: fix(bb-auth-oidc): bridge a successful client callback into auth-common's onAuthChange

  A successful client-PKCE `handleRedirectCallback()` only notified this OIDC
  client's own `onAuthStateChange` listeners. Components subscribed via
  `@aws-blocks/auth-common`'s `onAuthChange` — and `<AuthenticatedContent>` —
  never heard about the sign-in, so a React SPA wouldn't re-render after
  completing the redirect exchange (only server-initiated sign-in updated them).

  `handleRedirectCallback()` now also calls `broadcastAuthChange(user)` on success,
  and `signOut()` calls `broadcastAuthChange(null)`, firing the same-window
  `blocks-auth-change` event and the cross-tab `BroadcastChannel`, so every
  auth-common consumer (and other open tabs) re-render on both sign-in and sign-out.
  The README documents the `onAuthChange`/`broadcastAuthChange` wiring and adds an
  OIDC + React SPA example.

## 0.1.5

### Patch Changes

- 607fe57: fix(bb-auth-oidc): make `handleRedirectCallback()` idempotent under double invocation

  `handleRedirectCallback()` consumed the single-use PKCE pending entry from
  `sessionStorage` and only removed it **after** the `/aws-blocks/auth/exchange`
  round-trip. A second concurrent invocation — most commonly React StrictMode's
  mount → unmount → mount, which fires the callback effect twice synchronously —
  either replayed the already-consumed code (failing the second exchange) or
  found the pending entry gone and resolved `null`, stranding the app on a
  signed-out screen despite a successful sign-in.

  The callback now guards on an in-flight promise keyed by the PKCE `code`:
  concurrent/duplicate invocations for the same code share the first call's
  promise instead of starting a second exchange, so both callers resolve to the
  same user and subscribers are notified exactly once. The pending entry is also
  consumed up front (before the network round-trip) so a late duplicate can't
  replay it, and the guard is released once the exchange settles so a genuinely
  new sign-in flow on the same page is never blocked.

## 0.1.4

### Patch Changes

- 03b971a: fix(bb-auth-oidc): surface client `signIn()` failures instead of swallowing them

  The browser client's `signIn()` kicked off the PKCE flow with
  `void this._signInPKCE(...)`, discarding the promise. Any failure during
  sign-in setup — most commonly the `authorize-params` discovery fetch
  returning a non-2xx — became a silent unhandled rejection that callers
  could neither `await` nor `.catch()`, so a broken sign-in looked like a
  no-op to the app.

  `signIn()` now returns `Promise<void>`, propagating the underlying
  `_signInPKCE` promise. Callers can `await auth.signIn(provider)` (or attach
  `.catch()`) to detect and handle failures. The return type is widened
  consistently across the `OIDCClient` interface and the server-side no-op
  stub returned by `getClient()`, so SSR/mock parity is preserved. Existing
  fire-and-forget callers (e.g. `onClick={() => auth.signIn('google')}`)
  are unaffected.

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
- Updated dependencies [683bf49]
  - @aws-blocks/core@0.1.6
  - @aws-blocks/auth-common@0.1.3
  - @aws-blocks/bb-kv-store@0.1.4

## 0.1.3

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
- Updated dependencies [d4a1390]
  - @aws-blocks/auth-common@0.1.2
  - @aws-blocks/bb-app-setting@0.1.3
  - @aws-blocks/bb-kv-store@0.1.3
  - @aws-blocks/bb-logger@0.1.2

## 0.1.2

### Patch Changes

- 18880ff: Minor test improvements
- Updated dependencies [18880ff]
- Updated dependencies [18880ff]
  - @aws-blocks/bb-app-setting@0.1.2
  - @aws-blocks/bb-kv-store@0.1.2
  - @aws-blocks/core@0.1.2

## 0.1.1

### Patch Changes

- 270c049: docs: scrub and port documentation from internal staging repo
- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/auth-common@0.1.1
  - @aws-blocks/bb-app-setting@0.1.1
  - @aws-blocks/bb-kv-store@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
