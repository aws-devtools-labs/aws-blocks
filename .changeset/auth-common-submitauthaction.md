---
"@aws-blocks/auth-common": patch
---

Add `submitAuthAction(api, input)` — a browser-only helper that calls `setAuthState` and then drives the local auth notification so `onAuthChange` subscribers and `AuthenticatedContent` re-render on a real signed-in/signed-out transition. This closes the `setAuthState` → `onAuthChange` reactivity gap where a custom auth UI stayed stale unless it also called `broadcastAuthChange` by hand. The framework's own `Authenticator` now routes every action through `submitAuthAction` as the single notifier, so there is no double-fire; challenge/retriable states are not broadcast. Fixes #185.
