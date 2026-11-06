---
"@aws-blocks/bb-realtime": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/blocks": patch
---

The client response middleware of `Realtime`, `FileBucket` and `AuthOIDC` now keeps every own JSON key of an API response, including `__proto__`, as an ordinary data property, and every object it returns has `Object.prototype` as its prototype. Channel, file and OIDC descriptors still hydrate into live client handles. Apps need no changes.
