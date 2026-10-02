---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

chore(core): declare the `@aws-sdk` devDependencies its tests already use

`packages/core`'s `client-user-agent.test.ts` dynamically imports
`@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` but never declared them,
relying on the packages being hoisted to the root by `bb-kv-store`/
`bb-distributed-table`. A dependency bump that reshuffles hoisting drops that
incidental resolution and breaks `core`'s build. Declare both as
devDependencies so the imports resolve regardless of hoisting.
