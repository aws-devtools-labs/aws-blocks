---
'@aws-blocks/core': patch
---

Constructing a `Scope` whose `fullId` is already used by a different scope path now throws an error that names both paths. Scope ids are joined with `-`, so paths such as `'user-service' > 'sessions'` and `'user' > 'service-sessions'` resolve to the same `fullId` and previously shared the same resource names and local `.bb-data` directory. Deployed apps get the error at `cdk synth`. Constructing the same path again is still accepted, and `fullId` values are unchanged.
