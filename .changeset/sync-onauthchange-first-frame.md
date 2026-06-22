---
"@aws-blocks/auth-common": patch
---

Fix `onAuthChange` and `Authenticator` to paint a synchronous first frame.

Both previously deferred their initial emit/render behind the async
`ensureState().then(...)`, so a signed-out UI never painted synchronously on
subscribe — leaving a blank first frame and causing non-deterministic timeouts
in CI harnesses (and contradicting `onAuthChange`'s documented "calls callback
immediately" contract). `onAuthChange` now emits the last-known user from the
shared cache synchronously, then refreshes from the async hydration — with a
dedupe to avoid a spurious `null → user` flash and a `.catch` so a rejected
`getAuthState()` never strands the UI. `Authenticator` does the same synchronous
first paint from the cache and gains the same `.catch` hardening.
