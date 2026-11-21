---
'@aws-cdk-blocks/bb-kv-store': minor
---

Add `appendToList(key, field, items)` to `KVStore`. It appends items to a list field of a stored object value in one atomic step and returns the new list, so two callers that append at the same time no longer lose an append to a `get` and `put` of the whole value. On AWS it is one DynamoDB `UpdateItem` with `list_append`; the local mock applies the same change with no `await` between its read and its write.

The key must hold a value: a key with no value throws `ConditionalCheckFailedException` (409, not retriable), so a stored value keeps passing the schema. A field that is absent starts as an empty list. With a `schema`, the items are validated against the schema of the field before the call. The field cannot be a key field, an indexed field, or the `ttl` field, and the TypeScript types accept only list fields and their element type.
