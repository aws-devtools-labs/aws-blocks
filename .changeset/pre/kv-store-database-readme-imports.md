---
"@aws-cdk-blocks/bb-kv-store": patch
"@aws-cdk-blocks/bb-database": patch
---

docs: the `KVStore` and `Database` README examples now import from `aws-cdk-blocks`, which every scaffolded app depends on, so a copied example compiles. The `/kysely` and `/testing` entry points still come from `@aws-cdk-blocks/bb-database`.
