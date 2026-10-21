---
"aws-blocks-swift": patch
---

fix(swift): escape schema string values in generated Swift source

Schema-controlled string values (field names, descriptions, patterns, enum values,
discriminator tags, method names, server URLs, defaults) are now escaped when emitted into
generated Swift source, so values containing special characters produce well-formed code and
round-trip verbatim.
