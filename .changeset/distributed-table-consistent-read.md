---
"@aws-blocks/bb-distributed-table": minor
"@aws-blocks/blocks": minor
---

feat(bb-distributed-table): add a `consistentRead` option to `get()`

`get(key, { consistentRead: true })` reads the item with a strongly consistent DynamoDB `GetItem` (`ConsistentRead: true`), so it sees every write that succeeded before the read. Use it when the next step depends on an item that was just written, such as an existence or ownership check. Without the option `get()` stays eventually consistent, as before. A strongly consistent read costs twice the read capacity. The local mock is always strongly consistent and accepts the option.

The new `GetOptions` type is exported from `@aws-blocks/bb-distributed-table`, and from the umbrella `@aws-blocks/blocks` as `DTGetOptions`.
