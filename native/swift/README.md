# AWS Blocks Swift

A Swift Package and code generator that produces type-safe Swift client code from an AWS Blocks spec. It reads your spec at build time and emits idiomatic Swift `struct`s, `enum`s, and `async throws` API methods that call your backend with full type safety on iOS and macOS.

## Quick Start

### 1. Add the package dependency

In your `Package.swift`, pinned to the minor version, since until 1.0 a minor release can break the API:

```swift
dependencies: [
    .package(url: "https://github.com/aws-devtools-labs/aws-blocks-swift.git", .upToNextMinor(from: "0.2.0")),
],
targets: [
    .target(
        name: "MyApp",
        dependencies: [
            .product(name: "BlocksRuntime", package: "aws-blocks-swift"),
        ],
        plugins: [
            .plugin(name: "BlocksCodegenBuildPlugin", package: "aws-blocks-swift"),
        ],
    ),
]
```

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
let state = try await blocks.authApi.setAuthState(input: .signIn(AuthApi.SetAuthState.SignIn(
    password: "P@ss1",
    username: "alice"
)))

// Open-shape sign-up with custom attributes, sent flat beside username and password
_ = try await blocks.authApi.setAuthState(input: .signUp(AuthApi.SetAuthState.SignUp(
    password: "P@ss1",
    username: "alice",
    attributes: ["email": "alice@example.com", "custom:department": "platform"]
)))
```

`Blocks()` uses the first server in the spec: `Servers.local` after `npm run dev`, `Servers.sandbox` after `npm run sandbox`. Switching backends is a regeneration, not an edit. To pin one server from a multi-server spec, name it: `Blocks(server: Servers.sandbox)`. A server the spec doesn't list takes its full RPC URL: `Blocks(server: BlocksServer(name: "prod", url: "https://api.example.com/prod/aws-blocks/api"))`. Pass `session:` a `URLSession` you own. A signed-in session is a cookie the runtime keeps in the Keychain, so it survives app restarts with no setup. `tokenStore:` holds OIDC bearer tokens when the backend issues them; a cookie session needs none. Each OIDC block keeps its own keys there.

Create one `Blocks` in app-scoped state, such as the Demo's `AppState`, not in a `View` initializer or a `@State` default. Each `blocks.<namespace>` is a stored, `Sendable` wrapper over the same client. `close()` makes later calls throw `ClientClosedError`, lets calls in flight finish, then releases the instance's `URLSession`; an instance that is never closed releases it once nothing references it. That session carries RPC and OIDC calls; realtime channels and file transfers use a shared one and keep working. Generated types are `nonisolated`, so they behave the same under Xcode's default `MainActor` isolation: create, call and close `Blocks` from any actor or task. A file that imports two generated modules names the one it means: `FeatureA.Blocks()`.

## Using `Auth`

The `Auth` block's `createApi()` namespace (here `authApi`) is a sign-in state machine. `getAuthState()` returns the current `state` and the `actions` the block offers in it, each with the `fields` to collect; `setAuthState(input:)` runs one and returns the next state. Render the actions generically and the same screen covers sign-in, sign-up, MFA and password reset, whatever the block has turned on.

Two kinds of action carry a `url`, which a native app doesn't open (it would sign in the system browser, not the app). Run them through an `OIDCClient` for the block instead:

- `signIn:<id>`, a federated provider: `OIDCClient.providerIdOf(action.name)` gives the id. Call `oidc.signIn(provider:launcher:)`, then `getAuthState()`.
- `signOut` with a `url`, a federated user's sign-out: call `oidc.signOut()`, then `getAuthState()`. A `signOut` without a `url` goes through `setAuthState` like any other action.

```swift
let blocks = Blocks()
// The block's provider ids. `relayTo` is your app's Universal Link or custom scheme, listed in the
// backend's `redirects.allowedRelayOrigins`.
let oidc = OIDCClient.forAuth(client: blocks.client, providers: ["google"], relayTo: "myapp://auth")

// On launch: reads the session the Keychain cookie still holds (nil when signed out).
_ = try await oidc.restore()
var state = try await blocks.authApi.getAuthState()

/// Runs `action`; `input` is what the form collected for a plain (non-federated) action.
func run(_ action: AuthAction, _ input: AuthApi.SetAuthState.Input?) async throws -> AuthState {
    if let provider = OIDCClient.providerIdOf(action.name) {
        _ = try await oidc.signIn(provider: provider, launcher: launcher)
    } else if action.name == "signOut", action.url != nil {
        if let logoutURL = try await oidc.signOut() {
            await UIApplication.shared.open(logoutURL)
        }
    } else if let input {
        return try await blocks.authApi.setAuthState(input: input)
    }
    return try await blocks.authApi.getAuthState()
}
```

`launcher` is a `BrowserLauncher`, usually one that wraps `ASWebAuthenticationSession` with `relayTo`'s scheme as the callback scheme.

Prefer a verified Universal Link (an `https` URL on a domain your app has an associated domain for) as `relayTo` over a bare custom scheme such as `myapp://auth`. Any app can register a custom scheme, so another app on the device could receive the relayed `code`. PKCE is what keeps that case safe: the code is useless without the verifier, which never leaves your app, so the other app can't exchange it. A Universal Link opens only your app, so the code doesn't reach another app at all. Its launcher must accept an `https` callback, for example `ASWebAuthenticationSession` with an `.https(host:path:)` callback (iOS 17.4 and later). Either way, list the URL in the backend's `redirects.allowedRelayOrigins`.

