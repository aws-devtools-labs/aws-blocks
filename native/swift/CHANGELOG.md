# aws-blocks-swift

## 1.0.0

### Major Changes

- First stable release. The public API now follows semantic versioning: breaking changes ship only in a new major version.

  Moving from 0.1.1 takes code changes. Each one is described in its entry below:

  - The package moved to `https://github.com/aws/cdk-blocks-swift.git` and is named `cdk-blocks-swift`. Depend on it with `from: "1.0.0"`, and change `package:` in every `.product(...)` and `.plugin(...)`.
  - Building needs Xcode 26 or a Swift 6.2 toolchain.
  - `RPCError` and `RawRouteError` are removed: catch `ApiError` and `TransportError`. `FileBucketError` is replaced by `FileTransferError`, and a bad transferable descriptor throws `TransferableError`.
  - `OIDCClient` is generic over its providers. Write `OIDCClient<String>`, or the generated `Provider` enum, where code names it.
  - `OIDCClient` signs in with a session cookie, so `getAccessToken()` returns `nil` after a sign-in.
  - `restore()` now returns `OIDCUser?` and `signOut()` returns the logout `URL?`. Both throw, so call them with `try`.
  - Enums and unions a response can carry are open. An exhaustive `switch` needs a `case .unknown` branch, and an open enum's `init(rawValue:)` no longer returns an optional.
  - An enum or union on a model is named after the model and the property (`Order.status` is `OrderStatus`), and the Cognito user types are renamed the same way.
  - `format: date` is a `String`, not a `Date`.
  - Generated API classes are `final`, so subclass mocks no longer compile. Inject a `URLSession` through `Blocks(server:session:)` instead.
  - Codegen refuses a spec with an operation that takes a transferable parameter.
  - Generated clients call `/cdk-blocks/api/<namespace>`, so a proxy in front of the API must forward `/cdk-blocks/api/*`.

### Minor Changes

