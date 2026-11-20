---
"aws-cdk-blocks": patch
"@aws-cdk-blocks/create-blocks-app": patch
"@aws-cdk-blocks/create-block": patch
---

fix(blocks): import block error constants from `aws-cdk-blocks` in client code

`KVStoreErrors`, `DatabaseErrors` and the other block error constants can be imported from `aws-cdk-blocks` in client code. Under the `browser` condition (browser bundles, and `tsx -C browser`, which the templates' `npm run test:e2e` runs) `aws-cdk-blocks` resolved to an empty module, so `import { KVStoreErrors } from 'aws-cdk-blocks'` type-checked and then failed at run time with `does not provide an export named 'KVStoreErrors'`. Its browser entry now exports every block's error constants, `isBlocksError`, `ApiError` and core's other error helpers, `Scope`, and the helpers of `Agent` and `Auth` that run in a browser (`BedrockModels`, `OllamaModels`, `isAuthError`, `customOauth2`, `github`, `relayOrigin`, `stubIdp`). Each one comes from the block's own browser build, so a browser bundle gets no server code and no AWS SDK client. The Building Block classes and `sql` are still not in the browser entry; browser code uses `import type` for their types. `aws-cdk-blocks/client` is unchanged.

`aws-cdk-blocks` now also exports `RealtimeErrors`, which only `@aws-cdk-blocks/bb-realtime` exported before.

`IMPORTS.md` and `npm run docs` list the values the browser entry has. The `api-only` template's e2e test matches `KVStoreErrors.ConditionalCheckFailed` instead of the string `'ConditionalCheckFailedException'`, and the templates' `AGENTS.md` says client code imports error constants from `aws-cdk-blocks`. In contributor mode, `create-block` adds a new block's error constants to the browser entry of `aws-cdk-blocks`.
