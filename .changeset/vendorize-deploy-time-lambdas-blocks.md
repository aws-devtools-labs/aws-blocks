---
'@aws-blocks/core': patch
'@aws-blocks/bb-distributed-table': patch
'@aws-blocks/bb-data': patch
'@aws-blocks/bb-distributed-data': patch
'@aws-blocks/blocks': patch
---

Vendorized apps using `DistributedTable` with an index, `Database` with migrations, or `DistributedDatabase` now synthesize. A vendorized copy (`npm run vendorize -- <Block>`) contains only the TypeScript sources, so these blocks' deploy-time Lambdas (the GSI manager and the migration runner) previously failed synth with `Cannot find asset` or `Cannot find entry file`. Their handlers are now bundled from the vendorized source at synth, so your edits to them deploy too. Installed (non-vendorized) apps are unchanged: their Lambda assets are byte-for-byte the same.

The helpers that do this, `deployTimeLambdaCode()` and `deployTimeLambdaEntry()`, are framework-internal (`@aws-blocks/core/cdk/internal`), for Building Blocks in this repository that ship a pre-bundled or compiled Lambda handler; they are not on the public `@aws-blocks/core/cdk` or `@aws-blocks/blocks/cdk` entry.
