# AWS CDK Blocks Swift

A Swift Package and code generator that produces type-safe Swift client code from an AWS CDK Blocks spec. It reads your spec at build time and emits idiomatic Swift `struct`s, `enum`s, and `async throws` API methods that call your backend with full type safety on iOS and macOS.

## Quick Start

### 1. Add the package dependency

This guide targets Swift SDK 1.0.0. In your `Package.swift`:

```swift
dependencies: [
    .package(url: "https://github.com/aws/cdk-blocks-swift.git", from: "1.0.0"),
],
targets: [
    .target(
        name: "MyApp",
        dependencies: [
            .product(name: "BlocksRuntime", package: "cdk-blocks-swift"),
        ],
        plugins: [
            .plugin(name: "BlocksCodegenBuildPlugin", package: "cdk-blocks-swift"),
        ],
    ),
]
```

SwiftPM takes `package:` from the URL, so if you are moving from `aws-blocks-swift`, change the URL and every `package:` together, in every `Package.swift` that uses the SDK. An Xcode project only needs the new URL.

### 2. Drop your spec next to the target

```
Sources/MyApp/
├── blocks.spec.json   ← the build plugin discovers this automatically
└── App.swift
```

The build plugin generates `Models.swift` and `API.swift` into the target's derived sources every time you build. There's nothing to commit.

### 3. Use the generated code

```swift
import BlocksRuntime

// One instance for the app's lifetime; every namespace runs on the client it owns.
let blocks = Blocks()

// Sign in
let state = try await blocks.authApi.setAuthState(input: .signIn(.init(
    password: "P@ss1",
    username: "alice"
)))

// Open-shape sign-up with custom attributes, sent flat beside username and password
_ = try await blocks.authApi.setAuthState(input: .signUp(.init(
    password: "P@ss1",
    username: "alice",
    attributes: ["email": "alice@example.com", "custom:department": "platform"]
)))
```

When the spec names the input type (`x-blocks-type-name`), the input is the shared `AuthActionInput` (`AuthActionInput.SignIn`); without the hint it is `AuthApi.SetAuthState.Input`. `.signIn(.init(…))` compiles with both.

