---
"@aws-blocks/core": patch
"@aws-blocks/hosting": patch
"@aws-blocks/pipeline": patch
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/blocks": patch
---

Faster `tsc --noEmit` in apps. The framework packages import `aws-cdk-lib/core` and the service modules by subpath instead of the root barrel, and the `scripts` entry no longer names AWS SDK client types in its public signatures. A fresh app's typecheck reads about 2,650 declaration files instead of 4,300, and new apps' `aws-blocks/index.cdk.ts` imports `aws-cdk-lib/core`. Existing apps can make the same one-line change; `import * as cdk from 'aws-cdk-lib'` keeps working.
