---
"aws-blocks-kotlin": minor
---

Add a `Blocks` entry point so one HTTP client serves every API

`Blocks()` reaches the server the spec declares, and code generation adds one extension property per
namespace: `blocks.api.listTodos()`, `blocks.authApi.getAuthState()`. One instance owns one HTTP
engine and connection pool for every API, where each generated API class previously built its own.
`Blocks` is an `AutoCloseable`.

**The generated `Api(server: BlocksServer = Servers.local)` constructor is gone.** Generated API
classes now take the `BlocksClient` to run on, so `Api()` becomes `blocks.api` and
`Api(server = myServer)` becomes `Blocks(myServer).api`.

The RPC path from `x-blocks-endpoint` is now appended to the generated `Servers` constants rather
than to the server each API class was handed.
