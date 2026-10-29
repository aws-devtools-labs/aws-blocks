---
"aws-blocks-kotlin": patch
---

Escape schema-controlled string values (field names, descriptions, patterns, enum values,
discriminator tags, method names, server URLs, defaults) when emitting generated Kotlin source,
so values containing special characters produce well-formed code and round-trip verbatim.
