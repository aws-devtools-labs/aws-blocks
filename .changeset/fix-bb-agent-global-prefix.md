---
"@aws-blocks/bb-agent": patch
---

fix(bb-agent): support all Bedrock inference profile prefixes in health check

Added `global.`, `au.`, and `jp.` to the health-check regex and removed
the non-existent `us-gov.` prefix. Model IDs with these prefixes were
incorrectly routed to `GetFoundationModel` instead of `GetInferenceProfile`,
causing health checks to fail and the model to be marked unavailable.
