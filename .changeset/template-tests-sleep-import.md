---
"@aws-blocks/create-blocks-app": patch
---

The `test/e2e.test.ts` file in new apps no longer hides the global `setTimeout`. It imported `setTimeout` from `node:timers/promises` under that name, so a test you added that called `setTimeout(() => …, ms)` failed with a type error. The promise version is now imported as `sleep`.
