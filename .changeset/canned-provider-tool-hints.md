---
"@aws-blocks/bb-agent": patch
---

Improve the local-dev `canned` provider's tool support with two optional tool hints (ignored by real providers) and schema-default awareness:

- `cannedExamples` — realistic tool input, shallow-merged over generated placeholders instead of the generic `sample` values.
- `cannedTriggers` — extra keyword phrases that trigger a tool beyond its name (single- and multi-word phrases match on word boundaries, so `'log in'` won't fire on `"backlog in"`; internal whitespace is flexible).
- Generated placeholder input now respects schema `default` values (from Zod `.default()`).
