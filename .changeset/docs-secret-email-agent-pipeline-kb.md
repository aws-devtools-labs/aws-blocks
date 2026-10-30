---
'@aws-blocks/bb-secret': patch
'@aws-blocks/bb-email-client': patch
'@aws-blocks/bb-agent': patch
'@aws-blocks/pipeline': patch
'@aws-blocks/bb-knowledge-base': patch
---

Correct documentation: `Secret` reads pick up rotated values after the cache TTL (`cacheTtlSeconds`), not only on cold start, and the `put()` error-handling example now declares a writable secret; `EmailClient` validates recipient and size limits locally on AWS too; fix the `useChat` anchor in the `bb-agent` README; use 12-digit account IDs in `Pipeline` connection ARN examples; describe the `KnowledgeBase` mock's `'fixed'` and `'none'` chunking.