- [#1656](https://github.com/aws/cdk-blocks/pull/1656) [`1de6ea4`](https://github.com/aws/cdk-blocks/commit/1de6ea444d382abf59dbb5bf096aa2ab19880fbc) Thanks [@cadivus](https://github.com/cadivus)! - Generated clients and the codegen defaults use the new `/cdk-blocks/api` and `/cdk-blocks/auth/*` paths. Raw routes and auth requests resolve against the API origin cut at a `cdk-blocks` or legacy `aws-blocks` path segment, so a server URL configured with the old `/aws-blocks/api` path keeps working.

  Tokens a block stored under its old `/aws-blocks/` exchange path move to its `/cdk-blocks/` keys on first use, so an upgrade keeps the session.

- [#797](https://github.com/aws/cdk-blocks/pull/797) [`c5dc763`](https://github.com/aws/cdk-blocks/commit/c5dc763f8ab504ab4c64864ce1b1131fafcbc54b) Thanks [@thisisabhash](https://github.com/thisisabhash)! - feat(swift): generate a `Blocks` entry point so one BlocksClient serves every API

  Code generation now emits `public final class Blocks` with one stored property per namespace. Hold
  one instance, `let blocks = Blocks()`, and call `blocks.api.listTodos(sortBy: nil)` or
  `blocks.authApi.getAuthState()`. One instance owns one `BlocksClient`, so every namespace shares one
  `URLSession` for RPC and OIDC calls and one token store, where each generated API object previously
  built its own. `Blocks()` uses the spec's first server, so regenerating against a differently named
  server needs no call-site change. `Blocks(server: Servers.sandbox)` pins one server of a
  multi-server spec, and `Blocks(tokenStore:)` or `Blocks(server:session:tokenStore:)` passes a
  persistent `TokenStore` or a `URLSession` you own. A `BlocksServer` URL is the full RPC URL, ending
  in `/cdk-blocks/api`.

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
  your own or a spec model, now collides with the generated class; for a spec model the generator
  prints a `swift:` line naming it. A namespace whose class name the generated files already use
  (`blocks`, `servers`, `blocksRuntime`, `sendable`, `realtimeChannel`, `string`, `date`, …), or that
  another namespace already takes, gets an `Api` suffix. A namespace named `client`, `server`,
  `close`, `self` or `init` is reached as `blocks.<name>Api`, and methods without a namespace as
  `blocks.default`; the generator prints a `swift:` line for each rename.

  Every `OIDCClient` from one `Blocks` shares its token store, so each now keys its tokens by its
  exchange path, e.g. `/auth/exchange#refresh_token`, and two `oidc/client` namespaces keep separate
  sessions.

  `BlocksServer` (now also `Equatable`) and `BlocksClient` are `Sendable`, so generated code compiles
  in Swift 6 language mode.

- [#1652](https://github.com/aws/cdk-blocks/pull/1652) [`61aa1d0`](https://github.com/aws/cdk-blocks/commit/61aa1d0f59b81c54a6657ea448f6e1d752f811c6) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - The Swift package is now published from `https://github.com/aws/cdk-blocks-swift.git`, and its package name is `cdk-blocks-swift`. Update the dependency URL, and change `package: "aws-blocks-swift"` to `package: "cdk-blocks-swift"` in your `.product(...)` and `.plugin(...)` references:

  ```swift
  .package(url: "https://github.com/aws/cdk-blocks-swift.git", from: "1.0.0"),
  // ...
  .product(name: "BlocksRuntime", package: "cdk-blocks-swift"),
  .plugin(name: "BlocksCodegenBuildPlugin", package: "cdk-blocks-swift"),
  ```

  SwiftPM takes `package:` from the URL, not from the package's declared name, so change the URL and every `package:` together, in every `Package.swift` that uses the SDK. A manifest that keeps the old URL with the new `package:`, or the reverse, fails to resolve. An Xcode project only needs the new URL.

  Product and module names (`BlocksRuntime`, `BlocksCodegenBuildPlugin`) are unchanged.

- [#1417](https://github.com/aws/cdk-blocks/pull/1417) [`64112ad`](https://github.com/aws/cdk-blocks/commit/64112ad04601c649cbf4e90e1e720c5c7372d8c6) Thanks [@soberm](https://github.com/soberm)! - fix(swift): generate compilable code for spec names that aren't Swift identifiers

  A component schema whose name isn't a Swift identifier is now declared and referenced under the same
  sanitized type name, so an operation that takes or returns it compiles. Two such schemas that sanitize
  to one name are numbered (`_2`, `_3`, …). A field or enum value named only with characters Swift can't
  use (`$`, `*/`) now generates `_unnamed` or `__unnamed` instead of an undeclarable `_` or a bare `__`,
  and a name that starts with a digit keeps it (`9lives` generates `_9lives`, no longer `_lives`). The
  original names still reach the wire through `CodingKeys` raw values, so the wire format is unchanged.

- [#976](https://github.com/aws/cdk-blocks/pull/976) [`d574752`](https://github.com/aws/cdk-blocks/commit/d574752b8831da2d1a7abaa49445fa40e4fb7023) Thanks [@soberm](https://github.com/soberm)! - fix(swift): parse and enforce the `Secure`, `Path` and `Expires`/`Max-Age` cookie attributes

  `BlocksClient` now keeps each cookie's `Path`, `Secure` flag and expiry when it stores a
  `Set-Cookie` response, and applies them when it attaches cookies to a request, following the same
  rules as the Kotlin runtime. A cookie is sent only to the host that set it, only to request paths
  under its `Path`, and, when `Secure`, only over `https`. A cookie without a `Path` applies to the
  directory of the request path that set it. When `URLSession` follows a redirect, cookies are scoped
  to the URL of the response that set them. `Max-Age` takes precedence over `Expires`; a cookie
  whose `Max-Age` is zero or less, or whose `Expires` has passed, is removed, and a stored cookie
  stops being sent once its expiry arrives. A new cookie replaces the same-named cookies that would be
  sent on that request. When several same-named cookies apply to a request, the one with the longest
  `Path` is listed first in the `Cookie` header. Cookie reads and updates are applied one at a time, so
  responses that arrive together leave the same cookies as if they had arrived in sequence.

  Each Keychain item is now keyed by `host|path|name` and holds a JSON record of the cookie and its
  attributes. Cookies stored by 0.1.x, keyed by `host|name` and holding the bare value, are kept:
  they are read as `Path=/` and `Secure` for the host that set them, the attributes the Auth block
  sets its session cookies with, and are replaced in the current format on the next `Set-Cookie` of
  the same name from that host. A session only used over plain `http` (for example, local
  development) is no longer sent, so those users sign in again. Items written by this version are not
  readable by earlier versions.

- [#1123](https://github.com/aws/cdk-blocks/pull/1123) [`7c97c7e`](https://github.com/aws/cdk-blocks/commit/7c97c7e9915cd2f0bf985fc4a171019c8d8b48dd) Thanks [@VarshithaPamisetty](https://github.com/VarshithaPamisetty)! - Validate a declared binding the way the other generators already do

  **A result whose `x-blocks-type-args` count disagrees with its binding's `genericArity` is now a
  generation error.** An arity-one binding whose result carried no type argument generated
  `Module.Type<BlocksRuntime.JSONValue>` and a `JSONValue` decoder, handing the customer's
  `Type<T>` a placeholder payload; an arity-zero binding whose result carried one, and an
  arity-one result carrying two, silently dropped the extra argument. Dart and Kotlin refuse all
  three.

  **`genericArity` is now required.** An absent value resolved to zero, so a binding meant to be
  generic generated as non-generic. Dart and Kotlin, and spec generation, already require it.

  **Package existence, the empty-tag check and tag uniqueness now run whatever the binding's `kind`.** The ABI, `genericArity` and `export` checks still sit behind the kind gate, since a skipped binding emits nothing that reads them. A binding of an undefined
  kind returned before the package-existence and tag-uniqueness checks, so one naming an undeclared
  package, or re-binding a tag another binding already took, generated with only
  `AWSBLOCKS-NATIVE-004`. Both are generation errors now, as they are on Dart and Kotlin.

  Every native-catalog diagnostic, and the operation name in `AWSBLOCKS-NATIVE-001` and the arity error, now escapes the spec-supplied values it names, so a newline in one cannot split it
  across log lines or emit a line that reads as a second diagnostic. That covers the
  `AWSBLOCKS-NATIVE-003`, `-004`, `-005` and `-006` warnings and every `invalidNativeCatalog` error,
  which named a binding's `id`, `tag`, `package`, `abi` or `export`, and a package's key or Swift
  module, raw. They share the escape the `-001` path already applied, which moves to
  `escapedForDiagnostic` with byte-identical output.

  `AWSBLOCKS-NATIVE-003` no longer reports a declared package whose only binding is not a
  `transferable` one, although that binding names it; Dart and Kotlin already treat it as referenced.

  No public Swift API changes: `DeclaredTransferableBinding`, `declaredResultTypeName` and
  `declaredTypeName` are all internal to `BlocksCodegen`.

- [#1566](https://github.com/aws/cdk-blocks/pull/1566) [`2512ca3`](https://github.com/aws/cdk-blocks/commit/2512ca38cc59d6c21abbe6119736ecf58be87a9f) Thanks [@mattcreaser](https://github.com/mattcreaser)! - feat(swift)!: a new error taxonomy for the Swift client

  Errors now fall into a few types you can tell apart by what the caller should do, and the Swift client follows the same decision table as the Kotlin and Dart clients. **Breaking:** several error types are removed or renamed, so any `catch` that names one needs updating.

  **New types**

  - `ApiError`: the server rejected the request. It carries `message`, `status`, `name` and `retriable`. Errors cross the wire by name, so match on `name` rather than on `message` or `status`. A named error thrown without a status arrives as a 500 with its name intact, and JSON-RPC's reserved codes (for example `-32601`) arrive as a 500 with a name such as `MethodNotFound`.
  - `TransportError`: the request produced no usable JSON-RPC result, for example a connection failure, a non-JSON response, or a non-2xx response with no JSON-RPC error object. For that last case `message` is the body's `message` (as API Gateway sends for a 504 or 429), else its `error`, else `HTTP <status>`. It carries `message`, `statusCode` (`nil` when no response arrived) and `underlyingError`. A 2xx body that is not a JSON object on a raw route is now a `TransportError` with the real status, where it previously leaked a raw `NSError`. A 2xx JSON-RPC body is an envelope only when it is a JSON object with `jsonrpc` equal to `"2.0"`; anything else is a `TransportError`. An envelope with no `result` (what a void handler answers) or a `null` result is a successful void call.
  - `Error.isBlocksError(name:)`: true when an error is an `ApiError` with the given name, so `error.isBlocksError(name: "ConditionalCheckFailed")` works the same way as the TypeScript client's `isBlocksError`. It is available on any `Error` and is `false` for transport and decoding failures.
  - `TransferableError`: a transferable descriptor could not be hydrated. `.unknownType(_)` means no hydrator is registered for the `__blocks` type, and `.invalidDescriptor(blocksType:missingField:)` means a required field is missing or unusable.

  **Raw-route errors**
  A raw route that answers outside 2xx with a JSON object now reports the server's status and error name as an `ApiError`, instead of being misread as a malformed success. A body that is not a JSON object, such as a gateway's HTML 502 or 503, is a `TransportError` with the status instead. The name comes from the body: a Blocks route's `name` wins; otherwise a plain OAuth `error` is the name when it sits beside `error_description` or reads like a code (no spaces), and `error_description` is kept as the detail. A nameless one-word message such as `{ "error": "Unauthorized" }` reads as a code and becomes the name. `ApiError.message` is the server's own text, unchanged: its `error`, else its `error_description`, else `HTTP <status>`. For example, a refused exchange answering `{ "name": "IdpErrorException", "error": "The sign-in provider refused the sign-in." }` is an `ApiError` with `message` `"The sign-in provider refused the sign-in."`, `status` 400 and `name` `"IdpErrorException"`. The OIDC client wraps its own raw-route calls, so catch `OIDCError` around `signIn` and `exchange`; the `ApiError` is `OIDCError.exchangeFailed`'s `underlyingError`. Catch `ApiError` for other raw routes.

  **Breaking changes**

  - `RPCError` is removed. A rejected JSON-RPC call now throws `ApiError`, and a transport-level failure throws `TransportError`. Generated clients throw these in its place.
  - `RPCError.code` and `RPCError.data` are gone with it, and `ApiError` has no equivalent of either. The raw JSON-RPC `code` is replaced by `ApiError.status`, the HTTP status the server rejected with (JSON-RPC's reserved codes, which have no HTTP meaning, are reported as 500). `error.data` was never anything but the error's `name` and `retriable`, and both are properties on `ApiError`, so `RPCError.data` has no replacement. `RPCError.name` and `RPCError.retriable` carry over to `ApiError` unchanged, and `retriable` is `true` only for the JSON boolean `true`. For a non-2xx response with no JSON-RPC error object, the HTTP status that was `RPCError.code` is now `TransportError.statusCode`.
  - `RawRouteError` is removed. A raw route you call yourself throws `ApiError` when the server answers with an error status, and `TransportError` for everything else. A network failure that used to escape as a bare `URLError` or `NSError` is now a `TransportError` with the original in `underlyingError`. The OIDC client wraps its sign-in calls: a rejected exchange or authorize-params fetch becomes an `OIDCError` (with the `ApiError` as `underlyingError` on `exchangeFailed`), and a refresh the route refuses (HTTP 400 or 401) clears the tokens and signs out; any other refresh failure is thrown and keeps them. `restore()` and `signOut()` throw the `ApiError` or `TransportError` itself; `signOut()` signs out locally first.
  - `FileBucketError` is replaced by `FileTransferError`, a struct rather than an enum. The `.downloadFailed` and `.uploadFailed` cases become a single type with `message`, `statusCode` (the HTTP status the transfer was rejected with, or `nil` when the request got no response) and `underlyingError`. Its `.invalidURL` cases move to `TransferableError.invalidDescriptor`, because a bad URL in a file handle is a descriptor problem.
  - `RealtimeError.websocket(_:_:)` is renamed `RealtimeError.connectionFailed(_:_:)`. The associated values are unchanged.
  - `OIDCError` loses five cases: `.invalidURL`, `.missingPKCEState`, `.malformedRefreshResponse` and `.invalidResponse` were never thrown, and `.malformedDescriptor` moves to `TransferableError.invalidDescriptor(blocksType: "oidc", missingField:)`.
  - `OIDCError` no longer conforms to `Equatable`, because the new `.exchangeFailed` case carries an `Error`. Replace `error == .stateMismatch` with pattern matching, for example `if case .stateMismatch = error`.

  **Additions to existing types**

  - `OIDCError.cancelled`: a `BrowserLauncher` throws this when the user dismisses the sign-in sheet, so a catch site can tell a dismissal from a failure.
  - `OIDCError.exchangeFailed(_:_:)`: the OIDC code exchange was rejected. The `ApiError` or `TransportError` that caused it is available as `underlyingError`. A caller who catches `OIDCError` now sees a rejected exchange; it used to arrive as a raw-route error. A closed client still throws `ClientClosedError`, since that says nothing about the session.
  - `OIDCError.callbackError` is now `callbackError(_:_:)` and carries its cause, returned by `underlyingError`. A failure fetching the authorize parameters during `signIn` surfaces as this case ("Failed to fetch authorize params: ...") instead of escaping as a bare `ApiError` or `TransportError`, with that error as the cause, so an app can tell an offline failure from a named 403 such as `RelayNotAllowed`. **Breaking:** a `case .callbackError(let detail)` pattern becomes `case .callbackError(let detail, _)`. The cause is `nil` when the IdP reported the error in the callback URL.
  - A cancelled task now throws `CancellationError`, not `TransportError`, from RPC calls, raw routes, file uploads and downloads, and the OIDC client's requests. A cancelled token refresh keeps the tokens rather than signing out.
  - `RealtimeError.channelClosed` is documented as a catchable error: a channel closes on its own when the server goes away or the connection drops.

  `Decodable` conformances still throw `DecodingError` when a payload does not match its type; that is unchanged.

- [#1134](https://github.com/aws/cdk-blocks/pull/1134) [`d7f62f3`](https://github.com/aws/cdk-blocks/commit/d7f62f39f1b6d3cb1b4df0c7f464f38577578646) Thanks [@VarshithaPamisetty](https://github.com/VarshithaPamisetty)! - fix(swift): keep an export's acronym casing and reject an export the grammar does not admit

  An `x-blocks-native-bindings` export now raises only each segment's first character, so an
  export of `API_link` resolves to `APILink` rather than the `ApiLink` it previously lowered an
  all-caps segment to, a type the declared package does not export.

  A new grammar check refuses an export that is not a `-`, `_` or `.` joined run of alphanumeric
  segments starting with a letter, naming the offending export; `device__link`, `device.`, `.link`
  and `device:link` previously derived a name and passed the post-hoc identifier check.

- [#1259](https://github.com/aws/cdk-blocks/pull/1259) [`5f55dac`](https://github.com/aws/cdk-blocks/commit/5f55dac366a4a2fe4008869b9d97bb8ac51162c8) Thanks [@harsh62](https://github.com/harsh62)! - Fix generated Swift clients for spec names that collide with generated code or can't be Swift identifiers, and for optional arguments left out before a set one

  **An optional argument left out before a set one moved the later arguments into its place.** JSON-RPC params are positional, but the generated method appended only the optional arguments that were set, so `echoArgs(first: "a", middle: nil, last: "c")` sent `["a","c"]`, and the server received `middle = "c"` and no `last`. Each argument now keeps its position, as the TypeScript client sends it: a left-out optional argument before a set one is sent as `null` (`["a",null,"c"]`), and trailing ones that aren't set are still left off. Methods with at most one optional argument after the required ones send exactly what they did.

  Several names from an API's spec made the generated Swift client fail to compile:

  - **A parameter named `client`** didn't compile (`value of type 'String' has no member 'execute'`): it hid the API class's own client. The method body now reads `self.client`. Parameters named `request`, `result`, `_params` or `descriptor` were shadowed by generated locals of those names (this compiled); the locals now step aside (`request_2`, `result_2`), as in the Kotlin client. A parameter named `self`, or named like a type the method body uses (`JSONDecoder`, `String`, or the method's result type, such as `profile(Profile:)` returning `Profile`), keeps its argument label and takes an internal name (`JSONDecoder JSONDecoder_2: String`). Call sites are unchanged.
  - **An open record with a property named `attributes`** declared `attributes` twice. The property keeps its name, and the extra keys are in `attributes_2` (`Bag(attributes: "a", attributes_2: ["extra": "e"])`). A hybrid arm's nested union likewise moves to `challenge_2` beside a property named `challenge`.
  - **A key that isn't a Swift identifier** (`back\slash`, `q"uote`) was sanitized to `back_slash`, but its JSON name was written into string literals unescaped (`invalid escape sequence in literal`). Wire names, method names, enum raw values, server names and URLs, discriminator values and validation messages are now escaped, so `back_slash` encodes and decodes as `"back\slash"`. A sanitized discriminator key keeps its JSON name too.
  - **Two names that sanitize alike** in one scope (properties `a.b` and `a_b`, enum values `inProgress` and `in-progress`, methods `b.ping` and `b_ping`, two servers) were declared twice. The name that's already an identifier keeps it, and the other gets a numeric suffix (`a_b_2`, `inProgress_2`, `b_ping_2()`), keeping its JSON name.
  - An enum value or union variant named after a Swift keyword (`default`, `self`) is now written in backticks (`` case `default` ``), and a variant that would be a type named `Self` or `Any` is prefixed with its discriminator (`KindSelf`).
  - An operation named `client` keeps its method, and the class's client property is `client_2`. An operation's nested types are declared in an enum named after it; that enum now steps aside for a type the API class uses (an operation `item` beside a schema `Item` gets `Item_2.Result`, an operation `string` gets `String_2.Result`). A namespace whose class would be named like a schema type, a type the generated code uses, or `Servers` gets an `Api` suffix (`ApiApi` beside a schema `Api`, `ServersApi`), and a schema named `Servers` is `Servers_2`.
  - **Renamed: enum values and discriminator values holding a `$`.** These compiled with the `$` (`case cost$`, `struct Create$`) and are now sanitized like any other name that isn't a plain identifier, keeping their JSON names: each `$` becomes `_`, so enum cases are `cost_`, `a_b`, `x__y` and `d__e` for `cost$`, `a$b`, `x$$y` and `d_$e`; and a union variant is prefixed with its discriminator, so `create$` and `re$move` under `action` are `ActionCreate_` and `ActionRe_Move` (cases `.actionCreate_`, `.actionRe_Move`). Update references to them.

  Every other name that didn't collide is unchanged.

- [#1259](https://github.com/aws/cdk-blocks/pull/1259) [`5f55dac`](https://github.com/aws/cdk-blocks/commit/5f55dac366a4a2fe4008869b9d97bb8ac51162c8) Thanks [@harsh62](https://github.com/harsh62)! - Inline-object properties of your API's types now generate as nested structs, so same-named properties no longer share one type

  If one of your API's types has a property whose type is an inline object (for example `meta: { value: number }`) and not a named type, the generated Swift client declared it as a top-level struct named after the property (`Meta`). When two types each had a `meta` property with different shapes, both used the first one's struct: the client compiled, but decoding the second type failed or read the wrong fields. Each such property now generates a struct nested inside its type (`Invoice.Meta`, `Receipt.Meta`), at any depth (`Shipment.Destination.Geo`), including optional, nullable, array and map properties and the enums inside them.

  If your code names one of these types directly, update it to the nested name: `Meta` becomes `Invoice.Meta`. Code that only reads the properties (`invoice.meta.value`) is unchanged. A nested type whose name would hide another type it needs, such as one of your named types, `Date` or `Type`, is prefixed with its enclosing type's name (`Order.OrderAddress`).

- [#1259](https://github.com/aws/cdk-blocks/pull/1259) [`5f55dac`](https://github.com/aws/cdk-blocks/commit/5f55dac366a4a2fe4008869b9d97bb8ac51162c8) Thanks [@harsh62](https://github.com/harsh62)! - Boolean and numeric literals keep their JSON type, dates cross the wire as ISO 8601 strings, and a union's transferable alternatives keep their value

  **Boolean discriminators.** A union discriminated by a boolean, such as the result of the `Auth` block's `updateUserAttributes` (`{ isUpdated: true } | { isUpdated: false, nextStep }`), encoded the discriminator as the string `"true"` and decoded it as a string. The server sends a JSON `true`, so every call threw a `DecodingError`. It now encodes and decodes a boolean. The same applies to numeric discriminators (`{ code: 1, … } | { code: 2, … }`), whose cases are named `code1`, `code2`; a value with punctuation keeps it as `_`, so `1.5` and `15` are `code1_5` and `code15`, and `A$B` and `A$$B` under `action` are `actionA_B` and `actionA__B`. A boolean or numeric `const` that isn't a discriminator is now a `Bool`, `Double` or `Int`; it used to generate an enum that didn't compile.

  **Literal alternatives.** A union alternative that is one literal, such as TypeScript's `"auto" | number` or `false | { … }`, used to match any JSON value and encode `{}`. It's now a case with no payload that encodes as its value and decodes only from it. An alternative of several string values carries its own enum: `case level_Variant0(Level_Variant0)`.

  **Dates.** The server sends a `Date` (`format: date-time`) as an ISO 8601 string, `"2026-10-05T12:34:56.789Z"`. The generated client decoded it with a plain `JSONDecoder`, which expects a number, so no result holding a date decoded, and requests sent a number. A `Date` now decodes from that string (with or without fractional seconds, any UTC offset) in a result, a property, a container, an optional, a union case and a channel message, and requests send it in the same form. Generated operations decode these results with `client.makeDecoder()`. The new `client.makeEncoder()` encodes a model the way a request does. A request parameter that is a `URL` is now sent as its string, not as `{"relative": …}`.

  **`format: date` is now a `String`.** A calendar day (`"2026-10-05"`) was a `Date`, which couldn't decode the server's string and would be sent as a date-time. It's now a `String`, like `format: time`. If your code reads or passes one of these properties as a `Date`, use the string, or parse it with `Date.ISO8601FormatStyle().year().month().day()`.

  **Transferable alternatives.** A union alternative that is a realtime channel, a file handle or an OIDC client (`RealtimeChannel<Note> | { error: string }`) was a case with no payload, so the channel was lost. The case now carries it: `case result_Variant0(RealtimeChannel<Note>)`. If your code matches or constructs one of these cases, add the value.

- [#944](https://github.com/aws/cdk-blocks/pull/944) [`b6b8ade`](https://github.com/aws/cdk-blocks/commit/b6b8ade77e95dc094a3f85f0f9499ca33d293f98) Thanks [@Simone319](https://github.com/Simone319)! - feat(swift): call each API namespace at its own path

  `BlocksClient` now POSTs a call to `{url}/{namespace}` — for example
  `…/cdk-blocks/api/reports` for `reports.build` — instead of the shared
  `/cdk-blocks/api`, the same path the TypeScript client uses. The backend's API
  gateway routes by path, so a namespace that runs on its own compute is now served
  by that compute when called from Swift too; until now every Swift call ran on the
  app's default compute. The JSON-RPC body is unchanged.

  Deploy the backend with `@aws-blocks/core` 0.8.0 or later, or any `@aws-cdk-blocks/core`, before shipping an app
  built with this version: an older backend serves only `/aws-blocks/api` and
  rejects the per-namespace path. If you run your own proxy in front of the API,
  make it forward the whole `/cdk-blocks/api/*` subtree, plus `/aws-blocks/api/*` for apps built
  before 1.0.0.

- [#1259](https://github.com/aws/cdk-blocks/pull/1259) [`5f55dac`](https://github.com/aws/cdk-blocks/commit/5f55dac366a4a2fe4008869b9d97bb8ac51162c8) Thanks [@harsh62](https://github.com/harsh62)! - Generated Swift clients compile when two properties would declare the same nested type

  The generator names an inline type after its property, and singularizes an array's element type. So `item: { … }` and `items: { … }[]` both declared a type named `Item`, and a `feed` channel next to a `feeds` list of channels both declared `FeedMessage`. The type was declared twice and the generated client didn't compile (`invalid redeclaration of 'Item'`). This happened in your named types, in an operation's parameters and result, and in a union's variants.

  Each name is now declared once. The property whose own type it is keeps the name. The other type takes its property's name without singularizing it: `items: [Items]`, `feeds: [RealtimeChannel<FeedsMessage>]`. If that's taken too, it gets a numeric suffix. For example, `tags: Record<string, { … }>` next to `tagsValue: { … }` gives `tags: [String: TagsValue_2]`, and a parameter named `result` next to an inline result gives `check(result: Check.Result_2) -> Check.Result`.

  An enum or union declared directly on one of your named types is generated at the top level of `Models.swift`, and there a second one with the same name used to be silently replaced by the first. For example, if `Order` and `Ticket` each had a `status` enum with different values, `Ticket.status` was typed as `Order`'s enum, so a ticket's status didn't decode. An inline type could also take the name of one of your named types, which was then missing from the client. Each one is now named after its type and property (`OrderStatus`, `TicketStatus`), and your named types always keep their names.

  An operation whose parameter and result each declared a type with the same name typed the parameter with the result's type: `setStatus(status:)` returning `{ status, … }` took a `SetStatus.Result.Status`. It now takes its own type, `SetStatus.Status`. Code that passes `.active` still compiles. Code that names the old type explicitly needs updating.

  A union with a case that has no payload no longer produces two compiler warnings (`variable 'c' was never mutated` and `variable 'lastError' was written to, but never read`).

  Every other generated name is unchanged.

- [#1478](https://github.com/aws/cdk-blocks/pull/1478) [`c98b0ac`](https://github.com/aws/cdk-blocks/commit/c98b0ac131a1947f58eaff22eb6c2b20a25ec66f) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - feat(swift): add `OIDCClient.authState`

  `OIDCClient` now has `public private(set) var authState: OIDCAuthState`, the state most recently
  emitted to `authStateChanges()` subscribers, or `.loading` before the first one. It is
  actor-isolated like the client's other state, so read it with `await client.authState`. An app
  can check the state once, such as on launch after `restore()`, without subscribing to a stream.
  This matches Kotlin's `authState.value`.

  `authStateChanges()` now yields the current `authState` first, then each state the client emits, as
  Kotlin's `StateFlow` does, so a subscriber always learns the state it starts in. A subscriber that
  only wants transitions can drop the first element.

- [#1478](https://github.com/aws/cdk-blocks/pull/1478) [`c98b0ac`](https://github.com/aws/cdk-blocks/commit/c98b0ac131a1947f58eaff22eb6c2b20a25ec66f) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - fix(swift)!: ask the server for no bearer tokens on the OIDC code exchange

  **Breaking:** `OIDCClient` signs in with a session cookie, so its code exchange now sends
  `tokens: false`, and a backend with bearer auth enabled no longer mints access and refresh tokens
  for it. After a sign-in, `getAccessToken()` returns `nil`: before, a directly federated sign-in on a
  backend with `allowBearerAuth` gave it a token, which an app could send as a bearer token. Requests
  through the generated client carry the session cookie instead, and `restore()` reads it on launch.
  `refresh()` and `onAuthFailure()` have no refresh token to use, so they send nothing and leave the
  signed-in state alone.

- [#902](https://github.com/aws/cdk-blocks/pull/902) [`dd5e807`](https://github.com/aws/cdk-blocks/commit/dd5e8073e8fb1c172302f0e9875a24415a4a535a) Thanks [@thisisabhash](https://github.com/thisisabhash)! - feat(swift): type `OIDCClient` by the spec's provider names

  **Breaking:** `OIDCClient` is now generic over the providers
  `signIn(provider:relayTo:launcher:)` takes. A direct or optional `oidc/client`
  result whose `x-blocks-type-args[0]` is a string enum generates a `CaseIterable`
  `Provider` enum in the method's namespace and returns
  `OIDCClient<OidcAuthApi.GetClient.Provider>`, so `signIn(provider: .google, ...)`
  accepts only that client's own providers and a typo doesn't compile. An untyped
  spec returns `OIDCClient<String>`, whose `signIn` still takes a `String`. Write
  `OIDCClient<String>` (or the generated enum) where code names `OIDCClient`,
  including for its static members, as in `OIDCClient<String>.generateVerifier()`.
  The new `OIDCProviderName` protocol is what a provider type conforms to.

  When the method's own types already use the name `Provider`, the enum is
  `ResultProvider` and codegen prints a `swift:` warning that names it. A nested
  `oidc/client` still decodes as `JSONValue` and gets no enum. A namespace that
  would generate a class named `CaseIterable` now takes an `Api` suffix.

- [#1478](https://github.com/aws/cdk-blocks/pull/1478) [`c98b0ac`](https://github.com/aws/cdk-blocks/commit/c98b0ac131a1947f58eaff22eb6c2b20a25ec66f) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - fix(swift): `OIDCClient.restore()` reads the server's session

  **Source-breaking:** `restore()` is now `@discardableResult func restore() async throws -> OIDCUser?`.
  Call it with `try`. It reads `GET <sessionPath>` with the session cookie, plus the stored access
  token when there is one that hasn't expired. `sessionPath` is the descriptor's `sessionPath`, or
  `session` beside the block's callback route (`/cdk-blocks/auth/session` by default) when the
  descriptor names none. On 200 it emits `.signedIn` with the server's user and returns it. On 401 it
  clears stored tokens, emits `.signedOut` and returns `nil`. On 404 (the backend's `Auth` block has
  no federated providers, so it serves no session route) it throws an `ApiError` with `status` 404
  that says so. A response without a usable `user` (none, or one without a `userId` or `username`)
  throws a `TransportError` with `statusCode` 200, as a refresh response without an access token does. Any other failure (an `ApiError`, a `TransportError`, a
  `CancellationError` or a `ClientClosedError`) is thrown and leaves the state and stored tokens
  unchanged. A custom block whose method returns an `oidc/client` must now serve that session route
  for `restore()` to work.

  Previously `restore()` reported signed out whenever no tokens were stored, even with a valid
  session cookie, and built the user from the access token's `sub` claim instead of the server's
  `userId`. It no longer emits `.loading`.

- [#1478](https://github.com/aws/cdk-blocks/pull/1478) [`c98b0ac`](https://github.com/aws/cdk-blocks/commit/c98b0ac131a1947f58eaff22eb6c2b20a25ec66f) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - fix(swift): `OIDCClient.signOut()` returns the identity provider's logout URL and reports failures

  **Source-breaking:** `signOut()` is now `@discardableResult func signOut() async throws -> URL?`.
  Call it with `try`. It POSTs `<signOutPath>?format=json` and returns the provider's logout URL, or
  `nil` when there is none, or when a custom block's route answers with an empty 2xx body. Open that
  URL in the browser, such as with `UIApplication.shared.open`, to end the provider's own session; the
  client doesn't open it. Don't open it in a sign-in sheet: the provider's logout redirects to the
  backend's post-sign-out page, never to `relayTo`, so a `WebAuthenticationSessionLauncher` sheet stays
  open until the user closes it and ends in `OIDCError.cancelled`. When the server cleared the cookie but could not remove its session, it
  signs out locally and throws an `ApiError` named `SignOutIncompleteException` (HTTP 503). Any
  other failure (a `TransportError`, a `CancellationError`, an `ApiError` with another status) also
  signs out locally before it throws: the client clears the block's stored tokens, removes the
  block's session cookie (and no other block's), and emits `.signedOut`. The client knows that cookie
  by the `oidc/client` descriptor's `sessionCookieName`; from a backend that doesn't send it, by the
  cookie names the block's sign-in response set. A sign-out on a closed client throws
  `ClientClosedError` and changes nothing.

  Previously the server's empty 204 response failed to parse, the failure was ignored, and the logout
  URL was dropped. The body is now `{}`: the server ends the session from its cookie and never read
  the `refreshToken` the client used to send, which also means sign-out doesn't revoke bearer tokens.

- [#1478](https://github.com/aws/cdk-blocks/pull/1478) [`c98b0ac`](https://github.com/aws/cdk-blocks/commit/c98b0ac131a1947f58eaff22eb6c2b20a25ec66f) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - feat(swift): add `displayName` to `OIDCUser`

  `OIDCUser.displayName` is the name to show a signed-in user, for display only. It is `nil` when the
  server sends none: the code exchange doesn't, while `restore()` reads it from the session. Fall back
  to `username`. The new `init` parameter defaults to `nil`, so existing calls still compile.

- [#1478](https://github.com/aws/cdk-blocks/pull/1478) [`c98b0ac`](https://github.com/aws/cdk-blocks/commit/c98b0ac131a1947f58eaff22eb6c2b20a25ec66f) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - feat(swift): add `userSub`, `signInProvider` and `attributes` to `OIDCUser`

  `OIDCUser` now carries the optional `userSub`, `signInProvider` and `attributes` the `Auth` block
  sends with a signed-in user, beside `userId`, `username` and `groups`. Each is `nil` when the
  server sends none. The new `init` parameters default to `nil`, so existing calls still compile.

- [#1481](https://github.com/aws/cdk-blocks/pull/1481) [`3ab2a73`](https://github.com/aws/cdk-blocks/commit/3ab2a738e9aacd1c47cab3cb5bea67c4d7fcb97b) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - feat(swift): decode enum values a client doesn't know

  A string enum that a response can carry (one reachable from a method result, at any depth) is now
  open, so a value a newer backend adds no longer makes decoding throw `DecodingError`. Such an enum
  keeps its cases and gains `case unknown(String)`, which holds the value as the server sent it and
  encodes back as that string, so an unknown value round-trips. When a spec value is already named
  `unknown`, the fallback case is `unknownValue`. Equality and hashing follow the cases, as `switch`
  does, so a hand-built `.unknown("a")` isn't equal to `.a`. An enum that only parameters use stays a
  closed `String` enum.

  **Breaking in source.** An exhaustive `switch` over an open enum needs a
  `case .unknown` (or `default`) branch. `init(rawValue:)` no longer returns an optional, so
  `if let` or `guard let` on it stops compiling. The enum declares `RawRepresentable, Codable,
Hashable` instead of a `String` raw type; `.rawValue` still returns the wire string.

- [#1259](https://github.com/aws/cdk-blocks/pull/1259) [`5f55dac`](https://github.com/aws/cdk-blocks/commit/5f55dac366a4a2fe4008869b9d97bb8ac51162c8) Thanks [@harsh62](https://github.com/harsh62)! - Custom sign-up attributes are now sent correctly

  Custom sign-up attributes are now sent correctly. The `signUp` action of an `Auth` block's `createApi()` is a schema with both `properties` and `additionalProperties` (TypeScript `T & Record<string, V>`), and its generated struct collects the extra keys in `attributes`. When such a struct was declared inside an operation (`Api.SignUp.Input`) or as a union variant (`AuthApi.SetAuthState.SignUp`), it was sent with its `attributes` nested under an `"attributes"` key, so `.signUp(AuthApi.SetAuthState.SignUp(password: …, username: …, attributes: ["email": …]))` didn't set the user's `email`: the server received one attribute named `attributes` holding an object instead. In the other direction, a response's extra keys weren't read into `attributes`. These structs also had no `public init`, so code outside the generated module couldn't construct them.

  Each entry of `attributes` is now its own key, next to the struct's properties, in both directions, wherever the struct is declared, as it already was for your named models. Every such struct has a `public init(…, attributes: [String: V] = [:])`. A key that names one of the struct's properties, or the union's discriminator (`action`), is never read into `attributes`, and an `attributes` entry with such a name isn't sent, so the typed property wins. Named models now skip such an entry too; before, it overwrote the property on the wire.

- [#1481](https://github.com/aws/cdk-blocks/pull/1481) [`3ab2a73`](https://github.com/aws/cdk-blocks/commit/3ab2a738e9aacd1c47cab3cb5bea67c4d7fcb97b) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - feat(swift): decode union arms a client doesn't know

  A union with a string discriminator that a response can carry is now open, so an arm a newer
  backend adds no longer makes decoding throw `DecodingError`. An object whose discriminator names no
  arm decodes to `case unknown(JSONValue)`, which holds the object as the server sent it and encodes
  back as equal JSON, so it round-trips. Key order and number formatting may differ, and an integer
  beyond `Int64` loses precision, since `JSONValue` holds it as a `Double`. The union's
  `unknownDiscriminator` gives that arm's tag, and is nil for a known arm. When an arm is already
  named `unknown` (an arm tagged `unknown`), the fallback case is `unknownValue`. Unions only
  parameters use, unions with a boolean discriminator or a bare value arm, and a union embedded in
  another arm's object stay closed.

  **Breaking in source.** An exhaustive `switch` over an open union needs a
  `case .unknown` (or `default`) branch.

- [#1259](https://github.com/aws/cdk-blocks/pull/1259) [`5f55dac`](https://github.com/aws/cdk-blocks/commit/5f55dac366a4a2fe4008869b9d97bb8ac51162c8) Thanks [@harsh62](https://github.com/harsh62)! - Generated types now have a `public init`, so you can construct them from another module

  The generated Swift client declared its types as `public struct`, but most of them had no `public` initializer. Swift's built-in memberwise initializer is `internal`, so code outside the module holding the generated client couldn't create one. If you kept the generated client in its own Swift package or module, you couldn't build a `CreateTodo.Input` to pass to an API method, or a model for a test or a SwiftUI preview. Only types with a spec default or a validation constraint had a public initializer.

  Every generated struct now has a `public init`: your named types, the types nested inside them, the payloads of union cases, and the inline parameter and result types of each operation. Its parameters are the properties sorted by name (`SignIn(password:username:)`), as the initializers generated before were, with the same labels as before, so existing calls compile unchanged. An open record's `attributes:` and a hybrid arm's `challenge:` come last. Optional and nullable properties now default to `nil`, so you can leave them out: `Note(id: "n1", title: "Hello")`. Encoding and decoding are unchanged.

  A property named `self` keeps its label, `Holder(self: …)`, and is now assigned correctly. Before, the parameter hid the instance, so a struct with such a property didn't compile once it had an initializer.

- [#1580](https://github.com/aws/cdk-blocks/pull/1580) [`edf7dd2`](https://github.com/aws/cdk-blocks/commit/edf7dd22a29ae30ea26c582e67a3c5868a3f079d) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - feat(swift): end a realtime subscription with a typed error instead of going quiet

  A channel token now expires after about an hour, and the backend can revoke a user's access. The server reports either one with an error frame after the client's keep-alive ping. `RealtimeChannel` now sends that ping and reads those frames, so a subscription that the server ends no longer stops receiving without telling the app.

  - The stream from `subscribe()` finishes normally only when you cancel the iteration or call `close()`. Every other end finishes it with an error.
  - New case `RealtimeError.subscriptionEnded(channel:code:message:underlyingError:)`: the server ended this channel's subscription or refused it. `code` is the server's string as sent: `"token_expired"` (get the channel again), `"access_revoked"` or `"principal_mismatch"` (don't retry as the same user), or `nil` for a refused subscribe. New codes may appear, so treat an unknown one like `nil`. `underlyingError` is `nil` for now. Because `RealtimeError` is an enum, an exhaustive `switch` over it needs a case for this.
  - `RealtimeError.connectionFailed` now also covers an error frame that names no channel: it carries the server's message, ends every subscription on the socket and closes the socket. When the server or the gateway closes the socket, the message includes the close code and reason and there is no underlying error; when the socket fails, the platform error is the underlying error. A socket that ends any of these ways is dropped from the pool, so the next `subscribe()` opens a new one instead of joining the dead one.
  - Every subscription to one `wsUrl` (which carries the connect token) now shares one socket, whatever its channel or channel token. Before, each channel token opened its own socket.
  - `subscribe()` doesn't wait for the server to confirm the subscription. A refused subscribe ends the stream with `subscriptionEnded`.
  - While a socket has a subscriber, the SDK sends `{"action":"ping"}` every 9 minutes, as the web client does. This also keeps API Gateway from closing an idle socket after 10 minutes.
  - When a channel's last subscriber on a socket leaves (cancel, `close()`, or a message that fails to decode) and the socket stays open for other channels, the SDK sends `{"action":"unsubscribe","channel":…}`, so the server stops delivering to it. It sends none when the server already ended that subscription, or when the socket closes or has failed.
  - Every frame the SDK sends on a socket (subscribe, unsubscribe, keep-alive) goes out in order through one queue, so leaving a channel and subscribing to it again can't reach the server as subscribe-then-unsubscribe. Frames are encoded as JSON, so a channel name or token with `"` or `\` stays valid.
  - Realtime sockets use their own `URLSession` whose request timeout is 10 minutes rather than the 60-second default, longer than the keep-alive ping. Opening a socket still fails after 30 seconds if the server never completes the handshake.
  - `close()` now finishes every active stream normally. Before, it closed the socket and left the streams waiting.
  - A message that fails to decode still ends the stream with the decoder's error.
  - The SDK doesn't renew a subscription or reconnect on its own. To renew, call the API method that returned the channel again and subscribe to the new handle.
  - `WebSocketDelegate` and `WebSocketConnection` are deprecated. `RealtimeChannel` no longer uses them.

- [#1577](https://github.com/aws/cdk-blocks/pull/1577) [`cd6c55a`](https://github.com/aws/cdk-blocks/commit/cd6c55a66cde0ac1045a7c0550e8292e29d10511) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - Codegen refuses an operation that takes a transferable parameter, as the Kotlin generator does

  **Breaking:** a spec with an operation that takes a transferable parameter no longer generates. A transferable (any `x-blocks-transferable` tag: a `RealtimeChannel`, a `FileDownloadHandle`, a `FileUploadHandle`, an `OIDCClient`, or a type a block's native package binds through `x-blocks-native-bindings`) only travels from the server to the client: the server never re-hydrates one that a client sends back. The Swift generator used to emit a method that took one anyway, and the call couldn't work. Generation now fails instead, with the Kotlin generator's message, for the first such parameter Kotlin would report:

  ```
  Transferable types (realtime/channel) cannot be serialized — they are read-only
  ```

  This covers a direct, optional, nullable, array or dictionary parameter, and a `$ref` to a transferable schema: the same parameters Kotlin refuses. A model, an inline object or a union that holds a transferable still generates, in Swift as in Kotlin, as does any transferable in a result.

- [#1572](https://github.com/aws/cdk-blocks/pull/1572) [`00a649b`](https://github.com/aws/cdk-blocks/commit/00a649b18808f79b0669c671a0c57cb0e342fb92) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - Generated enums and unions on a model are named after the model

  **Breaking:** an enum or union declared for a component schema's property is now named after the schema and the property, as on Dart: `AuthAction.capability` is `AuthActionCapability` (was `Capability`), `Order.status` is `OrderStatus` (was `Status`), `AuthenticatedUser.groups` is `[AuthenticatedUserGroups]` (was `[GroupValue]`). Before, it took the property's name, so a generic name like `Status`, `Kind` or `Capability` collided with a type your app declares, and the module didn't compile. The prefix is always added (`User.userType` is `UserUserType`), and an enum or union on a discriminated variant's field is named after the variant and its union (`EmailNotificationPayloadPriority`), also as on Dart.

  The Cognito user types are renamed the same way: `SignInProvider` is `AuthenticatedUserSignInProvider`, `DeliveryMedium` is `CodeDeliveryDetailsDeliveryMedium` and `GroupValue` is `AuthenticatedUserGroups`.

  A union without a discriminator names its cases after itself, so its cases are renamed with it: `Filter.value: string | number` was `Value` with `case value_Variant0(String)`, and is now `FilterValue` with `case filterValue_Variant0(String)`. A `switch` that matches these cases needs the new case names, even if it never names the type.

  Code that names these types needs the new names. No typealiases are declared for the old ones, since an alias would keep the generic name taken in your module.

- [#1572](https://github.com/aws/cdk-blocks/pull/1572) [`00a649b`](https://github.com/aws/cdk-blocks/commit/00a649b18808f79b0669c671a0c57cb0e342fb92) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - Generated models are `Sendable`

  Generated structs, enums and unions now conform to `Sendable` when everything they store does, so a Swift 6 actor can keep or return an `AuthState`, or take an `AuthActionInput`, without "sending ... risks causing data races". A type that stores a `RealtimeChannel` doesn't conform, nor does a type that stores one of those.

- [#1572](https://github.com/aws/cdk-blocks/pull/1572) [`00a649b`](https://github.com/aws/cdk-blocks/commit/00a649b18808f79b0669c671a0c57cb0e342fb92) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - One `AuthActionInput` serves every Auth block

  `setAuthState(input:)` takes one shared `AuthActionInput` in every Auth namespace, with its variants nested inside it (`AuthActionInput.SignIn`), when the backend's spec names the type (`x-blocks-type-name`). Before, each namespace declared its own identical `SetAuthState.Input`, so a sign-in screen written for one Auth block couldn't send to another without glue code. Each namespace's old names (`AuthApi.SetAuthState.Input`, `AuthApi.SetAuthState.SignIn`) still compile, as deprecated typealiases. A union with an arm that isn't a discriminated object keeps its per-operation type, since that arm's case is named after the union and couldn't keep its old name. When parameters of different shapes are given one name, the shape of the one whose `<namespace>.<method>` and parameter sort first takes it, whatever their order in the spec, and the others keep their per-operation types.

- [#797](https://github.com/aws/cdk-blocks/pull/797) [`c5dc763`](https://github.com/aws/cdk-blocks/commit/c5dc763f8ab504ab4c64864ce1b1131fafcbc54b) Thanks [@thisisabhash](https://github.com/thisisabhash)! - chore(swift): require Swift 6.2 (Xcode 26) and generate `nonisolated` types

  The package now declares `swift-tools-version: 6.2`, so building it needs Xcode 26 or a Swift 6.2
  toolchain; Xcode 15 and 16 can no longer resolve it. Apps can still build in Swift 5 or Swift 6
  language mode. An app moves to this release by changing its requirement to `from: "1.0.0"`.

  Every top-level generated type (`Blocks`, the namespace classes, `Servers` and the models) is now
  `nonisolated`. Generated code compiles in the app's target, so under Xcode 26's default `MainActor`
  isolation it was main-actor-isolated: `Blocks()` and `close()` could not be called from an actor or
  a detached task, and operations hopped to the main actor. It now behaves the same with or without
  that setting.

- [#1259](https://github.com/aws/cdk-blocks/pull/1259) [`5f55dac`](https://github.com/aws/cdk-blocks/commit/5f55dac366a4a2fe4008869b9d97bb8ac51162c8) Thanks [@harsh62](https://github.com/harsh62)! - Types that hold a realtime channel, a file handle or an OIDC client now compile and decode

  If one of your API's types had a property holding a transferable (a `RealtimeChannel`, a `FileDownloadHandle`, a `FileUploadHandle` or an `OIDCClient`), the generated Swift client didn't compile. This applied to a property, or to an array, dictionary or optional property, or to a property inside another type. An operation that returned a list of channels had the same problem. The transferable types weren't `Codable`, and the generated `Models.swift` didn't import `BlocksRuntime`. So you couldn't build a Swift client for an API that returns, say, a board holding its realtime channels.

  The transferable types are now `Codable`. Each one decodes from the descriptor the server sends (`{ "__blocks": "realtime/channel", … }`), the same way an operation that returns one directly hydrates it. Transferables are read-only: they only travel from the server to the client, so encoding one throws `EncodingError.invalidValue`, as on Kotlin and Dart. The `Encodable` half of the conformance only lets a generated `Codable` model hold one. A decoded channel rewrites `localhost` to `BlocksClient.baseHost` and connects with its connect token, as before. `Models.swift` now imports `BlocksRuntime` when it uses one of these types.

  An `OIDCClient` signs in through the `BlocksClient` that fetched it, so it decodes only with a decoder that carries that client. The new `BlocksClient.makeDecoder()` returns one, and a generated operation whose result holds an OIDC client at any depth now uses it. Every other operation still decodes with `JSONDecoder()`. If you decode such a type yourself, use `client.makeDecoder()`, or set `decoder.userInfo[.blocksClient]`. Without the client, decoding throws `DecodingError.dataCorrupted`.

  Decoding a transferable whose descriptor names a different type, or that lacks a required field, throws a `DecodingError`. `RealtimeChannel.fromJSON` still traps on a malformed descriptor, as before.

- [#807](https://github.com/aws/cdk-blocks/pull/807) [`26bf320`](https://github.com/aws/cdk-blocks/commit/26bf32022054483f639ac5d883caa454c14ff13c) Thanks [@VarshithaPamisetty](https://github.com/VarshithaPamisetty)! - feat(swift): emit typed transferable results for declared native bindings

  Codegen now reads the top-level `x-blocks-native-packages` and
  `x-blocks-native-bindings` catalogs from the spec. A method result whose
  `x-blocks-transferable` tag matches a binding with a `swift` package entry
  returns that package's type — directly, or as an optional when the result is
  nullable — importing the declared module and calling its
  `fromBlocksDescriptor` factory. Two tags may share one export; two exports
  cannot share a type name. `BlocksRuntime` references in a file that imports a
  declared module are module-qualified, since a declared package may export a
  name the runtime also exports, and each such file imports `BlocksRuntime`. The
  new public `validateTransferableDescriptor` checks the tag before the factory
  runs.

  Built-in tags keep their hard-coded path, and a direct result whose tag has no
  applicable binding still returns `UnknownTransferable`. A result bound to a
  package the app does not depend on fails to compile, naming the declared
  module; add the package and link its product to the target, or list its
  `x-blocks-native-packages` key under `optOutNativePackages` in
  `blocks.codegen.json` beside the spec. An opt-out that matches no declared
  package warns and generates, since the opt-out is build configuration rather
  than spec metadata. A catalog the generator cannot act on warns and is skipped:
  a declared package no binding references, a `kind` schema 1 does not define, or
  a binding on a built-in tag.

- [#1259](https://github.com/aws/cdk-blocks/pull/1259) [`5f55dac`](https://github.com/aws/cdk-blocks/commit/5f55dac366a4a2fe4008869b9d97bb8ac51162c8) Thanks [@harsh62](https://github.com/harsh62)! - A union's string, number, boolean, array and map alternatives now keep their value

  When a union mixed objects with other values, such as TypeScript's `string | { text: string }`, the generated enum gave each non-object alternative a case with no payload. Decoding `"abc"` produced `.query_Variant0`, which held no string and encoded back as `{}`. The first such case also matched any JSON value, so a number or boolean decoded silently as well. The value was lost in both directions.

  Each such case now carries its value, decoded and encoded as the bare JSON value: `case query_Variant0(String)`. A `number` alternative carries a `Double`, an `integer` an `Int`, a `boolean` a `Bool`, an array of strings a `[String]`, and a map a `[String: Int]` (or whatever the element type is). When an array's elements are objects, their struct is generated next to the union, like a variant's struct (`[Objs_Variant0]`). A JSON value that matches no alternative now throws a `DecodingError`. A `null` alternative still makes the union optional (`Query?`), and an empty object alternative is still a case with no payload.

  A union with a discriminator field (`{ kind: "a", … } | { kind: "b" } | string`) and a non-object alternative used to generate a client that didn't compile (`switch must be exhaustive`). It now compiles, and the value round-trips.

  Two unions that differ only in such an alternative (`string | { x }` and `number | { x }`) are no longer merged into one type.

  Case names are unchanged. If your code matches or constructs one of these cases, add the value: `case .query_Variant0(let text)`, `.query_Variant0("abc")`.

- [#656](https://github.com/aws/cdk-blocks/pull/656) [`0651e15`](https://github.com/aws/cdk-blocks/commit/0651e1560f1813ebe4a1a28e2006c10c7de3e505) Thanks [@VarshithaPamisetty](https://github.com/VarshithaPamisetty)! - feat(swift): fall back to UnknownTransferable for unbound transferable results

  A direct method result whose `x-blocks-transferable` tag has no known runtime
  binding now returns the public `UnknownTransferable` instead of a raw `Data?`
  that did not type-check, with one `AWSBLOCKS-NATIVE-001` diagnostic per unbound
  operation. A known transferable's inline type argument is now emitted as a
  qualified type (e.g. `RealtimeChannel<GetChannel.ResultMessage>`), so a generic
  transferable result compiles, and a nullable bound transferable result now
  hydrates to its optional concrete type; the unbound fallback stays direct-only.

- [#1259](https://github.com/aws/cdk-blocks/pull/1259) [`5f55dac`](https://github.com/aws/cdk-blocks/commit/5f55dac366a4a2fe4008869b9d97bb8ac51162c8) Thanks [@harsh62](https://github.com/harsh62)! - Fix generated methods that return nothing, and tuples' wire format

  - **A method that returns `Void`** bound the RPC result to a `let result` it never used. Swift warns about the unused value, so an app built with warnings as errors (`SWIFT_TREAT_WARNINGS_AS_ERRORS`) failed to compile its generated client. The method now discards the result (`_ = try await client.execute(request)`). Every other method is unchanged.
  - **Tuples** (`prefixItems`, TypeScript `[number, number]`) read and write a JSON array. The generated struct keeps its `item0`, `item1`, … properties, but its synthesized `Codable` read and wrote an object keyed by those names, which the server neither sends nor reads. The struct now decodes and encodes `[1, 2]`. An element missing from a shorter array (an optional element) decodes as `nil`.

- [#1601](https://github.com/aws/cdk-blocks/pull/1601) [`c61f8cb`](https://github.com/aws/cdk-blocks/commit/c61f8cb6547f7cf458ef1ea468f96292a5491cdf) Thanks [@thisisabhash](https://github.com/thisisabhash)! - feat(swift): sign in with OIDC through ASWebAuthenticationSession

  `WebAuthenticationSessionLauncher` is a `BrowserLauncher` built on `ASWebAuthenticationSession`, so an app can sign in with an `OIDCClient` without writing a launcher of its own. On iOS it opens the system's sign-in sheet; on macOS the system opens the sign-in in the user's default browser when that browser supports it, else in Safari. `signIn(provider:relayTo:)` uses one at its defaults: `try await oidc.signIn(provider: .google, relayTo: "myapp://auth")`. To choose the window the sheet opens over (`presentationAnchor:`, which an app that can show more than one window should pass) or to ask for a private browser session (`prefersEphemeralWebBrowserSession:`), pass one to `signIn(provider:relayTo:launcher:)`.

  - `relayTo` must use a custom URL scheme that the `Auth` block allows as a relay origin. A relay target with no scheme, or with `http` or `https`, throws `OIDCError.callbackError` before the sheet opens. An authorize URL that isn't `http` or `https` throws `OIDCError.invalidAuthorizeURL`.
  - Closing the sheet throws `OIDCError.cancelled`. Cancelling the task that called `signIn` dismisses the sheet and throws `CancellationError`. A sheet the system won't show, for example while the app is in the background, throws `OIDCError.callbackError` with the system's error as `underlyingError`.
  - One sign-in opens at a time. A second one while a sheet is open throws `OIDCError.callbackError` before anything opens, and so does signing in on iOS while the app shows no window.
  - `BrowserLauncher`'s documentation now says what a launcher throws: `OIDCError.cancelled` when the user backs out, `CancellationError` when the task is cancelled, and `OIDCError.callbackError` with the original error as its cause for any other failure.

### Patch Changes

- [#1598](https://github.com/aws/cdk-blocks/pull/1598) [`e3b5949`](https://github.com/aws/cdk-blocks/commit/e3b594970aa871e86bd11604bca39d1128c62c9f) Thanks [@soberm](https://github.com/soberm)! - Ship the LICENSE file with the Swift package.

- [#797](https://github.com/aws/cdk-blocks/pull/797) [`c5dc763`](https://github.com/aws/cdk-blocks/commit/c5dc763f8ab504ab4c64864ce1b1131fafcbc54b) Thanks [@thisisabhash](https://github.com/thisisabhash)! - fix(swift): make `BlocksClient.baseHost` safe to set from Swift 6 code

  `BlocksClient.baseHost` is now a computed property backed by a lock instead of a stored
  `static var`. App code in Swift 6 language mode can set it, e.g.
  `BlocksClient.baseHost = "192.168.1.10"`, without "reference to class property 'baseHost' is not
  concurrency-safe because it involves shared mutable state", and it is safe from any thread.
  Generated code no longer reads it: a realtime channel picks it up when `BlocksRuntime` decodes it.

- [#1259](https://github.com/aws/cdk-blocks/pull/1259) [`5f55dac`](https://github.com/aws/cdk-blocks/commit/5f55dac366a4a2fe4008869b9d97bb8ac51162c8) Thanks [@harsh62](https://github.com/harsh62)! - An operation that returns a realtime channel with an inline message type now compiles

  If an operation in your API returned a realtime channel whose message type was declared inline (for example `getChannel(): RealtimeChannel<{ message: string; timestamp: number }>`), the generated Swift client didn't compile: `cannot find type 'ResultMessage' in scope`. The message type is generated inside the operation's namespace (`Api.GetChannel.ResultMessage`), but the method's signature named it without that prefix. The same happened when such a channel was in a list, dictionary or optional result (`[RealtimeChannel<…>]`), or was a parameter.

  The method now returns `RealtimeChannel<GetChannel.ResultMessage>`. From another module, name it `RealtimeChannel<Api.GetChannel.ResultMessage>`. Channels whose message type is one of your named types (`RealtimeChannel<Note>`) or a primitive, and file handles, are unchanged.

- [#1259](https://github.com/aws/cdk-blocks/pull/1259) [`5f55dac`](https://github.com/aws/cdk-blocks/commit/5f55dac366a4a2fe4008869b9d97bb8ac51162c8) Thanks [@harsh62](https://github.com/harsh62)! - A realtime channel returned by an operation now decodes messages that hold an OIDC client

  When an operation returned a channel directly and its messages held an `OIDCClient` (for example `RealtimeChannel<SignInOption>`, where `SignInOption` has a `client` field), the generated client decoded each message with a plain `JSONDecoder`. Every message failed to decode with `Decoding an OIDCClient needs the BlocksClient that fetched it`. Such messages now decode with `BlocksClient.makeDecoder()`, which carries the client, as a result that holds an OIDC client already did. A channel inside a model was not affected.

- [#910](https://github.com/aws/cdk-blocks/pull/910) [`204be5e`](https://github.com/aws/cdk-blocks/commit/204be5eabd833a3beb4a4538e4c8431d66e4bb99) Thanks [@soberm](https://github.com/soberm)! - fix(swift): escape schema string values in generated Swift source

  Schema-controlled string values (field names, descriptions, patterns, enum values,
  discriminator tags, method names, server URLs, defaults) are now escaped when emitted into
  generated Swift source, so values containing special characters produce well-formed code and
  round-trip verbatim.

- [#1478](https://github.com/aws/cdk-blocks/pull/1478) [`c98b0ac`](https://github.com/aws/cdk-blocks/commit/c98b0ac131a1947f58eaff22eb6c2b20a25ec66f) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - docs(swift): sign the demo app in to federated providers through `getClient()`

  The demo's account screen shows one sign-in button per provider of the OIDC client from its
  backend's `createOidcApi().getClient()`, and signs in through `oidc.signIn(provider:relayTo:)`,
  which opens the system sheet with `WebAuthenticationSessionLauncher`; closing the sheet shows no
  error. It doesn't render the state's `signIn:<id>` actions. A federated user's `signOut` goes through `signOut()`,
  opening the provider's logout URL. The demo fetches the client once and keeps it. Actions that carry
  `unavailable` are disabled with the reason shown, and passkey actions are hidden.

- [#979](https://github.com/aws/cdk-blocks/pull/979) [`e34abf8`](https://github.com/aws/cdk-blocks/commit/e34abf803f1636287d2f64fe98770ec8e6c621c7) Thanks [@soberm](https://github.com/soberm)! - fix(swift): store Keychain cookies with a this-device-only accessibility class and check the store result

  Cookies are now stored with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` instead of
  `kSecAttrAccessibleAfterFirstUnlock`. The class is applied on every write, so a cookie stored by an
  earlier version moves to the new class in place the next time it is written, keeping its value — a
  signed-in session is not lost. A Keychain add or update that does not succeed is now logged instead
  of being ignored.

  Because these items can only be read and written while the device is unlocked, the cookie store
  now also keeps the jar in memory. While the Keychain cannot be read, requests carry the cookies
  from that copy; a cookie set or removed while the Keychain refuses the change is kept and written
  again on the next call, so a response that arrives while the device is locked does not lose the
  cookies it sets.

- [#797](https://github.com/aws/cdk-blocks/pull/797) [`c5dc763`](https://github.com/aws/cdk-blocks/commit/c5dc763f8ab504ab4c64864ce1b1131fafcbc54b) Thanks [@thisisabhash](https://github.com/thisisabhash)! - fix(swift): decode transferables nested in a result

  A generated result that holds a `RealtimeChannel`, `FileDownloadHandle` or `FileUploadHandle` below
  its top level (in a nested object, a `oneOf` arm or an array) no longer fails to compile with "does
  not conform to protocol 'Decodable'". The three types now conform to `Decodable`, `RealtimeChannel`
  when its message type does, and hydrate from their descriptor: a channel applies
  `BlocksClient.baseHost` and the `connectToken`, and decodes its messages with `JSONDecoder`. A
  realtime result at the top level now hydrates the same way, so a channel descriptor without
  `channel`, `wsUrl` or `token` throws `DecodingError` instead of trapping, and a descriptor that isn't
  an object throws `DecodingError` instead of `RPCError`. A file descriptor without `url` throws
  `TransferableError.invalidDescriptor`, as `fromJSON` does.

  The three types also conform to `Encodable`, so the generated `Codable` conformances compile, but
  encoding one throws `EncodingError`: transferables are read-only, as on Kotlin.

  The three classes are now `final`. They were `public` and not `open`, so only code that imports
  `BlocksRuntime` with `@testable` could subclass them. `FileDownloadHandle` and `FileUploadHandle` are
  also `Sendable` now, so Swift 6 code can pass them between actors. An `oidc/client` below the top
  level, which used to fail to compile, now decodes as its `JSONValue` descriptor, and the generator
  prints a `swift:` line; return it directly to get an `OIDCClient`.

- [#1478](https://github.com/aws/cdk-blocks/pull/1478) [`c98b0ac`](https://github.com/aws/cdk-blocks/commit/c98b0ac131a1947f58eaff22eb6c2b20a25ec66f) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - docs(swift): document the `Auth` sign-in flow

  The README has a new "Using `Auth`" section with the whole flow: exporting `createOidcApi()`,
  reading the state on launch, rendering one federated sign-in button per provider in the client's
  `providers` and signing in through `oidc.signIn(provider:relayTo:)`, running every other action through
  `setAuthState`, signing a federated user out through the OIDC client and opening the logout URL,
  disabling unavailable actions and hiding passkey actions. The "OIDC sign-in" section adds when a
  Universal Link as `relayTo` is worth a launcher of your own.

- [#1478](https://github.com/aws/cdk-blocks/pull/1478) [`c98b0ac`](https://github.com/aws/cdk-blocks/commit/c98b0ac131a1947f58eaff22eb6c2b20a25ec66f) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - fix(swift): name the missing field when an authorize-params response is incomplete

  When the server's authorize-params response lacks `authorizeUrl`, `clientId`, `scopes` or `state`,
  `OIDCClient.signIn` throws `OIDCError.callbackError` naming that field. The message used to embed
  the whole response, including the signed state and the nonce.

- [#1478](https://github.com/aws/cdk-blocks/pull/1478) [`c98b0ac`](https://github.com/aws/cdk-blocks/commit/c98b0ac131a1947f58eaff22eb6c2b20a25ec66f) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - fix(swift): refuse a relayed sign-in whose state can't be checked against its csrf

  `OIDCClient.signIn` now throws `OIDCError.stateMismatch` when the server's signed state has no
  payload that decodes to JSON with a `csrf`, as it already did when the `csrf` differed. Before, such
  a state skipped the check and the sign-in went ahead.

- [#1478](https://github.com/aws/cdk-blocks/pull/1478) [`c98b0ac`](https://github.com/aws/cdk-blocks/commit/c98b0ac131a1947f58eaff22eb6c2b20a25ec66f) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - `OIDCClient(...)` takes the `callbackPath` and `authorizeParamsBasePath` to sign in through

  A client built with `init` rebuilt both paths from `exchangePath` by replacing `/exchange`, so the IdP's `redirect_uri` was right only when the backend's callback ended in `/callback`. For an `Auth` block with `redirects.callbackPath: '/aws-blocks/auth/partner/return'` it sent `<base>/callback`, which isn't served or registered with the IdP. `init` now takes optional `authorizeParamsBasePath` and `callbackPath` arguments, the paths a client hydrated from the `oidc/client` descriptor already reads from it, and falls back to the derived ones when they're omitted, so existing calls are unchanged.

- [#1478](https://github.com/aws/cdk-blocks/pull/1478) [`c98b0ac`](https://github.com/aws/cdk-blocks/commit/c98b0ac131a1947f58eaff22eb6c2b20a25ec66f) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - fix(swift): sign in at the routes the OIDC client descriptor names

  `OIDCClient.fromJSON`, and a client decoded from an `oidc/client` descriptor, now keep the
  descriptor's `callbackPath` and `authorizeParamsBasePath`, exposed as the client's `callbackPath`
  and `authorizeParamsBasePath`. `signIn` requests authorize-params under that path and sends that
  callback as the identity provider's `redirect_uri`, so an `Auth` block with a custom
  `redirects.callbackPath` (such as `/aws-blocks/auth/sso/return`) signs in at its own routes. Both
  were rebuilt from `exchangePath` before, which sent the wrong `redirect_uri` for such a block. A
  descriptor without them still derives them from `exchangePath`. The provider id in the
  authorize-params path is now percent-encoded the way the server encodes it.

  `exchange` now refuses a provider the client wasn't built with, throwing `OIDCError.unknownProvider`
  before any request, as `signIn` already did. Raw routes are requested at the client URL cut before
  its first `cdk-blocks` or legacy `aws-blocks` path segment, which keeps an API Gateway stage prefix as it was written,
  percent-encoding included, and an IPv6 host's brackets. A URL with no such segment now drops its
  trailing `/`.

- [#1478](https://github.com/aws/cdk-blocks/pull/1478) [`c98b0ac`](https://github.com/aws/cdk-blocks/commit/c98b0ac131a1947f58eaff22eb6c2b20a25ec66f) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - fix(swift): move the unscoped 0.x OIDC tokens only into the default `Auth` block's client

  A 0.x version stored OIDC tokens under unscoped keys, for the `Auth` block's default routes. Before,
  the first `OIDCClient` on a `BlocksClient` to touch the token store took them, so a client for a
  second block (such as one on `/aws-blocks/auth/sso/*`) could take the default block's session. Now
  only a client whose `exchangePath` is `/cdk-blocks/auth/exchange`, or its `/aws-blocks/` twin, takes them; a client for any other
  block leaves them in place.

- [#1478](https://github.com/aws/cdk-blocks/pull/1478) [`c98b0ac`](https://github.com/aws/cdk-blocks/commit/c98b0ac131a1947f58eaff22eb6c2b20a25ec66f) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - fix(swift): store a correct token expiry and send the provider on OIDC refresh

  When a backend returns bearer tokens, `OIDCClient` now stores their expiry as now plus `expiresIn`
  seconds, in epoch milliseconds, on both the code exchange and refresh. It stored the raw seconds on
  exchange and `0` on refresh, so a token always read as expired. An `expiresIn` too
  large for epoch milliseconds is stored as already expired. Refresh still reads `expiresAt` when
  a response has no `expiresIn`. The client also stores the provider it signed in with and sends it on
  refresh, which a backend with two or more providers requires, and keeps the rotated refresh token.

  With no refresh token stored, as after a cookie-session sign-in, `refresh()` and `onAuthFailure()`
  send no request and leave the state alone; they used to emit `.signedOut` while the session cookie
  still worked. A refresh now ends the session only when the refresh route refuses it (an `ApiError` with status
  400 or 401): it clears the stored tokens and emits `.signedOut`. Any other failure is thrown and keeps
  the tokens and the state, so a later refresh can retry: no network or a response without an access
  token (a `TransportError`), a server error (an `ApiError` with another status), a cancellation or a
  closed client. `getAccessToken()` and `onAuthFailure()` keep the tokens on such a failure too. A refresh
  that a sign-in or sign-out on the same client overtook stores nothing. Concurrent callers share one
  refresh: a caller whose task is cancelled throws `CancellationError` at once, and the shared refresh
  keeps running for the others.

- [#1478](https://github.com/aws/cdk-blocks/pull/1478) [`c98b0ac`](https://github.com/aws/cdk-blocks/commit/c98b0ac131a1947f58eaff22eb6c2b20a25ec66f) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - fix(swift): keep a sign-in or sign-out that finishes while `restore()` is in flight

  `OIDCClient.restore()` now ignores its response when a sign-in or sign-out on the same client
  finished while the request was in flight. A late 401 no longer signs out a user who just signed in
  or clears their new tokens, and a late session no longer signs a user back in after a sign-out. In
  that case `restore()` emits nothing and returns the user of the current `authState`, or `nil`.

- [#1478](https://github.com/aws/cdk-blocks/pull/1478) [`c98b0ac`](https://github.com/aws/cdk-blocks/commit/c98b0ac131a1947f58eaff22eb6c2b20a25ec66f) Thanks [@ekjotmultani](https://github.com/ekjotmultani)! - fix(swift): check the relayed state before reporting an identity provider error

  `OIDCClient.signIn` now checks that the relay carries the state its sign-in was given, and that the
  state's envelope carries this sign-in's csrf, before it reads `error` from the callback. A callback
  with an `error` but a missing or different state, or another sign-in's csrf, throws
  `OIDCError.stateMismatch` instead of `callbackError` with the callback's text, so only the backend's
  relay for this sign-in can report a provider error.

- [#357](https://github.com/aws/cdk-blocks/pull/357) [`d275747`](https://github.com/aws/cdk-blocks/commit/d2757478e912482f7ff7e7eaefd240b5559b299e) Thanks [@pranavosu](https://github.com/pranavosu)! - fix(swift): send the realtime connect token on the WebSocket handshake

  `RealtimeChannel.subscribe()` could never connect to a deployed backend. The
  channel descriptor carries two separate credentials, and the Swift client used
  only one of them:

  - `connectToken` authenticates the WebSocket **handshake**. API Gateway's
    `$connect` route reads it from `queryStringParameters.token`.
  - `token` authorizes the per-channel **subscribe** message sent after the socket
    opens.

  `fromJSON` parsed `channel`, `wsUrl`, and `token`, and ignored `connectToken`
  entirely. `WebSocketSession.acquire` then connected to the bare `wsUrl`, so the
  handshake arrived unauthenticated and API Gateway rejected it. On Apple
  platforms that surfaces as `NSURLErrorDomain` code -1011, "There was a bad
  response from the server", with `_NSURLErrorWebSocketHandshakeFailureReasonKey`
  set — an error that names neither the token nor the route.

  `fromJSON` now appends `connectToken` to `wsUrl` as a `token` query parameter,
  which is what the Kotlin and Dart clients already do. Existing query parameters
  are preserved, and a descriptor without a `connectToken` hydrates unchanged.

  Everything that did not open a socket kept working, which is why this went
  unnoticed: `getChannel`, `publish`, and the cursor RPC calls are plain HTTP.
  `testGetChannelDescriptor` also passed, because it only asserted the descriptor
  was non-nil. It now asserts the hydrated `wsUrl` carries a connect token, so the
  gap is caught without a socket, and six unit tests in `RealtimeChannelTests`
  cover the query building (real base64url tokens pass through byte-for-byte,
  existing parameters survive, and `&` is encoded so a token cannot be truncated).

- [#975](https://github.com/aws/cdk-blocks/pull/975) [`057a514`](https://github.com/aws/cdk-blocks/commit/057a51412d1402aa2fb1ffece6faf4eb047a89dc) Thanks [@soberm](https://github.com/soberm)! - fix(swift): check the result of the system random number generator in `OIDCClient`

  `OIDCClient.generateVerifier()` and `OIDCClient.generateNonce()`, which also produce the sign-in `csrf` value, now check the status that `SecRandomCopyBytes` returns and stop the process with `fatalError` if the call fails, as the standard library's `SystemRandomNumberGenerator` does, instead of returning a buffer the call did not fill. Their signatures are unchanged, and on success they return values generated the same way as before.

- [#1560](https://github.com/aws/cdk-blocks/pull/1560) [`34390c0`](https://github.com/aws/cdk-blocks/commit/34390c02f7949f2d30dec2978a5e449657b212e8) Thanks [@soberm](https://github.com/soberm)! - fix(swift): redact session values from debug logs

  Debug logging no longer includes credential values: a realtime channel logs the channel name
  instead of the subscribe message with its token, and the size of each inbound WebSocket message
  instead of its body; file uploads and downloads log the presigned URL's scheme, host and path without
  its query string.

- [#1087](https://github.com/aws/cdk-blocks/pull/1087) [`20835b0`](https://github.com/aws/cdk-blocks/commit/20835b0016d801b91ec76057474d9964efc7facd) Thanks [@VarshithaPamisetty](https://github.com/VarshithaPamisetty)! - fix(swift): name a usable remedy when a codegen config is not passed

  The refusal for a `blocks.codegen.json` the generator was not given now names the two
  steps that reach it: in an Xcode project, making the file a member of the target, like the spec;
  or passing it to the CLI as the third argument, after the output directory.
  It previously asked the reader to declare it in the target's resources, as
  `.copy("blocks.codegen.json")`, which an Xcode target has no place for and a CLI
  invocation has no target for, and which SwiftPM does not need — the build plugin forwards
  a sidecar beside the spec without it.

- [#1259](https://github.com/aws/cdk-blocks/pull/1259) [`5f55dac`](https://github.com/aws/cdk-blocks/commit/5f55dac366a4a2fe4008869b9d97bb8ac51162c8) Thanks [@harsh62](https://github.com/harsh62)! - Send request bodies with sorted keys, let callers leave out optional arguments with a nullable type, and fix two kinds of generated models that didn't compile

  - **Request bodies are the same bytes every time.** `JSONEncoder` on Apple platforms doesn't fix the order of an object's keys, so the same call could send `{"at":…,"title":…}` once and `{"title":…,"at":…}` the next. The client's encoder (`BlocksClient.makeEncoder()`, which every request uses) and the raw auth routes now sort keys. The server reads both orders the same way; this matters to anything that compares, caches or signs a request body.
  - **An optional argument can be left out even when its type is nullable.** A TypeScript `echoArgs(first: string, middle?: string, last?: string)` generated `echoArgs(first: String, middle: String?, last: String?)`, with no default for `middle` and `last`, so every call had to pass `nil` for them. Optional parameters now default to `nil`: `echoArgs(first: "a", last: "c")`. Calls that pass `nil` still compile and send the same request.
  - **A schema with a constraint (`minLength`, `pattern`, `minimum`, …) in `components` didn't compile** when the generated code is its own module: its init throws `CodegenError`, but `Models.swift` didn't import `BlocksRuntime` (`cannot find 'CodegenError' in scope`). `Models.swift` now imports `BlocksRuntime` whenever it uses a type from it.
  - **A string `default` or a `pattern` with special characters didn't compile.** A default was written in its JSON spelling (`"a\/b"`, `"\u0001"`), which isn't valid Swift, and a line break in a `pattern` ended the string literal. Both are now escaped like every other spec string in generated code, so a default like `a/b \(1+1)` is exactly that string, never an interpolation.

- [#1259](https://github.com/aws/cdk-blocks/pull/1259) [`5f55dac`](https://github.com/aws/cdk-blocks/commit/5f55dac366a4a2fe4008869b9d97bb8ac51162c8) Thanks [@harsh62](https://github.com/harsh62)! - `unknown`-typed fields now generate as `JSONValue` and keep their value

  A value the API types as `unknown` (for example `Record<string, unknown>`, such as the `claims` on an `AuthenticatedUser` your API returns) used to generate as an empty struct, which dropped the value and failed to decode anything but a JSON object. It now generates as `JSONValue` — `[String: JSONValue]` for a map, `[JSONValue]` for a list — which holds any JSON value.

- [#600](https://github.com/aws/cdk-blocks/pull/600) [`2a38dda`](https://github.com/aws/cdk-blocks/commit/2a38ddaf89bb6852c2d59328cc0c35c049d92fbf) Thanks [@VarshithaPamisetty](https://github.com/VarshithaPamisetty)! - feat(swift): send user-agent token on outbound runtime requests

  Every outbound runtime request now carries `blocksUserAgentToken`
  (`aws-blocks-swift/<version>`) so the backend can attribute the client and
  version: `BlocksClient` sets `x-blocks-user-agent` on the JSON-RPC hop, and a
  shared `BlocksRuntimeSession` sets `User-Agent` on the direct-to-AWS paths
  (presigned S3, WebSocket) without touching `URLSession.shared`.

  `FileUploadHandle.init` and `FileDownloadHandle.init` change their `session`
  parameter from `URLSession = .shared` to `URLSession? = nil`;
  when omitted it now defaults to the ephemeral, cookie-free `BlocksRuntimeSession`
  instead of `URLSession.shared`. A caller that passes its own session owns that
  session and opts out of the token.

- [#565](https://github.com/aws/cdk-blocks/pull/565) [`7807607`](https://github.com/aws/cdk-blocks/commit/780760776108bf2dc4a748ef03469bdcb289c1a0) Thanks [@VarshithaPamisetty](https://github.com/VarshithaPamisetty)! - feat(swift): add committed version constant and user-agent token

- [#1642](https://github.com/aws/cdk-blocks/pull/1642) [`08182b5`](https://github.com/aws/cdk-blocks/commit/08182b5fb421e5550d93e3506922b5a3957565eb) Thanks [@xyos](https://github.com/xyos)! - Document the generated `Blocks` initializer, client lifetime, OIDC launcher options and sign-in errors. Update the demo to build against the framework checkout and distinguish CLI code generation from the two Xcode plugins.

## 0.1.1

### Patch Changes

- [#102](https://github.com/aws-devtools-labs/aws-blocks/pull/102) [`38e28da`](https://github.com/aws-devtools-labs/aws-blocks/commit/38e28dac6408a467817020f2d9d1addbcef541f4) Thanks [@thisisabhash](https://github.com/thisisabhash)! - fix(swift): fix dependabot alerts in typescript demo app in native/swift folder

- [#40](https://github.com/aws-devtools-labs/aws-blocks/pull/40) [`9ffd853`](https://github.com/aws-devtools-labs/aws-blocks/commit/9ffd853d90c9fec4686eef23635269251a068c9d) Thanks [@thisisabhash](https://github.com/thisisabhash)! - chore(swift): update codegen for nullable discriminated unions

- [#94](https://github.com/aws-devtools-labs/aws-blocks/pull/94) [`1d4235d`](https://github.com/aws-devtools-labs/aws-blocks/commit/1d4235d4700b428af616432d2fbca6502354bf44) Thanks [@thisisabhash](https://github.com/thisisabhash)! - chore(swift): add unit tests, swiftformat and swiftlint github actions for swift

## 0.1.0

Initial version
