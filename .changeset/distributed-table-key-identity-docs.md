---
"@aws-blocks/bb-distributed-table": patch
---

The `DistributedTable` README now states that the primary key is an item's identity: `get()`, `put()`, `delete()` and the `ifNotExists` / `ifExists` conditions match the whole key (partition key plus sort key), so with a composite key the sort key field is unique only within its partition. A short example shows how to make a field unique across the table and list grouped items from an index. The error-handling example in the README and in the `DistributedTableErrors` JSDoc now maps a failed condition to the API's own named `ApiError` instead of leaving the branch empty, and imports from `@aws-blocks/blocks`; the README also notes that the error's name value is `'ConditionalCheckFailedException'`. The Query section now shows how to page through results with a sort-key bound and `limit`, and the examples note what a hand-written Standard Schema validator returns.