Create one `Blocks()` in app-scoped state. See [Configuration](#configuration) for server selection, session ownership and what `close()` releases.

## Using `Auth`

The `Auth` block's `createApi()` namespace (here `authApi`) is a sign-in state machine. `getAuthState()` returns the current `state` and the `actions` the block offers in it, each with the `fields` to collect; `setAuthState(input:)` runs one and returns the next state. Render the actions generically and the same screen covers sign-in, sign-up, MFA and password reset, whatever the block has turned on.

Federated sign-in goes through an `OIDCClient`. Export the block's `createOidcApi()` beside `createApi()`, and `getClient()` returns the client, typed by the block's provider ids and carrying the block's own routes:

```ts
// cdk-blocks/index.ts
export const authApi = auth.createApi();
export const oidcAuthApi = auth.createOidcApi();
```

Build the sign-in screen from two sources:

- **Federated sign-in buttons come from the client.** Render one button per provider in `oidc.providers`, typed with the generated `Provider` enum, and have it call `oidc.signIn(provider:relayTo:)`, which opens the system's sign-in sheet (see [OIDC sign-in](#oidc-sign-in)), then `getAuthState()`. Don't render the state's `signIn:<id>` actions as buttons: their `url` signs the system browser in, not the app.
- **Everything else comes from the state machine:** whether the user is signed in, password sign-in, sign-up, MFA steps, and which actions are `unavailable`. Run those actions through `setAuthState(input:)`.

One action carries a `url` the app still handles itself: `signOut` with a `url`, a federated user's sign-out. Call `oidc.signOut()`, then `getAuthState()`. Never submit this one through `setAuthState`: that ends the session but drops the provider's logout URL. A `signOut` without a `url` goes through `setAuthState` like any other action.

```swift
let blocks = Blocks()
let oidc = try await blocks.oidcAuthApi.getClient()
// Your app's custom URL scheme, listed in the backend's `redirects.allowedRelayOrigins`.
let relayTo = "myapp://auth"

// On launch: the state reflects the session the Keychain cookie still holds.
var state = try await blocks.authApi.getAuthState()

// The federated sign-in buttons: one per provider the client signs in with.
let providers = oidc.providers.compactMap(OidcAuthApi.GetClient.Provider.init(rawValue:))

func signIn(with provider: OidcAuthApi.GetClient.Provider) async throws -> AuthState {
    _ = try await oidc.signIn(provider: provider, relayTo: relayTo)
    return try await blocks.authApi.getAuthState()
}

// The state's other actions, rendered generically. The buttons above cover `signIn:<id>`.
let actions = state.actions.filter { !$0.name.hasPrefix("signIn:") }

/// Runs `action`; `input` is what the form collected for it.
func run(_ action: AuthAction, _ input: AuthActionInput?) async throws -> AuthState {
    if action.name == "signOut", action.url != nil {
        if let logoutURL = try await oidc.signOut() {
            await UIApplication.shared.open(logoutURL)
        }
    } else if let input {
        return try await blocks.authApi.setAuthState(input: input)
    }
    return try await blocks.authApi.getAuthState()
}
```

- **On launch.** `getAuthState()` works for every `Auth` block, and its `user` is the signed-in user. `oidc.restore()` returns the same user, sets the client's `authState` and emits `.signedIn` or `.signedOut` on `authStateChanges()`. Only a block with federated providers serves its session route; on any other block `restore()` throws an `ApiError` with `status` 404.
- **Unavailable actions.** An action that carries `unavailable` can't run in the current state. Show it disabled, with that text as the reason.
- **Logout URL.** When `oidc.signOut()` returns the identity provider's logout URL, open it with `UIApplication.shared.open` to end the provider's own session; otherwise the next sign-in can pick the same account without asking. Don't open it in a sign-in sheet: the logout redirects to the backend's post-sign-out page, never to `relayTo`, so the sheet stays open until the user closes it.
- **Passkeys.** Hide actions whose `capability` is set (`webauthn-get`, `webauthn-create`): the runtime does not run WebAuthn.
- **New actions.** The block can add actions in a later release, so keep a `default` branch when you switch over action names.
- **One client per block.** Fetch each block's client once with `getClient()` and keep it for the app's lifetime. Its `authState`, `authStateChanges()` and its guard against a stale `restore()` belong to that client, so a second client for the same block doesn't see the first one's sign-in.
- **Several federated blocks.** Each block's `createOidcApi()` returns a client for its own routes, including a custom `redirects.callbackPath`, so a second block needs nothing extra: export its `createOidcApi()` under another name and use that client for its actions.

## Generated types

### Models and initializers

- **Foundation types.** `format: "uuid"` → `UUID`, `format: "date-time"` → `Date`, `format: "uri"` → `URL`.
- **Public initializers.** Every generated struct has a `public init`, so you can construct models and operation inputs from another module, a test target or a SwiftUI preview: `Note(id: "n1", title: "Hello")`.
- **Label order.** The labels are the properties sorted by name (`SignIn(password:username:)`, `AuthUser(displayName:userId:username:)`), not in the order the backend declares them, then an open record's `attributes:` or a hybrid arm's `challenge:`.
- **Defaults.** Optional and nullable properties default to `nil`. Default values from the spec become Swift initializer defaults.
- **Validation.** `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `multipleOf`, `minItems`, `maxItems` all generate `precondition` checks at construct time. A string with constraints stays a plain `String`.
- **`Sendable` models.** Generated structs, enums and unions are `Sendable` when everything they store is, so a Swift 6 actor can keep or return an `AuthState`. A type that stores a `RealtimeChannel` isn't `Sendable`, and neither is a type that stores one of those.

### Dates

- A `Date` crosses the wire as an ISO 8601 string in both directions. The server sends a TypeScript `Date` as `"2026-10-05T12:34:56.789Z"`.
- A `Date` decodes from that string (with or without fractional seconds, any UTC offset) wherever it sits: a result, a property, an array, a dictionary, an optional, a union case or a channel message.
- Generated operations decode such results with `client.makeDecoder()`; to encode a model the way a request does, use `client.makeEncoder()`.
- `format: "date"` (a calendar day, `"2026-10-05"`) is a `String`, like `format: "time"`.

### Unions and literals

- **Unions.** A discriminated union is a Swift `enum` with associated values; each `oneOf` arm is a named case. A `oneOf` variant that references a component schema reuses that named type.
- **Hybrid discriminated arms.** Regrouped `oneOf` arms (e.g. Cognito's seven `confirmSignIn` challenge shapes) render as one named struct with an embedded discriminated union. Both halves flatten into a single JSON envelope.
- **`const` literals** are single-value enums.
  - A literal keeps its JSON type: a boolean discriminator (`{ isUpdated: true } | { isUpdated: false, … }`) encodes and decodes a JSON boolean, a numeric one a number.
  - Outside a discriminator, a boolean or numeric literal is a `Bool`, `Double` or `Int`.
  - A union alternative that is one literal (TypeScript's `"auto" | number` or `false | { … }`) is a case with no payload that encodes as that value and matches only it.

### One input type for every Auth block

- A union parameter the spec names (`x-blocks-type-name`, for example `AuthActionInput` for the `Auth` block) is declared once at the top level, with its variants nested inside it (`AuthActionInput.SignIn`).
- Every namespace whose parameter has that shape takes the same type, so one sign-in screen serves two Auth blocks: `try await blocks.authApi.setAuthState(input: input)` and `try await blocks.adminAuthApi.setAuthState(input: input)`.
- The per-operation names (`AuthApi.SetAuthState.Input`, `AuthApi.SetAuthState.SignIn`) are deprecated typealiases of the shared type.
- If several parameters request the same name, the first by `<namespace>.<method>` and then parameter name determines the shared shape. A parameter with a different shape keeps its own nested `Input`. So does one whose requested name isn't a Swift identifier or is already taken by another type. In each case codegen prints a `swift:` warning naming the parameter.
- A parameter also keeps its own nested `Input`, without a warning, when its union has an arm that isn't a discriminated object (that arm's case is named after the union, `to_Variant2`), or when its operation declares another type of that name (`figure: { label }` beside `input: Figure`).

### Open records

- `T & Record<string, V>` (e.g. the `Auth` block's signUp custom attributes) renders as `let attributes: [String: V]` beside the typed properties, wherever the record is declared (a named model, an operation's inline parameter or result, a union variant).
- Each attribute is its own JSON key beside the properties, in both directions (`{"action":"signUp","username":…,"password":…,"email":…}`).
- An attribute named like a property or the union's discriminator isn't sent: the property wins.
- A record with its own property named `attributes` keeps it, and its extra keys are in `attributes_2`.

### Names

- An enum or union declared for a component schema's property is named after the schema and the property: `AuthAction.capability` → `AuthActionCapability`, `Order.status` → `OrderStatus`, `User.userType` → `UserUserType`.
- An enum or union on a discriminated variant's field is named after the variant and its union: `Notification.payload`'s `email` arm's `priority` → `EmailNotificationPayloadPriority`.

### Transferables

- **Anywhere in a result.** A realtime channel, a file handle or an OIDC client can sit in any of your types, at any depth (a property, an array, a dictionary, an optional). `RealtimeChannel`, `FileDownloadHandle`, `FileUploadHandle` and `OIDCClient` are `Codable`: they decode from the server's `{ "__blocks": … }` descriptor.
- **`OIDCClient`.** It needs the `BlocksClient` that fetched it, so decode a type holding one with `client.makeDecoder()`; generated operations do this for you.
- **In a union.** A union alternative that is a transferable (`RealtimeChannel<Note> | { error: string }`) carries it: `case result_Variant0(RealtimeChannel<Note>)`.
- **Results only.** Codegen fails on an operation that takes a transferable as a parameter (directly, optional, nullable, or in an array or a dictionary): `Transferable types (realtime/channel) cannot be serialized — they are read-only`. A model or union that holds one still generates, but encoding it, for example as a parameter, throws `EncodingError.invalidValue`.
- **Realtime subscriptions never end silently.** `channel.subscribe()` returns an `AsyncThrowingStream` that finishes normally only when you cancel the iteration or call `close()`. Any other end throws: `RealtimeError.subscriptionEnded(channel:code:message:underlyingError:)` when the server ends the subscription (`code` is the server's string: `"token_expired"` after about an hour, `"access_revoked"` or `"principal_mismatch"`, or `nil` for a refused subscribe), `RealtimeError.connectionFailed` when the socket drops or the server closes it, or a `DecodingError` for a message that doesn't decode. The SDK pings every 9 minutes so the server can report an expired token. To renew, call the API method that returned the channel again and subscribe to the new handle; the SDK doesn't repeat that call or reconnect on its own.
- **Unbound transferables.** A direct result with an unbound transferable tag returns `UnknownTransferable`, a carrier for the raw `tag` and `descriptor`. Only bare direct results are covered.
- **Declared native packages.** When `x-blocks-native-bindings` binds the tag and its package has a `swift` field, generated source imports the declared module and returns that type via `<Type>.fromBlocksDescriptor`. See [the schema generation guide](../../docs/native-clients/schema-generation-guide-for-devs.md#x-blocks-native-bindings-document-root).

## OIDC sign-in

On iOS and macOS, an `OIDCClient` signs in through `ASWebAuthenticationSession`: the system's sign-in sheet on iOS, and on macOS the user's default browser when it supports this, else Safari.

```swift
let oidc = try await blocks.oidcAuthApi.getClient() // OIDCClient<OidcAuthApi.GetClient.Provider>
let user = try await oidc.signIn(provider: .google, relayTo: "myapp://auth")
```

The sheet opens the provider's sign-in page; the backend's callback receives the provider's redirect and relays it to `relayTo`, and the client exchanges the code to sign in.

- **Typed providers.** `OIDCClient` is generic over the providers it signs in with.
  - When the spec names an OIDC client's providers, the method's namespace gets a `CaseIterable` `Provider` enum and `getClient()` returns `OIDCClient<OidcAuthApi.GetClient.Provider>`, so `signIn` accepts only that client's own providers.
  - An untyped spec returns `OIDCClient<String>`, whose `signIn` takes a `String`.
  - When the method's own types already use the name `Provider`, the enum is `ResultProvider` and codegen prints a `swift:` warning that names it.
- **`relayTo`** must use a custom URL scheme, `myapp` here, and the `Auth` block must allow it: `redirects: { allowedRelayOrigins: [relayOrigin('myapp://auth')] }`. The sheet catches the redirect to that scheme itself, so the scheme doesn't go in your Info.plist. A relay target with no scheme, or with `http` or `https`, throws `OIDCError.callbackError` before anything opens.
- **The window, and a private session.** To choose either, pass a launcher: `signIn(provider: .google, relayTo: "myapp://auth", launcher: WebAuthenticationSessionLauncher(prefersEphemeralWebBrowserSession: true, presentationAnchor: { window }))`.

  | Option | Default | Set it when |
  |---|---|---|
  | `presentationAnchor` | A key window of one of the app's scenes, preferring a foreground one (on macOS, the key window). | The app can show more than one window, such as on iPad. An app extension must pass it. |
  | `prefersEphemeralWebBrowserSession` | `false`: the sheet shares the browser's cookies, so a user already signed in to the provider can skip the password. The system asks for consent first. | `true` gives a private session: no consent prompt, and the browser is asked to share no cookies. Safari always complies; on macOS another default browser might not. |

- **Errors.** One sign-in opens at a time. `underlyingError` is the cause, where the table names one.

  | Error | Thrown when |
  |---|---|
  | `OIDCError.unknownProvider` | The client does not list the provider. Thrown before anything is sent. |
  | `OIDCError.callbackError` | The authorize-params request fails (the cause is its `ApiError` or `TransportError`) or its response lacks a field; the identity provider reports an error, such as a user who denies consent; or the system won't show the sheet or the session fails (the cause is the system's error). Also, before anything opens: a sheet is already open, on iOS the app shows no window, or `relayTo` has no custom scheme. |
  | `OIDCError.invalidAuthorizeURL` | The backend's authorize URL is not a valid `http` or `https` URL. |
  | `OIDCError.stateMismatch` | The redirect's `state`, or the CSRF value inside it, is not the one this sign-in sent. |
  | `OIDCError.missingAuthorizationCode` | The redirect carries no `code`. |
  | `OIDCError.exchangeFailed` | The code exchange fails. The cause is the request's `ApiError` or `TransportError`. |
  | `OIDCError.malformedExchangeResponse` | The exchange response does not contain a `user` object. |
  | `TransferableError.invalidDescriptor` | The exchanged `user` object lacks a string `userId` or `username`. |
  | `ClientClosedError` | The client was closed before the authorize-params or exchange request could start. |
  | `OIDCError.cancelled` | The user closes the sheet or declines the system's sign-in prompt. |
  | `CancellationError` | The task that called `signIn` is cancelled. The sheet is dismissed. |

- **Your own browser.** To drive the browser yourself, implement `BrowserLauncher` and pass it as `launcher:`. Return the first redirect to `callbackScheme`, throw `OIDCError.cancelled` when the user backs out without one, throw `CancellationError` when the task is cancelled, and throw `OIDCError.callbackError` with the original error as its cause for any other failure.
- **A Universal Link as `relayTo`.**
  - `WebAuthenticationSessionLauncher` accepts only a custom scheme. `ASWebAuthenticationSession` hands the redirect to its own session, not to whichever app registered the scheme.
  - With a launcher of your own that opens the redirect through the system, another app that registered the scheme could receive the relayed `code`. PKCE keeps that app from exchanging it, because the verifier never leaves your app.
  - A verified Universal Link (an `https` URL on a domain your app has an associated domain for) opens only your app. It needs a launcher of your own: for example `ASWebAuthenticationSession` with an `.https(host:path:)` callback (iOS 17.4 and later).
  - Allowlist only the origin in the backend. For example, pass `https://app.example.com/auth/callback` as `relayTo`, but configure `redirects.allowedRelayOrigins` with `relayOrigin('https://app.example.com')`.

## Configuration

### `Blocks(server:session:tokenStore:)`

| Parameter | Default | Effect |
|---|---|---|
| `server` | The first server in the spec: `Servers.local` after `npm run dev`, `Servers.sandbox` after `npm run sandbox`. | The server every API calls. To pin one server from a multi-server spec, name it: `Blocks(server: Servers.sandbox)`. A server the spec doesn't list takes its full RPC URL: `Blocks(server: BlocksServer(name: "prod", url: "https://api.example.com/prod/cdk-blocks/api"))`. |
| `session` | A `URLSession` the instance creates and releases. | Pass `session:` a `URLSession` you own; it stays yours. |
| `tokenStore` | `InMemoryTokenStore()` | `tokenStore:` holds OIDC bearer tokens when the backend issues them; a cookie session needs none. Each OIDC block keeps its own keys there. |

- To switch backends, regenerate the code from the other spec; the app's code does not change.
- A signed-in session is a cookie the runtime keeps in the Keychain, so it survives app restarts with no setup.
- An `OIDCClient` sign-in asks for no bearer tokens (`tokens: false`), so its `getAccessToken()` returns `nil` afterwards: requests carry the session cookie.

### Lifetime

- Create one `Blocks` in app-scoped state, such as the Demo's `AppState`, not in a `View` initializer or a `@State` default.
- Each `blocks.<namespace>` is a stored, `Sendable` wrapper over the same client.
- `close()` makes later calls throw `ClientClosedError`, lets calls in flight finish, then releases the instance's `URLSession`. An instance that is never closed releases it once nothing references it.
- That session carries RPC and OIDC calls. Realtime channels and file transfers use sessions of their own, shared by every instance, and keep working after `Blocks.close()`.
- Generated types are `nonisolated`, so they behave the same under Xcode's default `MainActor` isolation: create, call and close `Blocks` from any actor or task.
- A file that imports two generated modules names the one it means: `FeatureA.Blocks()`.

### Code generation

To read the spec from another path, or to run codegen outside SwiftPM, use the CLI:

```bash
swift run swift-code-generator path/to/blocks.spec.json path/to/output-dir
```

This emits two files into the output directory: `Models.swift` (shared types) and `API.swift` (one class per API namespace with typed `async throws` methods, the `Blocks` entry point that holds them, and `Servers`).

A `blocks.codegen.json` beside the spec is picked up by the build plugin. In an Xcode project it must be a member of the target, like the spec; otherwise generation stops and names the file. Outside SwiftPM, pass it to the CLI as the third argument, after the output directory:

```json
{
  "optOutNativePackages": ["example-iot-native"]
}
```

Logical identities listed there keep the `UnknownTransferable` fallback instead of a declared type. An identity the spec does not declare only warns, as `AWSBLOCKS-NATIVE-006`.

## Targets

| Target | Purpose |
|---|---|
| `BlocksRuntime` | Runtime library shipped to your app: HTTP client (`BlocksClient`, shared through the generated `Blocks`), WebSocket realtime, file handles, Keychain cookies |
| `BlocksCodegen` | Build-time codegen library: parser → builder → emitter |
| `swift-code-generator` | CLI entry point that wraps `BlocksCodegen` |
| `BlocksCodegenBuildPlugin` | Generates code on every `swift build` |
| `BlocksCodegenCommandPlugin` | Manual codegen via `swift package plugin generate-code-from-blocks-spec` |

## Supported Platforms

| Platform | Min version | Cookie storage |
|---|---|---|
| iOS | 16.0 | Keychain Services |
| macOS | 13.0 | Keychain Services |

Linux, watchOS and tvOS are not supported: the runtime relies on Foundation's `URLSession` and Apple's Keychain Services.

## Requirements

- Swift 6.2+ (the package declares `swift-tools-version: 6.2`)
- Xcode 26+ (for iOS / macOS app builds)

Your app can build in Swift 5 or Swift 6 language mode.

## License

Apache License 2.0. See [LICENSE](../../LICENSE) at the repo root.
