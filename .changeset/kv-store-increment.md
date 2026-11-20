---
"@aws-cdk-blocks/bb-kv-store": minor
---

feat(bb-kv-store): `KVStore.increment()` adds to a number field atomically

`increment(key, field, { by, ifExists })` adds `by` (a safe integer, default
`1`, negative to subtract) to one top-level number field of a value and returns
the new value. Concurrent calls lose no update, so a counter no longer needs a
`get` followed by a `put`. On AWS it is one DynamoDB `UpdateItem` with `ADD`;
the local mock reads, checks and writes the item in one step.

An absent item is created with the key and the field alone when the schema
accepts that value, or when the store has no schema. When the schema needs more
fields, or with `{ ifExists: true }`, `increment` only updates an item that
exists and throws `ConditionalCheckFailedException` (409, not retriable) for an
absent key. A field that is not a number field of the store, or a `by` that is
not a safe integer, is `InvalidQueryException`; a stored field that is not a
number, or a stored value that is not an object, is `ValidationFailedException`.
The field type is checked at compile time too: only the number fields of the
value, other than the key fields, are accepted.
