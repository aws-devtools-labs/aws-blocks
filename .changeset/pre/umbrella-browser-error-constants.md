---
"aws-cdk-blocks": patch
"@aws-cdk-blocks/create-blocks-app": patch
"@aws-cdk-blocks/create-block": patch
---

fix(blocks): client code can now import the block error constants, `isBlocksError`, and `ApiError` from `aws-cdk-blocks`. Before, `import { KVStoreErrors } from 'aws-cdk-blocks'` type-checked and then failed in the browser with `does not provide an export named 'KVStoreErrors'`. The Building Block classes and `sql` are still server-only, so browser code uses `import type` for their types. `aws-cdk-blocks` now also exports `RealtimeErrors`.
