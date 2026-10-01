---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

chore(core): declare the `@aws-sdk/lib-dynamodb` devDependency it already uses

`packages/core`'s `client-user-agent.test.ts` imports `@aws-sdk/lib-dynamodb`
but never declared it, relying on the package being hoisted to the root by
`bb-kv-store`/`bb-distributed-table`. A dependency bump that reshuffles hoisting
drops that incidental resolution and breaks `core`'s build with TS2307. Declare
it as a devDependency so the import resolves regardless of hoisting.
