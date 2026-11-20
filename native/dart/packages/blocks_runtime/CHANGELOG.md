## Unreleased

These changes ship in 0.3.0, not a 0.2.x patch, because of the `toJson()` removal and the sign-out below.

### Breaking

- `OidcClient.signIn` is now the relay sign-in that was `signInRelay`, the
  flow the client a block's `getClient()` returns is for, as in Kotlin and
  Swift. The direct custom-scheme flow that was `signIn` is now
  `signInDirect`. `TypedOidcClient` renames both the same way. Rename
  `signIn` calls to `signInDirect`, then `signInRelay` calls to `signIn`.
- **Behavior change:** a `BlocksClient` or `OidcClient` built without a
  `sessionStore`, including the generated `Blocks` built without one, now
  uses the default store `registerDefaultSessionStore` sets instead of a new
  `InMemorySessionStore`. In a
  Flutter app that depends on `blocks_runtime_flutter`, that is a store in the
  platform's secure storage shared by every client, so a signed-in user stays
  signed in after the app restarts, as in the Swift and Kotlin SDKs. An app
  that relied on the session ending when the process exits must now pass
  `sessionStore: InMemorySessionStore()`, or call
  `registerDefaultSessionStore(null)` at startup. Without
  `blocks_runtime_flutter`, and on the web, the default is still a new
  `InMemorySessionStore` per client.
- **Breaking:** `InMemorySessionStore` and `PersistentSessionStore` are
  `final` classes, so they can gain members later without breaking anyone.
  Implement `SessionStore` for a store of your own; in tests, use a
  `PersistentSessionStore` over an `InMemoryTokenStore` instead of a mock.
- **Breaking for classes that implement `SessionStore`:**
  `cookieHeaderFor(Uri)` returns `Future<String?>` instead of `String?`, so an
  implementation must make it `async` and a caller must `await` it.
  `PersistentSessionStore` completes it only after it has read its
  `TokenStore`, so the first request after a restart sends the saved session
  and calling `load()` yourself is no longer needed. A cookie the store has
  set or removed since is not replaced by the stored copy when `load()` runs
  again.
- **Breaking:** remove `SessionStore.cookieHeader`, which joined every stored
  cookie whatever its host, `Path` or `Secure` flag. Use
  `cookieHeaderFor(requestUri)`, which sends only the cookies that apply.
- **Breaking:** remove `cookies` from the `SessionStore` interface. An
  implementation no longer has to provide it, and code that reads it through
  a `SessionStore` (such as `BlocksClient.sessionStore.cookies`) no longer
  compiles: use `cookieHeaderFor(requestUri)`. `InMemorySessionStore` and
  `PersistentSessionStore` keep `cookies`, for debugging and tests; it returns
  what is held in memory, whatever the host, `Path` or `Secure` flag.
