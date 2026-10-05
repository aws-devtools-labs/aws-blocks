---
"aws-blocks-kotlin": minor
---

Add a `Blocks` entry point so one HTTP client serves every API

`Blocks()` is now the way in. One instance owns one `BlocksClient`, and therefore one HTTP engine
and connection pool, for every API in the spec, and code generation adds one extension property per
namespace to reach them: `blocks.api.listTodos()`, `blocks.authApi.getAuthState()`. Previously each
generated API class built its own client, so an app using four of them ran four engines. `Blocks` is
an `AutoCloseable`; `close()` shuts the engine down, and callers who want it scoped to a block can
write `Blocks().use { ... }`.

`Blocks()` resolves through an `invoke` accessor generated next to the `Servers` constants, so it
follows the spec's first server by name — regenerating against a backend whose server is named
differently leaves the call site alone. Bringing it into scope needs `import <generated package>.invoke`;
without that import the compiler reports a missing `server` argument. A specific server can still be
named: `Blocks(Servers.sandbox)`.

**The generated `Api(server: BlocksServer = Servers.local)` constructor is gone.** Generated API
classes now take the `BlocksClient` to run on, so `Api()` becomes `blocks.api` and
`Api(server = myServer)` becomes `Blocks(myServer).api`. Passing a `BlocksClient` directly still
works for callers who build one themselves.

The RPC path from `x-blocks-endpoint` is now appended to the generated `Servers` constants rather
than to the server each API class was handed, so `Servers.local` resolves to the full endpoint URL
on its own.
