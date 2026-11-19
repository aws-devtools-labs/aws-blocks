---
"aws-blocks-swift": minor
---

feat(swift): add `displayName` to `OIDCUser`

`OIDCUser.displayName` is the name to show a signed-in user, for display only. It is `nil` when the
server sends none: the code exchange doesn't, while `restore()` reads it from the session. Fall back
to `username`. The new `init` parameter defaults to `nil`, so existing calls still compile.
