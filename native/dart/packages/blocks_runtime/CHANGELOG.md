## 1.0.0

### Breaking

- Errors follow one taxonomy shared with the Kotlin and Swift clients. Every
  error is a `BlocksException`. `BlocksRpcException` is renamed `ApiException`
  (`code` is now `status`, `data` is removed); match errors by `name` with the
  new `isBlocksError`. Network and malformed-response failures throw
  `TransportException`, and calls after `close()` throw `ClientClosedException`.
- `OidcClient.signIn` is now the relay sign-in (was `signInRelay`); the direct
  flow that was `signIn` is now `signInDirect`.
- `OidcClient.signOut()` returns the identity provider's logout URL, and
  `restore()` reads the backend's session route.
- Clients built without a `sessionStore` use the store set with the new
  `registerDefaultSessionStore`. With `blocks_runtime_flutter`, sessions now
  survive app restarts; pass `InMemorySessionStore()` to opt out.
- `SessionStore.cookieHeaderFor` is async, `cookieHeader` and `cookies` are
  removed from the interface, and the built-in stores are `final`.
- Transferables no longer have `toJson()` and can't be sent back to the server.
- A realtime subscription never ends silently: the stream emits a
  `RealtimeException` (including the new `RealtimeSubscriptionEndedException`)
  before it closes. `RealtimeChannel` is `final` and `WebSocketPool` is no
  longer exported.
- `BrowserLauncher.launch` takes a `cancel` parameter.
- Cookies stored in the format written before 0.2.0 are dropped.
- Requires `http` 1.5.0 or later.

### Other changes

- Add `TypedOidcClient` and `OidcProvider` for type-safe provider names.
- Add `FileTokenStore` for pure Dart programs.
- On desktop, `signIn` works without a launcher through a loopback listener.
- OIDC tokens are stored per `Auth` block; existing tokens are migrated.
- Add `OidcClient.authState`; `authStateChanges` emits the current state first.
- Realtime sockets send a keep-alive ping, carry several channels each, and
  time out a stalled handshake after 30 seconds.
- Use the `/cdk-blocks/` backend paths; `/aws-blocks/` URLs keep working.
- Fix several token refresh, restore and sign-out races.

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