- **Restore on launch.** `restore()` reads the server's session and emits `.signedIn` or `.signedOut` on `authStateChanges()`. It returns `nil` when there is no session, and throws when the backend serves no session route (a block without federated providers) or the request fails.
- **Logout URL.** `signOut()` returns the identity provider's logout URL when it has one. Open it to end the provider's own session; otherwise the next sign-in can pick the same account without asking.
- **Passkeys.** Hide actions whose `capability` is set (`webauthn-get`, `webauthn-create`): they need platform WebAuthn APIs the runtime doesn't call yet.
- **New actions.** The block can add actions in a later release, so keep a `default` branch when you switch over action names.
- **Custom routes.** A block that sets `redirects.callbackPath` or `redirects.signOutPath` (for example a second federated block) needs the same paths here: `OIDCClient.forAuth(client:providers:relayTo:callbackPath:signOutPath:)`.

## Features

- **End-to-end type safety.** Every method on the spec becomes a typed `async throws` function. Discriminated unions become Swift `enum`s with associated values; `oneOf` arms become individually-named cases.
- **Native Foundation types.** `format: "uuid"` → `UUID`, `format: "date-time"` → `Date`, `format: "uri"` → `URL`. Strings with constraints become plain `String` with `precondition` validation in the memberwise init.
- **Dates cross the wire as ISO 8601 strings.** The server sends a TypeScript `Date` as `"2026-10-05T12:34:56.789Z"`. A `Date` decodes from that string (with or without fractional seconds, any UTC offset) wherever it sits: a result, a property, an array, a dictionary, an optional, a union case or a channel message. Requests send it in the same form. Generated operations decode such results with `client.makeDecoder()`; to encode a model the way a request does, use `client.makeEncoder()`. `format: "date"` (a calendar day, `"2026-10-05"`) is a `String`, like `format: "time"`: Foundation has no day-only type, and a `Date` would be sent as a date-time.
- **Open-shape records.** `T & Record<string, V>` (e.g. the `Auth` block's signUp custom attributes) renders as `let attributes: [String: V]` with a flattening custom Codable, wherever the record is declared (a named model, an operation's inline parameter or result, a union variant). Each attribute is its own JSON key beside the properties, in both directions (`{"action":"signUp","username":…,"password":…,"email":…}`); an attribute named like a property or the union's discriminator isn't sent, so the property wins. A record with its own property named `attributes` keeps it, and its extra keys are in `attributes_2`.
- **Hybrid discriminated arms.** Regrouped `oneOf` arms (e.g. Cognito's seven `confirmSignIn` challenge shapes) render as one named struct with an embedded discriminated union — both halves flatten into a single JSON envelope.
- **Schema constraints emit runtime validation.** `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `multipleOf`, `minItems`, `maxItems` all generate `precondition` checks at construct time.
- **`const` literals** are first-class single-value enums. A literal keeps its JSON type: a boolean discriminator (`{ isUpdated: true } | { isUpdated: false, … }`) encodes and decodes a JSON boolean, a numeric one a number. Outside a discriminator, a boolean or numeric literal is a `Bool`, `Double` or `Int`. A union alternative that is one literal (TypeScript's `"auto" | number` or `false | { … }`) is a case with no payload that encodes as that value and matches only it.
- **Default values** from the spec become Swift initializer defaults.
- **Public initializers.** Every generated struct has a `public init` with its properties in declaration order; optional and nullable properties default to `nil`. You can construct models and operation inputs from another module, a test target or a SwiftUI preview: `Note(id: "n1", title: "Hello")`.
- **Transferables anywhere.** A realtime channel, a file handle or an OIDC client can sit in any of your types, at any depth (a property, an array, a dictionary, an optional). `RealtimeChannel`, `FileDownloadHandle`, `FileUploadHandle` and `OIDCClient` are `Codable`: they decode from the server's `{ "__blocks": … }` descriptor and encode back to it. An `OIDCClient` needs the `BlocksClient` that fetched it, so decode a type holding one with `client.makeDecoder()`; generated operations do this for you. A union alternative that is a transferable (`RealtimeChannel<Note> | { error: string }`) carries it: `case result_Variant0(RealtimeChannel<Note>)`.
- **Schema-ref reuse.** A `oneOf` variant referencing a component schema reuses that named type instead of inventing a duplicate struct.
- **Unbound transferables.** A direct result with an unbound transferable tag returns `UnknownTransferable`, a carrier for the raw `tag` and `descriptor`, instead of a raw `Data?` that did not type-check. Only bare direct results are covered.
- **Declared native packages.** When `x-blocks-native-bindings` binds the tag and its package has a `swift` field, generated source imports the declared module and returns that type via `<Type>.fromBlocksDescriptor`. See [the schema generation guide](../../docs/native-clients/schema-generation-guide-for-devs.md#x-blocks-native-bindings-document-root).
- **Typed OIDC providers.** For a custom block whose method returns an `oidc/client` (the `Auth` block returns none; see [Using `Auth`](#using-auth)): `OIDCClient` is generic over the providers it signs in with. When the spec names an OIDC client's providers, the method's namespace gets a `CaseIterable` `Provider` enum and `getClient()` returns `OIDCClient<OidcAuthApi.GetClient.Provider>`, so `let user = try await client.signIn(provider: .google, relayTo: "myapp://auth", launcher: launcher)` accepts only that client's own providers. An untyped spec returns `OIDCClient<String>`, whose `signIn` takes a `String`. When the method's own types already use the name `Provider`, the enum is `ResultProvider` and codegen prints a `swift:` warning that names it.

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