- Errors follow one taxonomy shared with the Kotlin and Swift clients. Every
  error the runtime throws is a `BlocksException` (new), which carries
  `message` and `cause`:
  - `BlocksRpcException` is renamed `ApiException`: the server considered the
    request and said no. `code` becomes `status`, the HTTP status the server
    rejected with, and JSON-RPC's reserved codes (`-32700` to `-32603`) are
    reported as 500, as in the TypeScript client. `data` is removed; read
    `name`, the server's error name, and `retriable`, which the server sends
    for a step of a multi-step flow that can be retried. For a reserved code
    the server sends without a name, `name` is the code's own name, such as
    `MethodNotFound`. A JSON-RPC error is an `ApiException` at any HTTP
    status.
  - Add `isBlocksError(error, name)`, true for an `ApiException` with that
    `name`, as in the TypeScript client. Match on it rather than on `status`:
    a named error thrown without a status arrives as a 500.
  - Add `TransportException`, with a nullable `statusCode`, for a call that got
    no usable JSON-RPC result. A refused connection, a DNS or TLS failure or a
    timeout used to throw the HTTP client's own error (such as
    `http.ClientException`, `SocketException` or `TimeoutException`), which is
    now its `cause`. A non-2xx response with no JSON-RPC error, such as a
    gateway's `{"error":"Not Found"}`, used to throw a `TypeError`, and one
    such as `{"message":"Forbidden"}` returned null as a success. A body that
    is not JSON threw a `FormatException`. All of these are now a
    `TransportException`. An envelope with no `result`, which the server sends
    for a method with no return value, still returns null.
  - A call through a `BlocksClient` after `close()` throws a
    `ClientClosedException` and sends nothing. It used to throw the HTTP
    client's `ClientException`. So does every call of an `OidcClient` that a
    generated client hydrated from that `BlocksClient`'s result, such as the
    one `getClient()` returns, and closing the `BlocksClient` closes that
    `OidcClient`'s HTTP client too. An `OidcClient` built with its own
    `httpClient`, or from a descriptor the app built, is not affected.
  - A failed `FileUploadHandle.upload` or `FileDownloadHandle.download` throws
    a `FileTransferException` with the HTTP status as `statusCode`, or a null
    `statusCode` and the HTTP client's error as `cause` when no response
    arrived. It threw a plain `Exception` with the status in its message.
  - A descriptor the client can't hydrate throws a `TransferableException`; a
    missing or mistyped field throws its subtype `InvalidDescriptorException`,
    which names the `blocksType` and the `missingField`. They used to throw a
    `FormatException`, and `RealtimeChannel.fromJson`,
    `FileUploadHandle.fromJson` and `FileDownloadHandle.fromJson` a
    `TypeError`.
  - `RealtimeChannel.subscribe()` on a closed channel throws
    `RealtimeChannelClosedException` instead of a `StateError`, and a failed
    WebSocket connection is emitted on the stream as a
    `RealtimeConnectionException` with the WebSocket error as `cause`. Both
    are kinds of the new sealed `RealtimeException`.
  - `OidcException` extends `BlocksException`. An auth route that refuses a
    request (`restore()`, `refresh()`, `signOut()`) throws an `ApiException`
    with the status and the server's error name, so
    `isBlocksError(e, 'SignOutIncompleteException')` works; an unreadable 2xx,
    or no response, throws a `TransportException`. `signOut()` still signs
    out locally first, whatever the outcome. So does every other OIDC call,
    `signIn`, `signInDirect` and `exchange` included, when no response
    arrives or it can't be read; they used to throw the HTTP client's own
    error. A refused exchange still throws `OidcExchangeException`, now with
    the `ApiException` as its `cause`. `OidcCancelledException`, and an
    `http.RequestAbortedException` from a request the caller aborted, pass
    through unwrapped.
  - Requires `http` 1.5.0 or later, which added `RequestAbortedException`.
- An `OidcClient` from a block's `getClient()` (or `OidcClient.fromJson`) stores
  its tokens and sign-in state under keys prefixed with the directory of the
  block's `exchangePath`, such as `/aws-blocks/auth/access_token`, so the
  clients of several `Auth` blocks can share one token store. They used to share
  the unprefixed keys and overwrite each other's tokens. A client built with the
  constructor keeps the unprefixed keys.
- An `OidcClient` from `fromJson` moves the tokens version 0.2.0 or earlier
  stored under the unprefixed keys to its own keys the first time it reads or
  writes them, so upgrading doesn't sign a bearer session out. Only the client
  of the default block (`exchangePath` `/aws-blocks/auth/exchange`, the one
  0.2.0 signed in against) takes them, and only when it has no tokens of its
  own, whatever other blocks share the store and in whatever order they are
  used.
