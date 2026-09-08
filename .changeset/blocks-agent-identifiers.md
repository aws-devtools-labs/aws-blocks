---
"@aws-blocks/blocks": patch
---

fix(blocks): drop `jobQueueUrl` from the `Agent` `getSdkIdentifiers` overload

The Agent BB no longer runs its loop on an internal AsyncJob (it moved to a Bedrock AgentCore Runtime),
so it no longer registers a `jobQueueUrl` identifier. The umbrella `getSdkIdentifiers(agent)` overload
still declared it, promising a field that resolves to `undefined` at runtime. Remove it; the overload
now returns only `conversationsTableName`, `messagesTableName`, `sessionBucketName`, `realtimeWsUrl`,
and `realtimeCallbackUrl`.
