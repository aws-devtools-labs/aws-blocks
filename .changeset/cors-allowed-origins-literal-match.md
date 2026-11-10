---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/bb-lambda-compute": patch
---

`defaults.allowedOrigins`: plain origins such as `https://app.example.com` now match exactly (case-insensitive), so their dots are literal. Entries with regex syntax are still anchored regexes, but must compile on their own and escape `.` (unless followed by a quantifier, as in `.*`). Invalid entries now fail `cdk synth` from `BlocksStack.create()` / `BlocksBackend.create()` with a message naming the entry, and are ignored (and logged) at runtime. The README examples now use plain origins.
