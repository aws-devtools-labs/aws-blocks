---
"@aws-blocks/core": patch
---

`removeSecret()` from `@aws-blocks/core/scripts` now accepts `force: true`, matching `blocks secret remove --force`: the secret is deleted immediately instead of being scheduled for deletion, so its name is free to reuse at once.
