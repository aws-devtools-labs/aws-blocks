---
'@aws-blocks/core': patch
---

Extract the Lambda handler's HTTP request handling (cross-origin checks, preflight, RawRoute and JSON-RPC dispatch) into a transport-neutral core, and add an internal Node HTTP server built on it for container computes. Lambda responses are unchanged.
