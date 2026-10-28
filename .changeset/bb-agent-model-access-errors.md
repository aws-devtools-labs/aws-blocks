---
'@aws-blocks/bb-agent': patch
'@aws-blocks/blocks': patch
---

Report Bedrock invoke-time model-access refusals as `AgentErrors.ModelUnavailable` with an actionable message. When Bedrock refuses a model because the account has not submitted Anthropic's one-time use case details, or because the model is not available for the account, the `error` chunk now carries a message explaining what to do plus an optional `errorName` field, `complete()` rejects with `ModelUnavailable` instead of `StreamFailed`, and `createChat`'s `onError` receives the branded error as its `cause`. Error chunks without `errorName` behave as before. The README now explains that the Bedrock presets are Anthropic models that need the one-time first-time-use form, replacing the outdated "enable model access" guidance.
