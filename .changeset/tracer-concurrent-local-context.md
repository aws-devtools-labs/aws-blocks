---
'@aws-blocks/bb-tracer': patch
---

Isolate local Tracer state across concurrent async work so independent roots retain separate trace IDs, annotations, metadata, and sampling decisions, while parallel child segments remain siblings.
