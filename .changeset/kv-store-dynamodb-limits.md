---
"@aws-cdk-blocks/bb-kv-store": patch
"aws-cdk-blocks": patch
---

`KVStore` now rejects calls that DynamoDB rejects, the same way locally and on AWS, before it calls DynamoDB. Before, they succeeded locally and failed only after deploy. A batch that repeats a key within one DynamoDB request (25 writes or 100 reads) and a `between` with its bounds reversed throw `KVStoreErrors.InvalidQuery`. A partition key value over 2,048 bytes, a sort key value over 1,024 bytes (for the table or an index), and lists or maps nested more than 32 levels deep throw `KVStoreErrors.ValidationFailed`. The checks cover reads (`get`, `getBatch`, `query`) as well as writes and deletes. On AWS these calls used to fail with DynamoDB's own `ValidationException`, so code that matched that name should match the `KVStoreErrors` names instead.

The local mock now measures item size the way DynamoDB does instead of by JSON length, and compares strings in DynamoDB's UTF-8 byte order, so a query over non-ASCII sort keys returns the same items in the same order as on AWS.
