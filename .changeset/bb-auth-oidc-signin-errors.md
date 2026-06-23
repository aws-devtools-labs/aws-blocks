---
"@aws-blocks/bb-auth-oidc": patch
---

fix(bb-auth-oidc): `signIn()` surfaces errors instead of swallowing them

`signIn()` was fire-and-forget (`void this._signInPKCE(...)` with no `.catch`), so a failed cross-origin authorize-params fetch became a silent unhandled rejection and the caller never knew sign-in hadn't started. It now returns `Promise<void>`, so callers can `await auth.signIn(...)` / `.catch(...)`, while fire-and-forget callers (`onClick={() => auth.signIn('google')}`) get the failure logged to `console.error` instead of losing it. The public `OIDCClient` interface and the server-side stub are updated to match.

Part 1 of a 3-PR stack splitting the bb-auth-oidc SPA fixes (errors → idempotency → broadcast bridge).
