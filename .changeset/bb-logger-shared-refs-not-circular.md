---
'@aws-blocks/bb-logger': patch
---

Log entries now serialize an object referenced more than once (for example `{ requester: user, owner: user }` or repeated array elements) in full instead of replacing later occurrences with `"[Circular]"`. Only true circular references are replaced.
