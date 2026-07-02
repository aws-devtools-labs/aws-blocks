---
"@aws-blocks/bb-auth-basic": patch
---

Keep AuthBasic error constants browser-safe by exporting them from a shared module instead of re-exporting through the server entry.
