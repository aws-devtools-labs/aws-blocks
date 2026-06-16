---
"@aws-blocks/bb-agent": patch
---

fix(bb-agent): add `global.` to health-check inference profile regex

Model IDs prefixed with `global.` (e.g., `global.anthropic.claude-opus-4-6-v1`)
were incorrectly routed to `GetFoundationModel` instead of `GetInferenceProfile`,
causing health checks to fail and the model to be marked unavailable.
