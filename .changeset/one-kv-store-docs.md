---
"@aws-blocks/core": patch
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-database": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/bb-metrics": patch
"@aws-blocks/bb-secret": patch
---

docs: refer to `KVStore` as the one NoSQL block

Docstrings, READMEs and design notes that pointed at `DistributedTable` now describe `KVStore` with a `schema` and a `key`. No code changes.
