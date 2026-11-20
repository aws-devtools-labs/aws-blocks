---
"@aws-cdk-blocks/bb-agent": patch
"@aws-cdk-blocks/bb-knowledge-base": patch
"aws-cdk-blocks": patch
---

docs: corrected and reorganized the `Agent` and `KnowledgeBase` READMEs.

- `Agent`: the `createChat` example now shows the backend that it calls. The errors section lists every error case. Model presets and Bedrock access moved to `MODELS.md`, which ships in the package.
- `KnowledgeBase`: `chunkOverlap` is 1 to 99 on AWS, and the mock also accepts 0. A `maxResults` value outside 1 to 100 is clamped, and a non-integer throws `ValidationError`.
