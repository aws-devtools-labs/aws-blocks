---
"@aws-blocks/bb-auth-oidc": patch
---

fix(bb-auth-oidc): bridge a successful client callback into auth-common's onAuthChange

A successful client-PKCE `handleRedirectCallback()` only notified this OIDC
client's own `onAuthStateChange` listeners. Components subscribed via
`@aws-blocks/auth-common`'s `onAuthChange` — and `<AuthenticatedContent>` —
never heard about the sign-in, so a React SPA wouldn't re-render after
completing the redirect exchange (only server-initiated sign-in updated them).

`handleRedirectCallback()` now also calls `broadcastAuthChange(user)` on success,
firing the same-window `blocks-auth-change` event and the cross-tab
`BroadcastChannel`, so every auth-common consumer (and other open tabs) re-render.
The README documents the `onAuthChange`/`broadcastAuthChange` wiring and adds an
OIDC + React SPA example.
