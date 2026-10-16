---
"@aws-blocks/bb-auth-cognito": patch
---

fix(bb-auth-cognito): use adaptive retry on the Cognito client so request-rate throttles are absorbed

The `CognitoIdentityProviderClient` is now configured with `retryMode: 'adaptive'`
and `maxAttempts: 5`. Cognito enforces per-account, per-category request-rate
quotas (e.g. "Rate of UserRead requests") and returns `LimitExceededException`
(HTTP 429) when a burst exceeds them — common when many admin/auth operations run
concurrently against one account. Adaptive retry adds client-side rate limiting
and exponential backoff on throttling errors, so a transient 429 is retried
in-SDK instead of surfacing as a hard failure to the caller.
