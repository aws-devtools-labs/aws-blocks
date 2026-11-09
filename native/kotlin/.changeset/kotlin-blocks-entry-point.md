---
"aws-blocks-kotlin": minor
---

Add a `Blocks` entry point so one HTTP engine serves every API

`Blocks()` reaches the server the spec declares, and code generation adds one extension property per
namespace: `blocks.api.listTodos()`, `blocks.authApi.getAuthState()`. One instance owns one HTTP
engine for every RPC call and for the OIDC client the generated APIs hand out, where each generated
API class previously built its own. File handles and realtime channels still open their own.
`Blocks` is an `AutoCloseable`, and calls made through a closed instance report that rather than
failing inside the HTTP client.

**The generated `Api(server: BlocksServer = Servers.local)` constructor is gone.** Generated API
classes now take the `BlocksClient` to run on, so `Api()` becomes `blocks.api`, and
`Api(server = myServer)` becomes `blocks.api` on a `val blocks = Blocks(myServer)` that you hold and
`close()` when you are done. `BlocksClient` can no longer be constructed directly; reach it through
`Blocks.client()`.

A namespace named `types`, `serializers` or `servers` would be generated into a file this generator
emits itself, so its API now takes an `Api` suffix — `blocks.typesApi` — and code generation warns.

The RPC path from `x-blocks-endpoint` is now appended to the generated `Servers` constants rather
than to the server each API class was handed. A spec that declares no server at all now falls back
to `http://localhost:3001/aws-blocks/api` rather than to the bare origin, where no RPC is served.
