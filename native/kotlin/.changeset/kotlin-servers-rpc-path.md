---
"aws-blocks-kotlin": minor
---

Reject a `servers {}` URL that reaches no RPC, and drop the unused `x-blocks-endpoint` spec key

**Code generation now fails** on a `servers {}` override that does not parse, has no
`http://`/`https://` scheme or no host, carries a query or fragment, or has no RPC path (nothing
but slashes and dot segments), such as the bare origin `local("http://10.0.2.2:3001")`. If a build
now fails on a `servers {}` override, append `/aws-blocks/api` (or the spec's full `apiUrl`) to it.

A server URL is now always the whole RPC URL. The `x-blocks-endpoint` spec key, which no spec
generator has ever emitted, is no longer read, and the no-servers fallback always points at
`http://localhost:3001/aws-blocks/api`.
