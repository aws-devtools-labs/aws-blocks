---
"@aws-blocks/bb-knowledge-base": patch
---

docs: the KnowledgeBase docs state when `isSynced()` returns `true` without an ingestion job

The condition is a handler config without a data source id, rather than "a deployment that predates the sync API".
