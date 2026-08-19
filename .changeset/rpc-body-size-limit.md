---
"@aws-blocks/core": patch
---

Reject oversized JSON-RPC request bodies at the shared parser. `parseRpcRequest` now caps the body at 10 MiB (`MAX_RPC_BODY_BYTES`, matching API Gateway's payload limit) and returns an `InvalidRequest` error named `PayloadTooLarge` before parsing or dispatch. Because both the Lambda handler and the local dev server route through this single parser, the dev server rejects exactly what the deployed runtime would — an unbounded body can no longer wedge the local database (e.g. PGlite) in dev while silently differing from production.
