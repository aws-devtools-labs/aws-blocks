---
"aws-blocks-swift": minor
---

fix(swift): sanitize spec-derived identifiers in generated Swift source

Every name the spec supplies that becomes an identifier (schema and type names, fields,
parameters, operations, enum cases, union variants and discriminator keys) now goes through one
sanitizer and holds only ASCII `[A-Za-z0-9_]`: any other character becomes `_`, and a leading
digit gains a leading `_`. Keywords keep their existing backticks, and an enum case that is a
keyword, such as `default`, is now backticked too. A `CodingKeys` case whose name differs from its
key carries the key as an escaped raw value, now including a discriminator key, so the wire format
is unchanged. A component schema's type is declared once, under the same identifier its references
use. Two names that reduce to one identifier in the same scope, including two servers or two
operations whose types nest in one enum, now fail generation with an error naming both.

Names that held such characters change: an enum value `cost$` generates `case cost_ = "cost$"`,
and a discriminator tag `create$` generates the struct `Create_`.
