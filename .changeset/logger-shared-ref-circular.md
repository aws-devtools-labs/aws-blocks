---
"@aws-blocks/bb-logger": patch
---

Serialize an object that appears more than once in a log context every time it appears. `log.info('x', { a: o, b: o })` now logs `b` in full instead of `"[Circular]"`; only a reference back to an object on its own path is replaced with `"[Circular]"`.
