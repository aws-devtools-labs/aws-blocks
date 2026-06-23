---
"@aws-blocks/bb-auth-oidc": patch
---

fix(bb-auth-oidc): make `handleRedirectCallback()` idempotent under React StrictMode

`handleRedirectCallback()` removed the single-use PKCE state from `sessionStorage` only AFTER the exchange `await`, so a second invocation (React 18 StrictMode's double-mount, a double-click, or a re-render) read the same pending state and replayed the single-use authorization `code` — which the IdP/exchange rejects — throwing on the second call and stranding the app. It now consumes the pending state synchronously before the await and caches the in-flight exchange per `code`, so concurrent or sequential re-invocations reuse the same exchange and both resolve to the same user. The first successful flow always completes and renders.

Part 2 of a 3-PR stack splitting the bb-auth-oidc SPA fixes (errors → idempotency → broadcast bridge).
