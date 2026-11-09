---
'@aws-blocks/core': patch
---

An API request whose body is the JSON literal `null` now gets a JSON-RPC Invalid Request (-32600) error instead of crashing the handler.
