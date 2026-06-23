---
"@aws-blocks/bb-auth-oidc": patch
---

fix(bb-auth-oidc): bridge OIDC sign-in to the shared auth bus and document the SPA flow

`handleRedirectCallback()` called only the package-local `notify()` (its own `onAuthStateChange` subscribers) and `index.browser.ts` never imported `@aws-blocks/auth-common`, so `onAuthChange` listeners and the shared `<Authenticator>` / `<AuthenticatedContent>` components never updated on OIDC sign-in. A successful exchange now also calls `broadcastAuthChange(user)`, and `signOut()` broadcasts `null`, so those consumers update automatically (same window and across tabs). The README gains a React SPA example wiring `handleRedirectCallback()` and showing `onAuthChange` updating with no manual wiring.

Part 3 of a 3-PR stack splitting the bb-auth-oidc SPA fixes (errors → idempotency → broadcast bridge).
