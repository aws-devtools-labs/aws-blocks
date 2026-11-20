---
"@aws-blocks/bb-logger": patch
---

Serialize an object that appears more than once in a log context instead of marking it circular. `log.info('x', { a: o, b: o })` now logs `b` in full instead of `"[Circular]"`; only a reference back to an object on its own path is replaced with `"[Circular]"`. One object is written out at most 8 times per log entry, and later references to it are replaced with `"[Repeated]"`, so a deeply shared object graph cannot produce an oversized line.
