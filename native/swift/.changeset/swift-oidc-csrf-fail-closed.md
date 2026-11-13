---
"aws-blocks-swift": patch
---

fix(swift): refuse a relayed sign-in whose state can't be checked against its csrf

`OIDCClient.signIn` now throws `OIDCError.stateMismatch` when the server's signed state has no
payload that decodes to JSON with a `csrf`, as it already did when the `csrf` differed. Before, such
a state skipped the check and the sign-in went ahead.
