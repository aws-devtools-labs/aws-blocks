## Unreleased

The next release is 0.2.0, because of the breaking changes marked below.

- `OidcClient.signInRelay`'s `launcher` is optional. Without one, on macOS,
  Linux and Windows, it signs in through a loopback listener on `127.0.0.1`
  and relays to `http://127.0.0.1:<port>/oidc/callback`, as the Kotlin JVM
  client does; `relayTo` is not used then. A `launcher`, when passed, always
  wins. Add `OidcClient.openBrowser`, which opens the browser for that
  sign-in, `OidcClient.signInTimeout`, after which it throws
  `OidcCancelledException`, and a `cancel` future that stops the wait with
  `OidcCancelledException` when it completes. `OidcCancelledException`
  takes an optional message.
- **Breaking:** on mobile and the web, a `signInRelay` call that leaves out
  the `launcher` now compiles and throws a `StateError` at run time, because
  no loopback sign-in exists there. It used to be a compile error.
- **Breaking:** a class that implements `OidcClient` and overrides
  `signInRelay` with a required `launcher` no longer compiles.
- `OidcClient.signIn` throws `OidcCallbackException` for a callback that
  carries an IdP `error` or no `code`. It threw a `TypeError` from a null
  check. It also deletes the attempt's stored PKCE values whatever happens,
  where a launcher error or a state mismatch left them in the token store.
- Add `OidcClient.authState`, the current sign-in state: the state most
  recently added to `authStateChanges`, or `OidcLoading` before the first one.
  An app can read it once, such as on launch after `restore()`, without
  subscribing to the stream. This matches Kotlin's `authState.value`.
- Add `OidcClient.providerIdOf(actionName)`, which returns the provider id of
  an `Auth` state-machine action named `signIn:<id>`, or null for any other
  action. An app signs in with that id through `signInRelay`.
- The README gains a "Using Auth" section: `getAuthState()` and
  `setAuthState` for plain actions, `forAuth` with `signInRelay` and
  `signOut()` for federated ones, and `getAuthState()` on launch.
- `OidcClient.signInRelay` checks the callback's `state` and the CSRF value
  in its envelope before it reads an IdP `error`. A redirect to the app's
  scheme that didn't come from this sign-in now fails the state check
  instead of reporting an IdP error.
- **Behaviour change:** with an `authProvider`, `BlocksClient` sends the
  session cookie on every call that has one, and adds
  `Authorization: Bearer` only when the provider returns a token. It used to
  drop the cookie whenever an `authProvider` was set, so an app that set an
  `OidcClient` signed in with the session cookie as its `authProvider` sent
  neither.
- `OidcUser` gains the optional fields the backend sends: `displayName`,
  `userSub`, `signInProvider` and `attributes`. Each is null when the server
  doesn't send it.
- `OidcClient.exchange` sends `tokens: false`, so a backend with bearer
  tokens enabled doesn't mint tokens for a client that signs in with the
  session cookie.
- **Breaking:** `OidcClient.signOut()` returns `Future<Uri?>`, the identity
  provider's logout URL, or null when it has none. Open it with the app's
  launcher to end the provider's own session; the client doesn't open it. It
  POSTs `{signOutPath}?format=json` with an empty JSON body; it no longer
  sends the stored refresh token, which the server ignores. On a 2xx it
  clears the stored tokens and emits `OidcSignedOut`. It doesn't clear the
  session store, which may hold other `Auth` blocks' cookies; the server's
  `Set-Cookie` removes this block's cookie. On a 503
  `SignOutIncompleteException` (the cookie was cleared but the server-side
  session was not removed) it does the same, then throws an
  `OidcRequestException` with that `errorName`. Any other
  status, or a transport error, now throws: the stored tokens are cleared,
  but the session cookie and the state are kept. It used to ignore the
  response and drop the logout URL.
- `OidcClient.refresh` stores the new token's expiry from `expiresIn`
  seconds, which the auth block sends, keeping `expiresAt` as a fallback. It
  read only `expiresAt`, so every refreshed token looked expired and every
  `getAccessToken()` refreshed again. Refresh now also sends the provider
  the exchange signed in with (stored under `provider`), which a backend
  with several providers requires, and stores the rotated refresh token
  only when the response carries one.
