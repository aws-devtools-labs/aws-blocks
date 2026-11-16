---
"aws-blocks-kotlin": minor
---

Reject a `servers {}` URL that reaches no RPC, and join a non-empty `x-blocks-endpoint` with one `/`

**Code generation now fails** on a `servers {}` override that does not parse, has no
`http://`/`https://` scheme or no host, carries a query or fragment, or, while the spec declares no
non-empty `x-blocks-endpoint`, has no RPC path (nothing but slashes and dot segments), such as the
bare origin `local("http://10.0.2.2:3001")`. A non-empty `x-blocks-endpoint` is joined to the
server URL with one `/`, and the no-servers fallback adds `/aws-blocks/api` when the endpoint is
empty or absent. If a build now fails on a `servers {}` override, append `/aws-blocks/api` (or the
spec's full `apiUrl`) to it, or declare a non-empty `x-blocks-endpoint` in the spec.
