---
'@aws-blocks/bb-logger': patch
---

Log entries now serialize an object referenced more than once (for example `{ requester: user, owner: user }` or repeated array elements) in full instead of replacing later occurrences with `"[Circular]"`. Only true circular references are replaced. To keep a log line bounded when context holds a large shared graph, an entry re-serializes shared objects at most 1000 times; later repeats are replaced with `"[Repeated]"`.
