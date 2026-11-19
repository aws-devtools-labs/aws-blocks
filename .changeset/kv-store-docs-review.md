---
'@aws-cdk-blocks/bb-kv-store': patch
'aws-cdk-blocks': patch
---

docs(bb-kv-store): correct the `encryption` and `LegacyKVStore` docs, and give every `KVStore` method an example

- The `encryption` docstring said that a dedicated KMS key stays in the account after stack teardown. The key follows the removal policy of its table, so the key of a `'disposable'` table is scheduled for deletion with the table.
- The `LegacyKVStore` docs say what the class has: the methods of release 0.4.0, with `limit`, `cursor`, and `expiresAt` on `scan`, and a consistent `get`.
- The README has a table of the `scan` options, states the rule for a `null` option next to the API table, and lists what to know about the upgrade before its steps.
- Each public `KVStore` method has an `@example`, and the docstrings of the mock entry state how a read behaves on AWS.
- `DESIGN.md` uses one name for release 0.4.0 and shorter sentences. Its content does not change.
- The docstrings use shorter sentences and plain punctuation. No parameter, error, or example is removed.
