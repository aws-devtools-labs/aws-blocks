---
"@aws-cdk-blocks/bb-kv-store": patch
"@aws-cdk-blocks/bb-database": patch
---

docs: import the README examples from `aws-cdk-blocks`

The `KVStore` and `Database` README examples imported from `@aws-cdk-blocks/core`, `@aws-cdk-blocks/bb-auth`, `@aws-cdk-blocks/bb-kv-store` and `@aws-cdk-blocks/bb-database`, which an app made with `npm create @aws-cdk-blocks/blocks-app` does not declare, so a copied example did not compile. They now import from the umbrella package `aws-cdk-blocks`, which every such app depends on. The `/kysely` and `/testing` entry points still come from `@aws-cdk-blocks/bb-database`.

The `KVStore` README also pointed to `transaction()` in packages that do not exist; it now links to `Database` transactions.
