---
"@aws-blocks/bb-kv-store": minor
---

feat(bb-kv-store): add a `consistentRead` option to `get()`

`KVStore.get` accepts an optional second argument, `{ consistentRead }`. On AWS, a strongly consistent DynamoDB read reflects every write that succeeded before it, and costs twice the read capacity. `get` is strongly consistent by default. Pass `{ consistentRead: false }` where a stale value is acceptable. The local mock is always consistent and accepts the option.
