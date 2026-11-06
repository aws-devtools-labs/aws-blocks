---
"@aws-blocks/bb-distributed-table": patch
---

fix: store items with nested `undefined` values on AWS, and keep local index queries sparse

On AWS, `put`, `putBatch` and `ifFieldEquals` no longer fail when an item contains `undefined` inside a map or list (for example an optional field of a nested object). Both the local mock and AWS now drop `undefined` map properties and store `undefined` list entries as `null`, so list positions are preserved: `[1, undefined, 3]` reads back as `[1, null, 3]`.

Local index queries no longer return items that lack the index's sort-key attribute, matching DynamoDB's sparse indexes.
