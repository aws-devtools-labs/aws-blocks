---
"@aws-blocks/bb-agent": patch
---

fix(bb-agent): simplify Bedrock health check to support all inference profile formats

Removed the prefix regex that determined whether to call `GetInferenceProfile`
or `GetFoundationModel`. The health check now tries both APIs sequentially —
any model ID format (cross-region, global, or foundation model) works without
maintaining a prefix allowlist.
