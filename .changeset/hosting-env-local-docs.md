---
"@aws-blocks/hosting": patch
---

Docs: the README and the `getSecret()` JSDoc now say local values for `getSecret()` and `getConfig()` go in `.env.local`, the file the Blocks dev server and sandbox load. They don't load `.env`, so a value only there made the getter throw `no config reference found`.
