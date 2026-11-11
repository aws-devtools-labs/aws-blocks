---
"aws-blocks-swift": minor
---

fix(swift): sanitize spec-derived identifiers in generated Swift source

Every name the spec supplies that becomes an identifier (schema and type names, fields,
parameters, operations, enum cases, union variants and discriminator keys) now goes through one
sanitizer and holds only ASCII `[A-Za-z0-9_]`: any other character becomes `_`, and a leading
digit gains a leading `_`. Keywords keep their existing backticks, and an enum or union case that
is a keyword is now backticked too: a `default` tag generates `` case `default` `` and a `class`
tag `` case `class`(Class) ``. Of the discriminator tags that name a reserved type, only `self`
and `type` change: they generate `case selfValue(SelfValue)` and `case typeValue(TypeValue)`.
Every other tag keeps its variant name, so `text` still generates `case text(Text)`. An inline
enum on a field named `self` is named after its parent, as one on a field named `type` already is.
A `CodingKeys` case whose name differs from its key carries the key as an escaped raw value, now
including a discriminator key, so the wire format is unchanged. A component schema's type is
declared once, under the same identifier its references use. Two names that reduce to one
identifier in the same scope, including two servers or two operations whose types nest in one
enum, now fail generation with an error naming both.

Names that held such characters change: an enum value `cost$` generates `case cost_ = "cost$"`,
and a discriminator tag `create$` generates the struct `Create_`.
