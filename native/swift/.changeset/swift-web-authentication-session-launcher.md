---
"aws-blocks-swift": minor
---

feat(swift): sign in with OIDC through ASWebAuthenticationSession

`WebAuthenticationSessionLauncher` is a `BrowserLauncher` built on `ASWebAuthenticationSession`, so an app can sign in with an `OIDCClient` without writing a launcher of its own. On iOS it opens the system's sign-in sheet; on macOS the system opens the sign-in in the user's default browser when that browser supports it, else in Safari. `signIn(provider:relayTo:)` uses one at its defaults: `try await oidc.signIn(provider: .google, relayTo: "myapp://auth")`. To choose the window the sheet opens over (`presentationAnchor:`, which an app that can show more than one window should pass) or to ask for a private browser session (`prefersEphemeralWebBrowserSession:`), pass one to `signIn(provider:relayTo:launcher:)`.

- `relayTo` must use a custom URL scheme that the `Auth` block allows as a relay origin. A relay target with no scheme, or with `http` or `https`, throws `OIDCError.callbackError` before the sheet opens. An authorize URL that isn't `http` or `https` throws `OIDCError.invalidAuthorizeURL`.
- Closing the sheet throws `OIDCError.cancelled`. Cancelling the task that called `signIn` dismisses the sheet and throws `CancellationError`. A sheet the system won't show, for example while the app is in the background, throws `OIDCError.callbackError` with the system's error as `underlyingError`.
- One sign-in opens at a time. A second one while a sheet is open throws `OIDCError.callbackError` before anything opens, and so does signing in on iOS while the app shows no window.
- `BrowserLauncher`'s documentation now says what a launcher throws: `OIDCError.cancelled` when the user backs out, `CancellationError` when the task is cancelled, and `OIDCError.callbackError` with the original error as its cause for any other failure.
