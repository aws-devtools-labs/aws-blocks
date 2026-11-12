---
"aws-blocks-swift": minor
---

feat(swift): add `userSub`, `signInProvider` and `attributes` to `OIDCUser`

`OIDCUser` now carries the optional `userSub`, `signInProvider` and `attributes` the `Auth` block
sends with a signed-in user, beside `userId`, `username` and `groups`. Each is `nil` when the
server sends none. The new `init` parameters default to `nil`, so existing calls still compile.
