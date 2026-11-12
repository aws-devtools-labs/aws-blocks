---
"aws-blocks-swift": minor
---

fix(swift): generate compilable code for spec names that aren't Swift identifiers

A component schema whose name isn't a Swift identifier is now declared and referenced under the same
sanitized type name, so an operation that takes or returns it compiles. Two such schemas that sanitize
to one name are numbered (`_2`, `_3`, …). A field or enum value named only with characters Swift can't
use (`$`, `*/`) now generates `_unnamed` or `__unnamed` instead of an undeclarable `_` or a bare `__`,
and a name that starts with a digit keeps it (`9lives` generates `_9lives`, no longer `_lives`). The
original names still reach the wire through `CodingKeys` raw values, so the wire format is unchanged.
