---
'@aws-blocks/bb-agent': minor
'@aws-blocks/blocks': minor
---

Report Bedrock invoke-time model-access refusals as `AgentErrors.ModelUnavailable` with an actionable message. When Bedrock refuses a model because the account has not submitted Anthropic's one-time use case details, has not activated the model's one-time AWS Marketplace subscription, or is not entitled to the model, the `error` chunk now carries a message explaining what to do plus an optional `errorName` field, and the `onError` callbacks of `createChat` and `useChat` receive the branded error as an optional `cause` argument. Error chunks without `errorName` behave as before. `complete()` now rejects with `ModelUnavailableException` (instead of `StreamFailedException`) for these failures and for health-check failures, and the persisted error row's `metadata` records the same `errorName`. The README now explains that the Bedrock presets are Anthropic models that need the one-time use case details form and AWS Marketplace subscription, replacing the outdated "enable model access" guidance.
