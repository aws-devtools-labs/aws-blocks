---
"@aws-blocks/bb-tracer": patch
---

fix(bb-tracer): make sampling a per-trace decision so all spans within a trace share the same sampling outcome
