---
"aws-blocks-kotlin": minor
---

Sanitize spec-derived identifiers in generated Kotlin source

Every name the spec supplies that becomes an identifier (types, fields, parameters, operations,
namespaces, servers, union variants, discriminator keys and enum constants) now holds only
`[A-Za-z0-9_]`: any other character becomes `_`, and a leading digit gains a leading `_`. Keywords
keep their existing handling. A field whose identifier differs from its key carries the key as an
escaped `@SerialName`, so the wire format is unchanged. Validation messages name the field's key as
the spec spells it. Two names that reduce to one identifier in the same scope, including two
servers or two operations whose types nest in one object, now fail generation with an error naming
both.

Names that held such characters change: a field `note$` generates `note_`, an operation `get$x`
generates `get_x`, and an enum value `cost$` generates the constant `Cost` instead of `` `Cost$` ``.
