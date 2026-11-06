---
"@aws-blocks/bb-data": patch
"@aws-blocks/data-common": patch
"@aws-blocks/blocks": patch
---

Fix local `bb-data` transactions committing or rolling back unrelated writes when asynchronous operations overlap. Transactions now use PGlite's transaction API to serialize the entire transaction and keep ordinary queries outside it. Failed commits release waiting operations, and subsequent rollback cleanup cannot affect the next transaction.

Within a transaction callback, use its supplied transaction object. Awaiting work on the parent database inside that callback waits for the current transaction and can deadlock locally.
