---
"@aws-blocks/bb-auth-oidc": patch
---

docs(bb-auth-oidc): document the `broadcastAuthChange` → `onAuthChange` bridge for SPAs (#79)

`handleRedirectCallback()` notifies only the OIDC client's own `onAuthStateChange` subscribers, not `@aws-blocks/auth-common`'s `onAuthChange(...)` / `<AuthenticatedContent>`. A React SPA using the client-PKCE redirect flow must call `broadcastAuthChange(user)` after a successful callback for auth-aware components to re-render. The README now documents this wiring with an end-to-end OIDC + React SPA example, and new unit tests pin the documented behavior (the callback alone does not reach `onAuthChange`; `broadcastAuthChange` does; a failed callback broadcasts nothing).

This is the remaining part (c) of #79; the `signIn()` error-surfacing (a) and `handleRedirectCallback()` idempotency (b) parts shipped earlier.
