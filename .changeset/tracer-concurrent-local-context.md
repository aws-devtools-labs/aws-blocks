---
'@aws-blocks/bb-tracer': patch
---

Isolate local Tracer state across concurrent async work so independent roots retain separate trace IDs, annotations, metadata, and sampling decisions, while parallel child segments remain siblings.

Ignore completed async contexts so deferred work starts a new trace after its root closes, or attaches to the nearest open ancestor while the root is still active.
