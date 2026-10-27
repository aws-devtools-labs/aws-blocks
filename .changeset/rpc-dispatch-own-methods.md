---
"@aws-blocks/core": patch
---

fix(core): two more names an API method map can't be called by

On top of the RPC dispatch guard: a property the method map hides with `Object.defineProperty` (non-enumerable), and any method of a Building Block instance that an API handler returns instead of a method object, now return the same `-32601` "Method not found" error as an unknown name.
