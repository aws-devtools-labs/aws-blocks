---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/bb-lambda-compute": patch
---

`defaults.allowedOrigins`: plain origins such as `https://app.example.com` now match exactly (case-insensitive), so their dots are literal. `http`/`https` plain origins are compared in the form the browser sends (default port dropped, internationalized hosts in punycode), and entries with user info, a path, a query or a fragment are rejected. Entries with regex syntax are still anchored regexes, but must compile on their own and escape `.` (unless followed by a quantifier, as in `.*`); glob-style entries such as `https://*.example.com` and patterns with nested quantifiers such as `(a+)+` are rejected, and brace quantifiers are limited to `{n}`. Invalid entries now fail `cdk synth` from `BlocksStack.create()` / `BlocksBackend.create()` with a message naming the entry, and are ignored (and logged) at runtime. The README examples now use plain origins, and suggest `https://[a-z0-9-]+\\.example\\.com` for subdomains.
