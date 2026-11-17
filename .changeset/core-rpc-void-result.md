---
'@aws-blocks/core': patch
---

A method that resolves to `undefined` now answers `{"jsonrpc":"2.0","result":null,"id":1}`. This covers a `Promise<void>` method and any method that can resolve to `undefined`, such as one returning `Promise<T | undefined>`. The response used to leave out `result`, which a JSON-RPC 2.0 success response must carry, so the Kotlin and Swift native clients threw "Missing result field" on every such call. The fix is in the shared dispatcher, so the local dev server, the Lambda handler and the container server all send it. The TypeScript client now resolves such a call to `null` instead of `undefined`.
