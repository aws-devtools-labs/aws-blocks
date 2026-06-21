---
"@aws-blocks/bb-knowledge-base": patch
---

fix(bb-knowledge-base): path guard bypass, cache staleness, filter truncation, error classification, load recovery, unicode tokenization, and chunking config

**Behavioral note — error classification.** Bedrock `ValidationException`s that are not filter-related are now surfaced as `KnowledgeBaseValidationError` instead of `InvalidFilterException`. Filter-related validation errors (e.g. an unknown metadata filter key) continue to map to `InvalidFilterException`. Consumers that catch `InvalidFilterException` to handle generic query-validation failures should audit their catch blocks and add handling for `KnowledgeBaseValidationError` where appropriate. No exported types, signatures, or error constants changed.
