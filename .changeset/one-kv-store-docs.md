---
"@aws-cdk-blocks/core": patch
"@aws-cdk-blocks/bb-app-setting": patch
"@aws-cdk-blocks/bb-database": patch
"@aws-cdk-blocks/bb-file-bucket": patch
"@aws-cdk-blocks/bb-knowledge-base": patch
"@aws-cdk-blocks/bb-metrics": patch
"@aws-cdk-blocks/bb-secret": patch
---

docs: refer to `KVStore` as the one NoSQL block

Docstrings, READMEs and design notes that pointed at `DistributedTable` now describe `KVStore` with a `schema` and a `key`. No code changes.
