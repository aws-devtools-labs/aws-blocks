---
"@aws-blocks/bb-auth-oidc": patch
---

fix(bb-auth-oidc): surface client `signIn()` failures instead of swallowing them

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
