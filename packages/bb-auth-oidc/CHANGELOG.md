# @aws-blocks/bb-auth-oidc

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
