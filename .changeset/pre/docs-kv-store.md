---
"@aws-cdk-blocks/bb-kv-store": patch
---

docs: there is no atomic increment; the conditional-writes section shows two ways to keep a concurrent counter. The transaction pointer names `transaction()` on `Database` instead of two packages that do not exist.
