---
"@aws-blocks/bb-realtime": minor
---

feat(bb-realtime): expose `Realtime.publishCallbackUrl()` for a co-located compute

A Building Block whose compute runs outside the Blocks handler but AS the shared Blocks execution
role (e.g. the Agent BB's AgentCore Runtime, which hosts an agent loop and publishes chunks) already
holds the publish permissions — the connections table and API Gateway `postToConnection` are both
granted to the handler on that same role, so it inherits them. The one thing it can't discover
outside the handler is the API Gateway WebSocket callback URL.

`publishCallbackUrl()` returns that URL, to inject into the compute's process env as
`BLOCKS_RT_CALLBACK_URL` (which `publish()` posts to). It's CDK-synth only; calling it in the
runtime/mock build throws.
