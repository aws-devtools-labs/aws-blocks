---
"@aws-blocks/bb-agent": patch
---

Improve the local-dev `canned` provider's tool support with two optional tool hints (ignored by real providers) and schema-default awareness:

- `cannedExamples` — realistic tool input, shallow-merged over generated placeholders instead of the generic `sample` values.
- `cannedTriggers` — extra keyword phrases that trigger a tool beyond its name (single- and multi-word phrases match on word boundaries, so `'log in'` won't fire on `"backlog in"`; internal whitespace is flexible).
- Generated placeholder input now respects schema `default` values (from Zod `.default()`).

Also fixes three pre-existing rough edges in the same provider:

- Generated input now resolves `const`, `enum`, and `anyOf`/`oneOf` (Zod union) properties. Previously a property that was a union, a const, or untyped and carried no `default` matched no branch and was dropped — and a *required* field of that shape made the emitted call fail schema validation before the tool ran. A required field of an otherwise unrecognized shape now falls back to a string; optional ones stay omitted, since absence is valid there.
- The canned *text* responses (`weather`/`order`/`help`) now match on word boundaries like tool matching does, so `"reorder"` no longer returns the order response and `"helper"` no longer returns the help response.
- A `cannedExamples` key that isn't a field of the tool's schema now logs a one-time warning naming the tool and field, since it is almost always a typo. It never throws and the value is still sent — a bad hint must not break local dev.

Patch (not minor) per the pre-1.0 caret convention — the change is additive and backward-compatible.