- `OidcClient.signOut()` returns `Future<Uri?>`, the identity provider's logout
  URL, or null when it has none. Open it with the app's launcher to end the
  provider's own session; the client doesn't open it. It POSTs
  `{signOutPath}?format=json` with an empty JSON body; it no longer sends the
  stored refresh token, which the server ignores. On a 2xx it clears the stored
  tokens and emits `OidcSignedOut`. It doesn't clear the session store, which
  may hold other `Auth` blocks' cookies; the server's `Set-Cookie` removes this
  block's cookie. On a 503 `SignOutIncompleteException` (the cookie was cleared
  but the server-side session was not removed) it does the same, then throws an
  `ApiException` with that `name`. Any other status (an `ApiException`), no
  response (a `TransportException`) or a cancelled request does the same: it
  clears this block's tokens, removes this block's session cookie (the
  descriptor's `sessionCookieName`, new `OidcClient.sessionCookieName`, or
  with an older backend the cookie its sign-in set) and emits
  `OidcSignedOut`, then throws. It used to ignore the response and drop the
  logout URL.
- `OidcClient.restore()` returns `Future<OidcUser?>` and reads the backend's
  session route (`GET <exchangePath's directory>/session`, new
  `OidcClient.sessionPath`) with the session cookie, plus the stored access
  token as a bearer token when there is one and it hasn't expired. A client from
  a custom block's `getClient()` now needs that route on the block. On 200 it
  emits `OidcSignedIn` with the server's user and returns it; on 401 it clears
  the stored tokens, emits `OidcSignedOut` and returns null; any other status
  throws an `ApiException` without changing the state (a 404 means the block
  serves no session route), and a 200 whose body has no readable `user` throws
  a `TransportException`. It no longer builds the user from the access token's JWT claims, so
  the user id is the server's, and it no longer emits `OidcLoading` first. It
  used to report signed out for a valid cookie session, because a cookie session
  stores no tokens.
- `OidcClient.authStateChanges` gives each new listener the current `authState`
  first, then each change, as Kotlin's `authState` flow does. It used to emit
  only the changes after the listener subscribed, so a listener added after
  `restore()` saw nothing until the next sign-in or sign-out.
- Remove `toJson()` from `RealtimeChannel`, `FileDownloadHandle`,
  `FileUploadHandle`, `OidcClient` and `UnknownTransferable`, which 0.2.0
  added. Transferables are read-only again: the server sends them, but never
  turns a `{"__blocks": …}` value it receives back into a live object, so an
  app shouldn't send a transferable to the server. Code that calls `toJson()`
  on one of these types no longer compiles, and `jsonEncode` of one throws
  `JsonUnsupportedObjectError`. Send the plain values the method needs instead.
- **Signs out users whose cookies are still in the format written before
  0.2.0:** `PersistentSessionStore` no longer reads the name → value map:
  `load()` deletes it and the cookies it held are not used. This applies to
  apps upgrading from a version before 0.2.0 whose stored cookies have not
  been replaced by a `Set-Cookie` since; those users are signed out once and
  sign in again. A stored cookie record without a `secure` field is read as
  `Secure`.
- `BlocksClient` now sends `x-blocks-user-agent` on web too, so a browser
  app's RPC calls appear in client traffic metrics. The web build dropped the
  header because the Blocks server's CORS preflight did not allow it, which
  `@aws-blocks/core` 0.6.0 fixed; every backend this version supports
  (`@aws-blocks/core` 0.8.0 or later) allows it. The presigned upload and
  download and the WebSocket upgrade are unchanged.
- On mobile and the web, a `signIn` call that leaves out the `launcher` now
  compiles and throws a `StateError` at run time, because no loopback sign-in
  exists there. It used to be a compile error.
- A class that implements `OidcClient` and overrides `signIn` with a
  required `launcher` no longer compiles.
- `BrowserLauncher.launch` takes a `Future<void>? cancel` named parameter, so
  a custom launcher must add it to its `launch` override. It is the `cancel`
  future the app passed to `OidcClient.signIn` or `OidcClient.signInDirect`, or
  null. A launcher throws `OidcCancelledException` when the launch ends
  without a redirect: the user closed the browser, its own timeout passed, or
  `cancel` completed.
- `OidcClient.signIn` now uses `cancel` with a launcher too: the client stops
  waiting and throws `OidcCancelledException` once it completes, even when
  the launcher keeps waiting. It used to apply only to the loopback sign-in.
  `OidcClient.signInDirect` and `TypedOidcClient.signInDirect` take a `cancel`
  parameter that works the same way.
