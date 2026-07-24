---
"@aws-blocks/core": minor
---

Add the container compute-target seam: `BlocksStackProps.compute` /
`BlocksBackendProps.compute` accept a `ComputeTarget` (the contract ECS/EKS
targets implement). When set, the HTTP front door is provided by the target
instead of API Gateway, the Lambda remains as the event-source companion, and
both share one execution role so every Building Block grant applies to
containers unchanged. Adds `@aws-blocks/core/http-server` — a production HTTP
server wrapping the Lambda dispatch for container entrypoints (health gating,
graceful drain, `BLOCKS_PUBLIC_ORIGIN`, `BLOCKS_HTTP_TIMEOUT_MS`) — and a
structural `apiOrigin` on `BlocksStackApi` so Hosting proxies stage-less
container URLs correctly. No `compute` prop → synthesized template unchanged.
For container-mode stacks, `gateway` now throws (no REST API exists).
