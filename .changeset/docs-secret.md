---
"@aws-cdk-blocks/bb-secret": patch
---

docs: `SecretErrors.NotSupported` is also thrown by a deployed `Secret` with no registered secret ARN. `put()` clears the cache of the calling instance only; other instances see the new value when their cache entry expires.
