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
both. A namespace matching a reserved file name in any letter case now has its API suffixed, so
`seRvers` generates `SeRversApi` and `tYPES` generates `TYPESApi`, and two namespaces whose
generated names differ only in case now fail generation.

Names that held such characters change: a field `note$` generates `note_`, an operation `get$x`
generates `get_x`, and an enum value `cost$` generates the constant `Cost` instead of `` `Cost$` ``.
Non-ASCII letters are no longer kept in identifiers: an enum value `café` generates `Caf` instead of
`Café`, and a field `café` generates `caf_` with `@SerialName("café")`.
