---
'@aws-blocks/core': minor
---

Constructing a `Scope` whose `fullId` is already used by a different scope path now logs a warning that names both paths. Scope ids are joined with `-`, so paths such as `'user-service' > 'sessions'` and `'user' > 'service-sessions'` resolve to the same `fullId` and share the same resource names and local `.bb-data` directory. At `cdk synth` the warning is a CDK annotation with the id `blocks:scope:fullIdCollision`. Rename one of the scopes: a future release will reject the collision. Constructing the same path again is still accepted, and `fullId` values are unchanged.