- **Breaking:** `OidcClient.restore()` returns `Future<OidcUser?>` and reads
  the backend's session route (`GET <exchangePath's directory>/session`, new
  `OidcClient.sessionPath`) with the session cookie, plus the stored access
  token as a bearer token when there is one and it hasn't expired. A client
  from a custom block's `getClient()` now needs that route on the block. On
  200 it emits `OidcSignedIn` with the server's user and returns it; on 401
  it clears the stored tokens, emits `OidcSignedOut` and returns null; any
  other status throws an `OidcRequestException` without changing the state
  (a 404 means the block serves no session route), as does a 200 whose body
  has no readable `user`. It no longer builds the user from the access
  token's JWT claims, so the user id is the server's, and it no longer emits
  `OidcLoading` first. It used to report signed out for a valid cookie
  session, because a cookie session stores no tokens.
- **Breaking for exhaustive `switch` statements over `OidcException`:** add
  `OidcRequestException`, thrown when an auth route answers with a status
  the client doesn't accept. It carries the `statusCode` and, as
  `errorName`, the error name the server sent.
- Add `OidcClient.forAuth(client, providers: …, relayTo: …)`, a client for an
  `Auth` block's federated sign-in. It shares the app's `BlocksClient`: its
  base URL, HTTP client, session store and, unless one is passed, token
  store, so the session cookie the exchange sets is the one the app's calls
  send. Its routes are derived from `callbackPath` (default
  `/aws-blocks/auth/callback`) the way `Auth` derives them, and `signOutPath`
  defaults to `/aws-blocks/auth/signout`; both must be under
  `/aws-blocks/auth/`, or it throws an `ArgumentError`. It returns a plain
  `OidcClient`; wrap it as `TypedOidcClient<E>(client)` to narrow its
  providers to an enum. It stores its tokens and sign-in state under keys
  prefixed with the block's base path (such as
  `/aws-blocks/auth/access_token`), so clients for several `Auth` blocks can
  share one token store. Clients built the other ways keep the unprefixed
  keys. A `forAuth` client doesn't read tokens stored under the unprefixed
  keys (`access_token`, `refresh_token`, `expires_at`, `provider`), so an
  app that moves to `forAuth` from a client that stored bearer tokens can
  delete them. The client doesn't, because another client may still share
  the store.
- Add `OidcClient.relayTo`, the relay URI `signInRelay` uses when it isn't
  given one. `signInRelay`'s `relayTo` is now optional; with neither set, it
  throws a `StateError` before sending anything.
- Add `BlocksClient.httpClient`, the HTTP client it sends requests with.
- `OidcClient` resolves the auth routes against its base URL cut at the
  first path segment that is `aws-blocks`, keeping any API Gateway stage. It
  used to strip one trailing `/aws-blocks/api`, so a base URL that repeated
  it (`…/aws-blocks/api/aws-blocks/api`) sent auth requests under the RPC
  path.

- Add `TypedOidcClient<P extends OidcProvider>`, an extension type over an
  `OidcClient` whose `signIn`, `signInRelay` and `exchange` take a provider
  of type `P` (and send its `providerName`) instead of a name, so a typo or
  a provider the client doesn't have is a compile error. Generated clients
  return one for a method whose spec names its providers. It is the same
  object as the `OidcClient` it wraps, with no cost at runtime: every other
  member is the client's, and it can be passed wherever an `OidcClient` is
  expected, where it takes names again. `OidcClient` itself is unchanged.
- Add `OidcProvider`, the interface a provider type implements:
  `providerName` is the name the backend knows the provider by.
- `OidcClient.signIn` throws `OidcUnknownProviderException` for a provider
  its descriptor doesn't list or has no config for, as `signInRelay` does.
  It used to fail a null check.
- `OidcClient.exchange` throws `OidcUnknownProviderException` for a
  provider its descriptor doesn't list, before sending anything, as Kotlin's
  does. It used to post the name to the backend, which rejected it.
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