- A realtime subscription never ends silently. Its stream closes normally
  only when the app cancels it or calls `RealtimeChannel.close()`; every other
  end emits one `RealtimeException`, then closes the stream:
  - Add `RealtimeSubscriptionEndedException`, a third kind of the sealed
    `RealtimeException`, with `channel`, `code`, `message` and `cause`. The
    stream emits it when the server ends or refuses this channel's
    subscription. `code` is the server's string as sent: `token_expired` (the
    channel token lasts about an hour; call the API method that returned the
    channel again and subscribe to the new handle), `access_revoked` or
    `principal_mismatch` (don't retry as the same user), or null for a
    refused subscribe. An exhaustive `switch` over `RealtimeException` needs a
    case for it.
  - When the server or gateway closes the socket, the stream emits a
    `RealtimeConnectionException`. It used to close with no error. So does an
    error frame from the server that names no channel. The SDK doesn't
    reconnect or renew the token by itself.
  - A message whose payload fails to decode now ends the stream after the
    decode error, as in Kotlin and Swift. The stream used to stay open.
  - `RealtimeChannel.close()` closes every active stream of the channel.
  - `subscribe()` still returns at once, without waiting for the server to
    confirm the subscription.
- `RealtimeChannel` is `final`, as in Kotlin and Swift, so a class can no
  longer extend or implement it.
- `WebSocketPool` is no longer exported. It was an internal of
  `RealtimeChannel`.

### Other changes

- `OidcClient.defaultCallbackPath` and
  `OidcClient.defaultAuthorizeParamsBasePath` use the backend's new
  `/cdk-blocks/auth/*` paths. Raw routes and auth requests resolve against the
  API origin cut at a `cdk-blocks` or legacy `aws-blocks` path segment, so a
  server URL configured with the old `/aws-blocks/api` path keeps working.
  Tokens a block stored under its old `/aws-blocks/` exchange path move to its
  `/cdk-blocks/` keys on first use, so an upgrade keeps the session.
- A token refresh that a sign-in or sign-out overtakes, even while it is
  still reading the stored refresh token, sends nothing or ignores its
  response. Callers that join a refresh already in flight now get its error
  when it fails; they used to see it succeed and go on with the expired
  token.
- A socket with a realtime subscription sends `{"action":"ping"}` every 9
  minutes, as the web client does. The ping keeps API Gateway from closing an
  idle socket after 10 minutes, and it is when the server re-checks each
  subscription's token and reports the ones that ended.
- Frames are routed by channel, so subscriptions to several channels on one
  WebSocket URL, or two `subscribe()` calls on one handle, each get only their
  own messages. Two subscriptions on one URL used to throw a `StateError`. A
  socket that fails or closes leaves the pool, so the next `subscribe()` opens
  a new one.
- When a channel's last subscription on a socket ends and the socket stays
  open for other channels, the client sends `{"action":"unsubscribe"}` for
  that channel, so the server stops delivering it.
- A new realtime socket that hasn't finished the WebSocket handshake after 30
  seconds is closed, and its subscriptions end with a
  `RealtimeConnectionException`. A server that accepted the connection and
  never answered the upgrade used to leave the subscription waiting forever.
  An open socket still has no idle timeout.
- A `restore()` still in flight when a sign-in or sign-out finishes ignores
  its response and returns the current user, or null. A late 401 used to sign
  out, and clear the tokens of, a sign-in that had just finished, and a late
  200 used to sign back in after a sign-out.
- The `OidcClient` docs say to hold one client per block for the app's
  lifetime instead of calling `getClient()` again.
- `OidcClient.signIn`'s `launcher` is optional. Without one, on macOS,
  Linux and Windows, it signs in through a loopback listener on `127.0.0.1` and
  relays to `http://127.0.0.1:<port>/oidc/callback`, as the Kotlin JVM client
  does; `relayTo` is not used then, and is now optional; with a launcher, a
  missing `relayTo` throws a `StateError` before any request. A `launcher`, when
  passed, always wins. Add `OidcClient.openBrowser`, which opens the browser for
  that sign-in, `OidcClient.signInTimeout`, after which it throws
  `OidcCancelledException`, and a `cancel` future that stops the wait with
  `OidcCancelledException` when it completes. `OidcCancelledException` takes an
  optional message.
- `OidcClient.signInDirect` throws `OidcCallbackException` for a callback that carries
  an IdP `error` or no `code`. It threw a `TypeError` from a null check. It also
  deletes the attempt's stored PKCE values whatever happens, where a launcher
  error or a state mismatch left them in the token store.
- `OidcClient.fromJson` reads the descriptor's `sessionPath` and `refreshPath`
  when it sends them, and otherwise derives them, and a missing `signOutPath`,
  `callbackPath` or `authorizeParamsBasePath`, from the directory of
  `exchangePath`, as `Auth` mounts them. The last two used to fall back to the
  default block's routes, so a block mounted elsewhere signed in against the
  wrong ones. A descriptor
  without `providers` or `providerConfigs`, or with a provider config that has
  no `kind`, now hydrates instead of throwing a `TypeError`. One without
  `exchangePath`, which every route is found from, throws a `FormatException`
  naming the field.
- The README gains a "Using Auth" section: the state machine through
  `getAuthState()` and `setAuthState` for everything but federated sign-in,
  one sign-in button per provider in the `providers` of the client
  `getClient()` returns, calling `signIn`, `signOut()` for a federated
  sign-out, and `getAuthState()` on launch.
- Add `OidcClient.authState`, the current sign-in state: the state most recently
  added to `authStateChanges`, or `OidcLoading` before the first one. An app can
  read it once, such as on launch after `restore()`, without subscribing to the
  stream. This matches Kotlin's `authState.value`.
- `OidcClient.signIn` checks the callback's `state` and the CSRF value in
  its envelope before it reads an IdP `error`. A redirect to the app's scheme
  that didn't come from this sign-in now fails the state check instead of
  reporting an IdP error.
- **Behaviour change:** with an `authProvider`, `BlocksClient` sends the session
  cookie on every call that has one, and adds `Authorization: Bearer` only when
  the provider returns a token. It used to drop the cookie whenever an
  `authProvider` was set, so an app that set an `OidcClient` signed in with the
  session cookie as its `authProvider` sent neither.
- `OidcClient.exchange` sends `tokens: false`, so a backend with bearer tokens
  enabled doesn't mint tokens for a client that signs in with the session
  cookie.
- `OidcUser` gains the optional fields the backend sends: `displayName`,
  `userSub`, `signInProvider` and `attributes`. Each is null when the server
  doesn't send it.
- `OidcClient.refresh` stores the new token's expiry from `expiresIn` seconds,
  which the auth block sends, keeping `expiresAt` as a fallback. It read only
  `expiresAt`, so every refreshed token looked expired and every
  `getAccessToken()` refreshed again. Refresh now also sends the provider the
  exchange signed in with (stored under `provider`), which a backend with
  several providers requires, and stores the rotated refresh token only when the
  response carries one.
- `OidcClient.refresh` and `onAuthFailure` sign out only when the refresh route
  answers 400 or 401. Any other status throws an `ApiException`, and no
  response or an unreadable 200 throws a `TransportException`, keeping the
  tokens and the state; both used to sign out. A refresh still in flight when a sign-in or sign-out finishes
  ignores its response, so it no longer stores tokens after a sign-out.
- `OidcClient` resolves the auth routes against its base URL cut at the first
  path segment that is `aws-blocks`, keeping any API Gateway stage. It used to
  strip one trailing `/aws-blocks/api`, so a base URL that repeated it
  (`…/aws-blocks/api/aws-blocks/api`) sent auth requests under the RPC path.
- Add `TypedOidcClient<P extends OidcProvider>`, an extension type over an
  `OidcClient` whose `signInDirect`, `signIn` and `exchange` take a provider of
  type `P` (and send its `providerName`) instead of a name, so a typo or a
  provider the client doesn't have is a compile error. Generated clients return
  one for a method whose spec names its providers. It is the same object as the
  `OidcClient` it wraps, with no cost at runtime: every other member is the
  client's, and it can be passed wherever an `OidcClient` is expected, where it
  takes names again. `OidcClient` itself is unchanged.
- Add `OidcProvider`, the interface a provider type implements: `providerName`
  is the name the backend knows the provider by.
- `OidcClient.signInDirect` throws `OidcUnknownProviderException` for a provider
  its descriptor doesn't list or has no config for, as `signIn` does. It used to
  fail a null check. A client whose `providerConfigs` has the provider but whose
  `providers` doesn't, such as `OidcClient(providers: const [], providerConfigs:
  {'google': …})`, used to sign in and now throws.
- `OidcClient.exchange` throws `OidcUnknownProviderException` for a provider its
  descriptor doesn't list, before sending anything, as Kotlin's does. It used to
  post the name to the backend, which rejected it with an
  `OidcExchangeException`, so an app that calls `exchange` directly and catches
  only `on OidcExchangeException` no longer catches it. Both extend
  `OidcException`.
- Add `registerDefaultSessionStore`, which sets the store clients use when
  given none. A registered store is created
  once and shared by every such client. Registering a different store after a
  client has received the default throws a `StateError`; registering the same
  function again does nothing, and `null` is always accepted.
- Add `FileTokenStore`, a `TokenStore` for pure Dart programs that keeps each
  value in a file under `~/.blocks/<applicationId>/dart/`. On Linux and macOS
  the directory is owner-only (`rwx------`) and each file `rw-------` (with `/bin/chmod` or `/usr/bin/chmod`,
  not whatever `chmod` is on `PATH`). Values are not encrypted. A `final`
  class. Not available on the web.
- `PersistentSessionStore` writes to its `TokenStore` only when the cookies
  change. It used to write on every response, including the many with no
  `Set-Cookie`. Writes run one at a time, in order.
- Add `PersistentSessionStore.flush()`, which completes when the writes
  queued so far have finished. A program that calls `exit` right after signing
  in awaits it, or the new session may not be stored.
- A `TokenStore` error while `PersistentSessionStore` reads or writes no
  longer escapes as an uncaught error, which ended the process. It is passed to
  the new `onPersistError` callback; without one it is logged with
  `dart:developer`'s `log` (name `blocks_runtime.session`, warning level) and
  written to standard error. Only the first failure is reported until a read
  or write succeeds again. The cookies keep working from memory. A failed
  write is retried on the next change. A failed read is retried when a cookie
  changes, and on a request made at least 30 seconds after the last failed
  attempt, so a store that was unreadable at launch (a Keychain item while the
  device is locked) is read once it becomes readable. Nothing is written until the store has been
  read, so a session that could not be read is not overwritten; a cookie
  change made meanwhile is written once a read succeeds. Signing out deletes
  the stored session even while the store can't be read. A stored value
  that is not a cookie list is now reported before it is deleted.

## 0.2.0

- **Breaking for classes that implement or override `BlocksClient`:**
  `call(String method, Object params)` takes `Object`, not
  `Map<String, dynamic>`, so an override must widen its parameter. Callers
  are unaffected.
- `BlocksClient.call` accepts its `params` as a `List` (positional) as well
  as a `Map`, and throws an `ArgumentError` for anything else before sending.
  Generated clients now send a list: an AWS Blocks server reads params by
  position, so a map that leaves a key out moves the later values up a slot.
- A realtime message that fails to decode (a payload the channel's decoder
  rejects, or a frame that isn't JSON) is now an error on the subscription's
  stream, which stays open for the next message. It used to be thrown inside
  the WebSocket listener, where the app could not catch it.
- Add `RealtimeChannel.fromJsonValue`, which decodes each message's payload as
  any JSON value, for channels whose message type isn't an object (such as
  `RealtimeChannel<List<String>>`). `RealtimeChannel.fromJson` is unchanged.
- `BlocksClient` now POSTs a call to `{baseUrl}/{namespace}` (for example
  `…/aws-blocks/api/reports` for `reports.build`) instead of the shared
  `/aws-blocks/api`, the same path the TypeScript client uses, so a namespace
  that runs on its own compute is served by that compute. The JSON-RPC body is
  unchanged. Deploy the backend with `@aws-blocks/core` 0.8.0 or later before
  shipping an app built with this version: an older backend serves only
  `/aws-blocks/api` and rejects the per-namespace path.
- Add `validateTransferableDescriptor`, which checks a descriptor's `__blocks`
  tag against the tag the spec declared and returns it.
- Add `UnknownTransferable`, returned for a direct method result whose
  transferable tag has no known runtime binding, instead of untyped `dynamic`.
- Fix `OidcClient`'s default `authorizeParamsBasePath` and `callbackPath`:
  they were `/auth/authorize-params` and `/auth/callback`, routes no auth
  block serves. They are now `/aws-blocks/auth/authorize-params` and
  `/aws-blocks/auth/callback` (exposed as
  `OidcClient.defaultAuthorizeParamsBasePath` and
  `OidcClient.defaultCallbackPath`), matching the backend's routes. A client
  built from a descriptor that names both paths is unchanged.
- Add `blocksDeepEquals` and `blocksDeepHash`, value equality for lists and
  maps (recursively, with a map's key order ignored). Generated models use
  them to compare their list and map fields.
- Add `toJson()` to `RealtimeChannel`, `FileDownloadHandle`,
  `FileUploadHandle`, `OidcClient` and `UnknownTransferable`. It returns the
  `{"__blocks": …}` descriptor the value was hydrated from, unchanged (keys
  this runtime doesn't read included), as a copy. An `OidcClient` built with
  its constructor describes its providers and paths, in the shape
  `OidcClient.fromJson` reads. Generated clients send a transferable this way
  when a call passes one back to the server, and `jsonEncode` calls it too.
- **Breaking:** `SessionStore` gains `cookieHeaderFor(Uri)` and an optional
  `requestUri` argument on `setCookies`; custom implementations must add both.
  `InMemorySessionStore` and `PersistentSessionStore` now parse and enforce the
  `Secure`, `Path` and `Expires`/`Max-Age` cookie attributes, matching the
  Kotlin runtime: a cookie is sent only to the host that set it, only to
  request paths under its `Path`, and, when `Secure`, only over `https`/`wss`.
  `Max-Age` takes precedence over `Expires`, and a cookie whose `Max-Age` is
  zero or less, or whose `Expires` has passed, is removed. A cookie with an
  empty value (`name=; Path=/`) is also removed rather than stored, as in the
  Swift runtime. Cookies are keyed by
  host, path and name rather than by name alone, and a new cookie replaces the
  same-named cookies that would be sent on that request, as in the Kotlin
  runtime. `cookieHeaderFor` lists the cookie with the longest `Path` first
  when several same-named cookies apply. `BlocksClient` and `OidcClient` pass
  the request URL to `cookieHeaderFor`, and to `setCookies` the URL of the
  response, which is the last redirect target when the HTTP client followed
  redirects. `cookieHeader` still returns every unexpired cookie.
- `PersistentSessionStore` now stores a JSON list of cookie records. The
  name → value map written by earlier versions is still read: those cookies
  keep `Path=/`, no `Secure` and no expiry, as before, until the server sets
  them again. That format recorded no host, so until then those cookies are
  sent to any host; the Swift runtime instead recovers the host from its
  earlier storage key. This applies only to cookies written before the upgrade
  and ends once the server sets each cookie again.

## 0.1.4

- Send the `aws-blocks-dart` user-agent token on outbound runtime requests

## 0.1.3

- Minor bug fixes and improvements

## 0.1.2

- Bump dependencies and minimal Dart version

## 0.1.1

- Minor bug fixes and improvements

## 0.1.0

- Initial release
