---
'@aws-blocks/bb-agent': patch
'@aws-blocks/blocks': patch
---

Report Bedrock's Anthropic use case details refusal as `AgentErrors.ModelUnavailable` when Bedrock returns it as `ResourceNotFoundException` (HTTP 404), which is how it arrives from `ConverseStream` on a new account. Previously only `AccessDeniedException` (HTTP 403) refusals were recognised, so this refusal reached clients as `StreamFailed` with the raw provider text. A not-found error without that refusal's wording is still not classified.
