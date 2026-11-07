---
"@aws-blocks/bb-kv-store": minor
---

feat(bb-kv-store): add a `consistentRead` option to `get()`

`KVStore.get` now accepts an optional second argument, `{ consistentRead: true }`. On AWS it makes a strongly consistent DynamoDB read that reflects every write that succeeded before it. Reads stay eventually consistent by default. A strongly consistent read costs twice the read capacity. The local mock is always consistent and accepts the option.
