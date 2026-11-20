---
"aws-blocks-swift": patch
---

fix(swift): keep a sign-in or sign-out that finishes while `restore()` is in flight

`OIDCClient.restore()` now ignores its response when a sign-in or sign-out on the same client
finished while the request was in flight. A late 401 no longer signs out a user who just signed in
or clears their new tokens, and a late session no longer signs a user back in after a sign-out. In
that case `restore()` emits nothing and returns the user of the current `authState`, or `nil`.
