---
"@aws-blocks/create-block": patch
---

fix(create-block): trim trailing whitespace in linear time

Wiring a new block into an exports file now uses `trimEnd()` instead of a regex, which took quadratic time on long runs of whitespace before other content.
