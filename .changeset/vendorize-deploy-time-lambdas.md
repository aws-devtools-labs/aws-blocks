---
'@aws-blocks/core': patch
'@aws-blocks/bb-auth': patch
'@aws-blocks/bb-distributed-table': patch
'@aws-blocks/bb-data': patch
'@aws-blocks/bb-distributed-data': patch
'@aws-blocks/blocks': patch
---

Vendorized apps using `DistributedTable` with an index, `Database` with migrations, or `DistributedDatabase` now synthesize. A vendorized copy (`npm run vendorize -- <Block>`) contains only the TypeScript sources, so these blocks' deploy-time Lambdas (the GSI manager and the migration runner) previously failed synth with `Cannot find asset` or `Cannot find entry file`. Their handlers are now bundled from the vendorized source at synth, so your edits to them deploy too. Installed (non-vendorized) apps are unchanged: their Lambda assets are byte-for-byte the same.

`@aws-blocks/core/cdk` (and `@aws-blocks/blocks/cdk`) now exports the helpers that do this, `deployTimeLambdaCode()` and `deployTimeLambdaEntry()`, for Building Block authors who ship a pre-bundled or compiled Lambda handler. `Auth` uses them too.
