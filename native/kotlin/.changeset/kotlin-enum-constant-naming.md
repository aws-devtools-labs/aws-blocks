---
"aws-blocks-kotlin": patch
---

Generate a constant name for a string-enum value no identifier can hold

A spec enum containing one of `. ; [ ] / < > : \` — `z.enum(['v1.0', 'v2.0'])`, say — failed code
generation with `IllegalArgumentException: Can't escape identifier`, naming KotlinPoet's internals
rather than the value responsible, and a value that reduced to nothing (`'_'`) failed with
`Char sequence is empty`. A value holding a backtick or a line break generated source that didn't
compile, and one the spec already wrote in backticks lost its serial name, so it deserialized the
wrong value. Every character an identifier can't hold now separates name segments, so
`v1.0` generates `V10` and `okta:corp` generates `OktaCorp`, and a value with no segments at all
generates `Unnamed`. The serial name still carries the literal, so the wire format is unchanged.

A value an identifier can hold keeps the name it already generated, backticked where it has to be,
so `cost$` stays `` `Cost$` ``. Two values that reduce to one name are numbered apart, and a
repeated value is emitted once, rather than generating two constants of one name that don't
compile.
