---
'@aws-blocks/core': patch
---

Reading a scope's `fullId` now evaluates each ancestor's `fullId` once instead of twice, so its cost grows linearly with nesting depth rather than exponentially. The resulting IDs are unchanged.
