---
"aws-blocks-kotlin": minor
---

feat(kotlin): POST each JSON-RPC call to its namespace path

A call now goes to `{server.url}/{namespace}` instead of the bare server URL, so a front door can route each API namespace to the compute that hosts it. A backend running a single compute serves every namespace path from the same origin, so nothing changes there.

The namespace is taken from the RPC method name (`"{namespace}.{method}"`) at request time and appended as a path segment. It also stays in the request body, which is what the server dispatches on — the path is purely a routing hint. A method with no namespace posts to `server.url` unchanged.

`BlocksServer` is left untouched, so raw routes and the auth flow keep deriving their base from the configured server URL.

Requires a backend that serves per-namespace paths; deploy the backend before shipping a client build.
