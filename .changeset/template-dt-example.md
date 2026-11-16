---
"@aws-blocks/create-blocks-app": patch
---

The commented `DistributedTable` example in the `bare` template now shows a secondary index (`indexes` is an object keyed by index name, not an array), a point read with `get()` that takes the whole key as an object, and a newest-first index query with `order: 'desc'` (the values are `'asc'` and `'desc'`). The `api-only` template's items table gains the same index and sort-order notes as comments.
