---
"@aws-blocks/bb-auth-oidc": patch
---

fix(bb-auth-oidc): surface `signIn` errors, make the redirect callback idempotent, and bridge to the shared auth bus

Three browser/SPA developer-experience fixes:

- **`signIn()` no longer swallows errors.** It now returns `Promise<void>`, so `await auth.signIn(...)` and `.catch(...)` observe failures (e.g. an unreachable `authorize-params` endpoint). Fire-and-forget callers (`onClick={() => auth.signIn('google')}`) still work and now log the failure to `console.error` instead of producing a silent unhandled rejection.
- **`handleRedirectCallback()` is idempotent.** It consumes the single-use PKCE state from `sessionStorage` synchronously *before* the exchange await, and caches the in-flight exchange per authorization `code`. A React StrictMode double-mount, double-click, or re-render reuses the same exchange and resolves to the same user instead of replaying the single-use `code` (which the IdP rejects). The first successful flow always completes and renders; a genuinely-already-consumed second call returns `null` harmlessly.
- **Auth state is bridged to the shared bus.** A successful exchange and `signOut()` now call `broadcastAuthChange(...)` from `@aws-blocks/auth-common`, so `onAuthChange` listeners and the `<Authenticator>` / `<AuthenticatedContent>` components update automatically (same window and across tabs) — previously only the package-local `onAuthStateChange` subscribers were notified. The README gains a React SPA example wiring the callback and `onAuthChange`.
