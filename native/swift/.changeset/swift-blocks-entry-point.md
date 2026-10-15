---
"aws-blocks-swift": minor
---

feat(swift): generate a `Blocks` entry point so one BlocksClient serves every API

Code generation now emits `public final class Blocks` with one stored property per namespace. Hold
one instance, `let blocks = Blocks()`, and call `blocks.api.listTodos(sortBy: nil)` or
`blocks.authApi.getAuthState()`. One instance owns one `BlocksClient`, so every namespace shares one
`URLSession` for RPC and OIDC calls and one token store, where each generated API object previously
built its own. `Blocks()` uses the spec's first server, so regenerating against a differently named
server needs no call-site change. `Blocks(server: Servers.sandbox)` pins one server of a
multi-server spec, and `Blocks(tokenStore:)` or `Blocks(server:session:tokenStore:)` passes a
persistent `TokenStore` or a `URLSession` you own. A `BlocksServer` URL is the full RPC URL, ending
in `/aws-blocks/api`.

**`Api()` and `Api(server:)` are deprecated.** They still compile, with a warning, and each still
builds its own client; they will be removed in the next breaking release. Migrate by holding one
instance: `Api()` becomes `blocks.api` on a `Blocks()` you keep, and `Api(server: myServer)` becomes
`blocks.api` on a `Blocks(server: myServer)` you keep.

`close()` on `Blocks` or `BlocksClient` makes later calls throw `ClientClosedError`, lets calls in
flight finish, then invalidates the `URLSession` the client created. A session you pass in is never
invalidated, and an instance that is never closed releases its session once nothing references it.
Cookies, realtime channels and file transfers are unaffected. An `OIDCClient` obtained earlier keeps
its stored tokens: `signIn` and a refresh that needs the network throw `ClientClosedError`,
`restore()` reports `.signedOut` when the access token has expired, and `getAccessToken()` returns
`nil` once it has expired; a still-valid access token keeps working.

**Also breaking.** Generated API classes are now `final`, `Sendable`, and built with
`init(client:)`, so subclass mocks no longer compile; inject a `URLSession` through
`Blocks(server:session:)` instead. A type named `Blocks` in a target that generates code, whether
your own or a spec model, now collides with the generated class. A namespace whose class name the
generated file already uses (`blocks`, `servers`, `blocksRuntime`, `sendable`, `realtimeChannel`,
…), or that another namespace already takes, gets an `Api` suffix. A namespace named `client`,
`server`, `close`, `self` or `init` is reached as `blocks.<name>Api`, and methods without a
namespace as `blocks.default`; the generator prints a `swift:` line for each rename.

Every `OIDCClient` from one `Blocks` shares its token store, so each now keys its tokens by its
exchange path, e.g. `/auth/exchange#refresh_token`, and two `oidc/client` namespaces keep separate
sessions. Tokens saved under the old unscoped keys, such as `refresh_token`, move to the first
`OIDCClient` that uses the store.

`BlocksServer` (now also `Equatable`) and `BlocksClient` are `Sendable`, so generated code compiles
in Swift 6 language mode.
