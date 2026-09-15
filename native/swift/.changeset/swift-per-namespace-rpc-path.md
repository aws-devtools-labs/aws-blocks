---
"aws-blocks-swift": minor
---

feat(swift): POST each JSON-RPC call to its namespace path

A call now goes to `{base}/{namespace}` instead of the bare configured URL, so a front door can route each API namespace to the compute that hosts it. A backend running a single compute serves every namespace path from the same origin, so nothing changes there.

The namespace is taken from the RPC method name (`"{namespace}.{method}"`) at request time and appended as a path segment. It also stays in the request body, which is what the server dispatches on — the path is purely a routing hint. A method with no namespace posts to the base URL unchanged.

The URL the client was constructed with is left untouched, so `rawRouteBase` and the OIDC flow keep resolving to the same origin as before.

Requires a backend that serves per-namespace paths; deploy the backend before shipping a client build.
