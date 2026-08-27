---
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/blocks": patch
---

`KnowledgeBase.retrieve`: validate `maxResults` consistently across the mock and AWS runtimes.

`maxResults` was normalized with `Math.min(Math.max(v ?? 10, 1), 100)`, which silently passed fractional and non-finite values (`1.5`, `NaN`, `Infinity`) straight through — the mock and the AWS `RetrieveCommand` then diverged, and Bedrock rejects a non-integer `numberOfResults`. A new shared `normalizeMaxResults` helper (used by both runtimes) keeps the documented clamp for finite integers and now rejects fractional/non-finite values up front with `KnowledgeBaseErrors.ValidationError`, before any search or Bedrock request.

Fixes #430.
