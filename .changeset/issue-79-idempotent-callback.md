---
"@aws-blocks/bb-auth-oidc": patch
---

fix(bb-auth-oidc): make `handleRedirectCallback()` idempotent under double invocation

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
