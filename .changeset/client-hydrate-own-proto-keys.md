---
"@aws-blocks/bb-realtime": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/blocks": patch
---

The client response middleware of `Realtime` and `FileBucket` now keeps every own JSON key of an API response, including `__proto__`, as an ordinary data property, and every object it returns has `Object.prototype` as its prototype. Channel and file descriptors still hydrate into live client handles. Apps need no changes.
