# AWS Blocks Swift

A Swift Package and code generator that produces type-safe Swift client code from an AWS Blocks spec. It reads your spec at build time and emits idiomatic Swift `struct`s, `enum`s, and `async throws` API methods that call your backend with full type safety on iOS and macOS.

## Quick Start

### 1. Add the package dependency

In your `Package.swift`, pinned to the minor version, since until 1.0 a minor release can break the API:

```swift
dependencies: [
    .package(url: "https://github.com/aws/cdk-blocks-swift.git", .upToNextMinor(from: "0.2.0")),
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

The input is the shared `AuthActionInput` (`AuthActionInput.SignIn`) when the backend's spec names the input type (the `x-blocks-type-name` hint from #1599), and `AuthApi.SetAuthState.Input` against an older backend; `.signIn(.init(…))` compiles with either.

`Blocks()` uses the first server in the spec: `Servers.local` after `npm run dev`, `Servers.sandbox` after `npm run sandbox`. Switching backends is a regeneration, not an edit. To pin one server from a multi-server spec, name it: `Blocks(server: Servers.sandbox)`. A server the spec doesn't list takes its full RPC URL: `Blocks(server: BlocksServer(name: "prod", url: "https://api.example.com/prod/aws-blocks/api"))`. Pass `session:` a `URLSession` you own. A signed-in session is a cookie the runtime keeps in the Keychain, so it survives app restarts with no setup. `tokenStore:` holds OIDC bearer tokens when the backend issues them; a cookie session needs none. Each OIDC block keeps its own keys there. An `OIDCClient` sign-in asks for no bearer tokens (`tokens: false`), so its `getAccessToken()` returns `nil` afterwards: requests carry the session cookie.

Create one `Blocks` in app-scoped state, such as the Demo's `AppState`, not in a `View` initializer or a `@State` default. Each `blocks.<namespace>` is a stored, `Sendable` wrapper over the same client. `close()` makes later calls throw `ClientClosedError`, lets calls in flight finish, then releases the instance's `URLSession`; an instance that is never closed releases it once nothing references it. That session carries RPC and OIDC calls; realtime channels and file transfers use a shared one and keep working. Generated types are `nonisolated`, so they behave the same under Xcode's default `MainActor` isolation: create, call and close `Blocks` from any actor or task. A file that imports two generated modules names the one it means: `FeatureA.Blocks()`.

## Using `Auth`

The `Auth` block's `createApi()` namespace (here `authApi`) is a sign-in state machine. `getAuthState()` returns the current `state` and the `actions` the block offers in it, each with the `fields` to collect; `setAuthState(input:)` runs one and returns the next state. Render the actions generically and the same screen covers sign-in, sign-up, MFA and password reset, whatever the block has turned on.

Federated sign-in goes through an `OIDCClient`. Export the block's `createOidcApi()` beside `createApi()`, and `getClient()` returns the client, typed by the block's provider ids and carrying the block's own routes:

```ts
// aws-blocks/index.ts
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
func run(_ action: AuthAction, _ input: AuthApi.SetAuthState.Input?) async throws -> AuthState {
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

[OIDC sign-in](#oidc-sign-in) covers `relayTo`, the sheet's options, its errors, and passing a launcher of your own.

- **On launch.** Call `getAuthState()`: it works for every `Auth` block and its `user` is the signed-in user. `oidc.restore()` returns the same user and also sets the client's `authState` and emits `.signedIn` or `.signedOut` on `authStateChanges()`, but only a block with federated providers serves its session route; on any other block it throws an `ApiError` with `status` 404.
- **Unavailable actions.** An action that carries `unavailable` can't run in the current state. Show it disabled, with that text as the reason.
- **Logout URL.** `signOut()` returns the identity provider's logout URL when it has one. Open it with `UIApplication.shared.open` to end the provider's own session; otherwise the next sign-in can pick the same account without asking. Don't open it in a sign-in sheet: the logout redirects to the backend's post-sign-out page, never to `relayTo`, so the sheet stays open until the user closes it.
- **Passkeys.** Hide actions whose `capability` is set (`webauthn-get`, `webauthn-create`): they need platform WebAuthn APIs the runtime doesn't call yet.
- **New actions.** The block can add actions in a later release, so keep a `default` branch when you switch over action names.
- **One client per block.** Fetch each block's client once with `getClient()` and keep it for the app's lifetime. Its `authState`, `authStateChanges()` and its guard against a stale `restore()` belong to that client, so a second client for the same block doesn't see the first one's sign-in.
- **Several federated blocks.** Each block's `createOidcApi()` returns a client for its own routes, including a custom `redirects.callbackPath`, so a second block needs nothing extra: export its `createOidcApi()` under another name and use that client for its actions.

## Features

- **End-to-end type safety.** Every method on the spec becomes a typed `async throws` function. Discriminated unions become Swift `enum`s with associated values; `oneOf` arms become individually-named cases.
- **Native Foundation types.** `format: "uuid"` → `UUID`, `format: "date-time"` → `Date`, `format: "uri"` → `URL`. Strings with constraints become plain `String` with `precondition` validation in the memberwise init.
- **Dates cross the wire as ISO 8601 strings.** The server sends a TypeScript `Date` as `"2026-10-05T12:34:56.789Z"`. A `Date` decodes from that string (with or without fractional seconds, any UTC offset) wherever it sits: a result, a property, an array, a dictionary, an optional, a union case or a channel message. Requests send it in the same form. Generated operations decode such results with `client.makeDecoder()`; to encode a model the way a request does, use `client.makeEncoder()`. `format: "date"` (a calendar day, `"2026-10-05"`) is a `String`, like `format: "time"`: Foundation has no day-only type, and a `Date` would be sent as a date-time.
- **Open-shape records.** `T & Record<string, V>` (e.g. the `Auth` block's signUp custom attributes) renders as `let attributes: [String: V]` with a flattening custom Codable, wherever the record is declared (a named model, an operation's inline parameter or result, a union variant). Each attribute is its own JSON key beside the properties, in both directions (`{"action":"signUp","username":…,"password":…,"email":…}`); an attribute named like a property or the union's discriminator isn't sent, so the property wins. A record with its own property named `attributes` keeps it, and its extra keys are in `attributes_2`.
- **Hybrid discriminated arms.** Regrouped `oneOf` arms (e.g. Cognito's seven `confirmSignIn` challenge shapes) render as one named struct with an embedded discriminated union — both halves flatten into a single JSON envelope.
- **Schema constraints emit runtime validation.** `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `multipleOf`, `minItems`, `maxItems` all generate `precondition` checks at construct time.
- **`const` literals** are first-class single-value enums. A literal keeps its JSON type: a boolean discriminator (`{ isUpdated: true } | { isUpdated: false, … }`) encodes and decodes a JSON boolean, a numeric one a number. Outside a discriminator, a boolean or numeric literal is a `Bool`, `Double` or `Int`. A union alternative that is one literal (TypeScript's `"auto" | number` or `false | { … }`) is a case with no payload that encodes as that value and matches only it.
- **Schema-qualified names.** An enum or union declared for a component schema's property is named after the schema and the property (`AuthAction.capability` → `AuthActionCapability`, `Order.status` → `OrderStatus`), as on Dart, so it doesn't take a generic name like `Status` or `Kind` that your app declares too. The prefix is always added (`User.userType` → `UserUserType`), and an enum or union on a discriminated variant's field is named after the variant and its union (`Notification.payload`'s `email` arm's `priority` → `EmailNotificationPayloadPriority`), also as on Dart.
- **One input type for every Auth block.** A union parameter the spec names (`x-blocks-type-name`, which the backend writes for a TypeScript type alias like the `Auth` block's `AuthActionInput`) is declared once at the top level, with its variants nested inside it (`AuthActionInput.SignIn`). Every namespace whose parameter has that shape takes the same type, so one sign-in screen serves two Auth blocks: `try await blocks.authApi.setAuthState(input: input)` and `try await blocks.adminAuthApi.setAuthState(input: input)`. The names each operation declared before (`AuthApi.SetAuthState.Input`, `AuthApi.SetAuthState.SignIn`) stay as deprecated typealiases. A parameter whose name another type already has, or whose shape differs from that of the parameter whose `<namespace>.<method>` and parameter name sort first, keeps its own nested `Input`, and codegen prints a `swift:` warning that names it. So does, without a warning, one whose union has an arm that isn't a discriminated object (that arm's case is named after the union, `to_Variant2`), or whose operation declares another type of that name (`figure: { label }` beside `input: Figure`).
- **`Sendable` models.** Generated structs, enums and unions are `Sendable` when everything they store is, so a Swift 6 actor can keep or return an `AuthState`. A type that stores a `RealtimeChannel` isn't `Sendable`, and neither is a type that stores one of those.
- **Default values** from the spec become Swift initializer defaults.
- **Public initializers.** Every generated struct has a `public init` with its properties sorted by name (`SignIn(password:username:)`, `AuthUser(displayName:userId:username:)`), not in the order the backend declares them, then an open record's `attributes:` or a hybrid arm's `challenge:`; optional and nullable properties default to `nil`. Dart and Kotlin keep declaration order; Swift keeps sorted labels so code written against earlier releases still compiles. You can construct models and operation inputs from another module, a test target or a SwiftUI preview: `Note(id: "n1", title: "Hello")`.
- **Transferables anywhere.** A realtime channel, a file handle or an OIDC client can sit in any of your types, at any depth (a property, an array, a dictionary, an optional). `RealtimeChannel`, `FileDownloadHandle`, `FileUploadHandle` and `OIDCClient` are `Codable`: they decode from the server's `{ "__blocks": … }` descriptor. They are read-only, so encoding one throws `EncodingError.invalidValue`. An `OIDCClient` needs the `BlocksClient` that fetched it, so decode a type holding one with `client.makeDecoder()`; generated operations do this for you. A union alternative that is a transferable (`RealtimeChannel<Note> | { error: string }`) carries it: `case result_Variant0(RealtimeChannel<Note>)`.
- **Transferables are results only.** The server hands a transferable out and never reads one back, so codegen fails on an operation that takes one as a parameter (directly, optional, nullable, or in an array or a dictionary) with the Kotlin generator's error: `Transferable types (realtime/channel) cannot be serialized — they are read-only`. A model or union that holds one still generates, but passing such a model as a parameter throws `EncodingError.invalidValue` when the call is encoded, as it does on Kotlin and Dart.
- **Realtime subscriptions never end silently.** `channel.subscribe()` returns an `AsyncThrowingStream` that finishes normally only when you cancel the iteration or call `close()`. Any other end throws: `RealtimeError.subscriptionEnded(channel:code:message:underlyingError:)` when the server ends the subscription (`code` is the server's string: `"token_expired"` after about an hour, `"access_revoked"` or `"principal_mismatch"`, or `nil` for a refused subscribe), `RealtimeError.connectionFailed` when the socket drops or the server closes it, or a `DecodingError` for a message that doesn't decode. The SDK pings every 9 minutes so the server can report an expired token. To renew, call the API method that returned the channel again and subscribe to the new handle; the SDK doesn't repeat that call or reconnect on its own.
- **Schema-ref reuse.** A `oneOf` variant referencing a component schema reuses that named type instead of inventing a duplicate struct.
- **Unbound transferables.** A direct result with an unbound transferable tag returns `UnknownTransferable`, a carrier for the raw `tag` and `descriptor`, instead of a raw `Data?` that did not type-check. Only bare direct results are covered.
- **Declared native packages.** When `x-blocks-native-bindings` binds the tag and its package has a `swift` field, generated source imports the declared module and returns that type via `<Type>.fromBlocksDescriptor`. See [the schema generation guide](../../docs/native-clients/schema-generation-guide-for-devs.md#x-blocks-native-bindings-document-root).
- **Typed OIDC providers.** `OIDCClient` is generic over the providers it signs in with. When the spec names an OIDC client's providers, the method's namespace gets a `CaseIterable` `Provider` enum and `getClient()` returns `OIDCClient<OidcAuthApi.GetClient.Provider>`, so `let user = try await client.signIn(provider: .google, relayTo: "myapp://auth")` accepts only that client's own providers. An untyped spec returns `OIDCClient<String>`, whose `signIn` takes a `String`. When the method's own types already use the name `Provider`, the enum is `ResultProvider` and codegen prints a `swift:` warning that names it.

## OIDC sign-in

On iOS and macOS, an `OIDCClient` signs in through `ASWebAuthenticationSession`: the system's sign-in sheet on iOS, and on macOS the user's default browser when it supports this, else Safari.

```swift
let oidc = try await blocks.oidcAuthApi.getClient() // OIDCClient<OidcAuthApi.GetClient.Provider>
let user = try await oidc.signIn(provider: .google, relayTo: "myapp://auth")
```

`oidcAuthApi` is the namespace a backend exports with `auth.createOidcApi()` (see the `Auth` block's README, "Native apps"). The sheet opens the provider's sign-in page; the backend's callback receives the provider's redirect and relays it to `relayTo`, and the client exchanges the code to sign in.

- **`relayTo`** must use a custom URL scheme, `myapp` here, and the `Auth` block must allow it: `redirects: { allowedRelayOrigins: [relayOrigin('myapp://auth')] }`. The sheet catches the redirect to that scheme itself, so the scheme doesn't go in your Info.plist. A relay target with no scheme, or with `http` or `https`, throws `OIDCError.callbackError` before anything opens.
- **The window, and a private session.** By default the sheet opens over a key window of one of the app's scenes, preferring a foreground one (on macOS, the key window), and it shares the browser's cookies, so a user already signed in to the provider can skip the password; the system asks for consent first. To choose either, pass a launcher: `signIn(provider: .google, relayTo: "myapp://auth", launcher: WebAuthenticationSessionLauncher(prefersEphemeralWebBrowserSession: true, presentationAnchor: { window }))`. An app that can show more than one window, such as on iPad, should pass `presentationAnchor`, and an app extension must. A private session has no consent prompt and asks the browser to share no cookies; Safari always does, but on macOS another default browser might not.
- **Errors.** Closing the sheet throws `OIDCError.cancelled`. Cancelling the task that called `signIn` dismisses the sheet and throws `CancellationError`. A sheet the system won't show, for example while the app is in the background, throws `OIDCError.callbackError` with the system's error as `underlyingError`. One sign-in opens at a time: a second one while a sheet is open throws `OIDCError.callbackError`, and so does signing in on iOS while the app shows no window, both before anything opens.
- **Your own browser.** To drive the browser yourself, implement `BrowserLauncher` and pass it as `launcher:`. Return the first redirect to `callbackScheme`, throw `OIDCError.cancelled` when the user backs out without one, throw `CancellationError` when the task is cancelled, and throw `OIDCError.callbackError` with the original error as its cause for any other failure.
- **A Universal Link as `relayTo`.** `WebAuthenticationSessionLauncher` is safe with a custom scheme: `ASWebAuthenticationSession` hands the redirect to its own session, not to whichever app registered the scheme. A launcher of your own that opens the redirect through the system is different, because any app can register a custom scheme, so another app on the device could receive the relayed `code`. PKCE keeps that case safe too: the code is useless without the verifier, which never leaves your app, so the other app can't exchange it. A verified Universal Link (an `https` URL on a domain your app has an associated domain for) opens only your app, so for such a launcher the code doesn't reach another app at all. It needs a launcher of your own, because `WebAuthenticationSessionLauncher` accepts only a custom scheme: for example `ASWebAuthenticationSession` with an `.https(host:path:)` callback (iOS 17.4 and later). Either way, list the URL in the backend's `redirects.allowedRelayOrigins`.

## Configuration

The build plugin discovers `blocks.spec.json` automatically next to your target. To override the spec location or run codegen outside SwiftPM, use the CLI:

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

Linux / watchOS / tvOS are not currently targeted — the runtime relies on Foundation's `URLSession` and Apple's Keychain Services.

## Requirements

- Swift 6.2+ (the package declares `swift-tools-version: 6.2`)
- Xcode 26+ (for iOS / macOS app builds)

Your app can build in Swift 5 or Swift 6 language mode.

## License

Apache License 2.0. See [LICENSE](../../LICENSE) at the repo root.
