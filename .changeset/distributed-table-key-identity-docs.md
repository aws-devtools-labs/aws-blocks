---
"@aws-blocks/bb-kv-store": patch
---

The `KVStore` README now states that the key is the identity of an item: `get()`, `put()`, `delete()` and the `ifNotExists` / `ifExists` conditions match the whole key (the partition field plus the sort field), so in a store with a sort field that field is unique only in its partition. It says how to make a field unique in the whole store and list grouped items from an index.
