---
"@aws-blocks/bb-data": patch
"@aws-blocks/blocks": patch
---

`Database.transaction()` (including on `withRLS()`) now re-throws an `ApiError` or another Building Block's error from its callback unchanged after rolling back. A 409 you throw to abort a transaction now reaches the client as that 409, with its own name, instead of a 500 `TransactionFailed`, and `instanceof` checks on it still match. A plain `Error` thrown by the callback is still reported as `TransactionFailed`. If you unwrapped `e.cause` to get your error back, you no longer need to.
