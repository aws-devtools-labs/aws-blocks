---
"@aws-blocks/bb-kv-store": patch
---

`KVStore` now rejects more malformed input with `KVStoreErrors.InvalidQuery`, the same way locally and on AWS, before it calls DynamoDB. A `query()` `order` other than `'asc'` or `'desc'` (for example `'DESC'`) used to sort ascending without a sign. An `indexes` option given as an array used to declare indexes named `'0'`, `'1'`, and so on; the constructor now rejects it, at synth too. The error for an unknown index lists the declared indexes. A `deleteBatch()` with one bad key deletes nothing locally, as on AWS. The message of a failed condition now starts with the error name, `ConditionalCheckFailedException`.
