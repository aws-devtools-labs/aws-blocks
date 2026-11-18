---
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/blocks": patch
---

The local `KVStore` now stores and returns copies of items that went through the same DynamoDB marshalling as the deployed table. Changing an object after `put()`, or a value returned by a read, no longer changes what the next read returns.

Values that DynamoDB can't store, such as an empty `Set`, a `Date`, `NaN` or a class instance, now fail locally as they do on AWS. Values the marshaller converts read back converted, for example a `Map` as a plain object and `undefined` dropped at any depth.
