---
"@aws-blocks/bb-realtime": minor
---

feat(bb-realtime): add `Realtime.grantPublish(grantee)` for external publishers

`publish()` fan-out posts to subscribers via the API Gateway Management API
(`postToConnection`), queries the connections table to find them, and prunes stale
connections — permissions that were only ever granted to the shared Blocks handler Lambda.
`grantPublish(grantee)` grants all of these (`execute-api:ManageConnections` plus
read/write on the connections table) to any IAM principal, so a workload running outside the
handler (e.g. an AgentCore Runtime execution role that hosts an agent loop and publishes
chunks) can publish to Realtime channels.

It returns `{ callbackUrl }` — the API Gateway Management endpoint the principal must inject
into its process env as `BLOCKS_RT_CALLBACK_URL` (not discoverable outside the Blocks
handler). The connections table name is not returned: `publish()` re-derives it in-process
from the Realtime BB's own SDK identifiers. The method is CDK-synth only; calling it in the
runtime/mock build throws.
