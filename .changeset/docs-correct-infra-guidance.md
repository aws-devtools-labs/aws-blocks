---
'@aws-blocks/blocks': patch
'@aws-blocks/bb-agent': patch
'@aws-blocks/bb-file-bucket': patch
'@aws-blocks/bb-auth-cognito': patch
---

Correct documentation that no longer matched the code: session cookies default to `SameSite=Lax` (`SameSite=None; Partitioned` only with `crossDomain: true`), an `inferenceOnly` agent still creates its S3 session bucket, and local mocks are documented as matching the API rather than every AWS behavior.

`FileBucket` docs now say `objectLock` can be added to a bucket that is already deployed, as an in-place update; it still can't be turned off once on.
