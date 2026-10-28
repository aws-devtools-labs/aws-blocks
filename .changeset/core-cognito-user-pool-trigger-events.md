---
'@aws-blocks/core': minor
'@aws-blocks/blocks': patch
---

The Lambda handler routes Cognito user pool trigger events to the Building Block registered for that user pool (`EventSourceMapping.COGNITO_USER_POOL`). It returns the event unchanged, and it rejects an event for a pool that no block handles.
