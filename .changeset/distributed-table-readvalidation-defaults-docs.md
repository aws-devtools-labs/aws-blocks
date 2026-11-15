---
"@aws-blocks/bb-distributed-table": patch
---

The `DistributedTable` README no longer says that schema defaults are left off when an older row is read. With the default `readValidation: 'coerce'`, and also with `'strict'`, a field added with `.default()` is filled in on the value that `get()`, `getBatch()`, `query()` and `scan()` return. The stored row is not rewritten; the default is saved only when you `put()` the returned item back. Only `readValidation: 'off'` returns the row without the field.
