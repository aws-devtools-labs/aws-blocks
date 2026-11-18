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

`Blocks()` uses the first server in the spec: `Servers.local` after `npm run dev`, `Servers.sandbox` after `npm run sandbox`. Switching backends is a regeneration, not an edit. To pin one server from a multi-server spec, name it: `Blocks(server: Servers.sandbox)`. A server the spec doesn't list takes its full RPC URL: `Blocks(server: BlocksServer(name: "prod", url: "https://api.example.com/prod/aws-blocks/api"))`. Pass `tokenStore:` your own `TokenStore` to keep OIDC tokens across launches (each OIDC block keeps its own keys there), or `session:` a `URLSession` you own.

Create one `Blocks` in app-scoped state, such as the Demo's `AppState`, not in a `View` initializer or a `@State` default. Each `blocks.<namespace>` is a stored, `Sendable` wrapper over the same client. `close()` makes later calls throw `ClientClosedError`, lets calls in flight finish, then releases the instance's `URLSession`; an instance that is never closed releases it once nothing references it. That session carries RPC and OIDC calls; realtime channels and file transfers use a shared one and keep working. Generated types are `nonisolated`, so they behave the same under Xcode's default `MainActor` isolation: create, call and close `Blocks` from any actor or task. A file that imports two generated modules names the one it means: `FeatureA.Blocks()`.

## Features

- **End-to-end type safety.** Every method on the spec becomes a typed `async throws` function. Discriminated unions become Swift `enum`s with associated values; `oneOf` arms become individually-named cases.
- **Native Foundation types.** `format: "uuid"` → `UUID`, `format: "date-time"` → `Date`, `format: "uri"` → `URL`. Strings with constraints become plain `String` with `precondition` validation in the memberwise init.
- **Dates cross the wire as ISO 8601 strings.** The server sends a TypeScript `Date` as `"2026-10-05T12:34:56.789Z"`. A `Date` decodes from that string (with or without fractional seconds, any UTC offset) wherever it sits: a result, a property, an array, a dictionary, an optional, a union case or a channel message. Requests send it in the same form. Generated operations decode such results with `client.makeDecoder()`; to encode a model the way a request does, use `client.makeEncoder()`. `format: "date"` (a calendar day, `"2026-10-05"`) is a `String`, like `format: "time"`: Foundation has no day-only type, and a `Date` would be sent as a date-time.
- **Open-shape records.** `T & Record<string, V>` (e.g. the `Auth` block's signUp custom attributes) renders as `let attributes: [String: V]` with a flattening custom Codable, wherever the record is declared (a named model, an operation's inline parameter or result, a union variant). Each attribute is its own JSON key beside the properties, in both directions (`{"action":"signUp","username":…,"password":…,"email":…}`); an attribute named like a property or the union's discriminator isn't sent, so the property wins. A record with its own property named `attributes` keeps it, and its extra keys are in `attributes_2`.
- **Hybrid discriminated arms.** Regrouped `oneOf` arms (e.g. Cognito's seven `confirmSignIn` challenge shapes) render as one named struct with an embedded discriminated union — both halves flatten into a single JSON envelope.
- **Schema constraints emit runtime validation.** `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `multipleOf`, `minItems`, `maxItems` all generate `precondition` checks at construct time.
- **`const` literals** are first-class single-value enums. A literal keeps its JSON type: a boolean discriminator (`{ isUpdated: true } | { isUpdated: false, … }`) encodes and decodes a JSON boolean, a numeric one a number. Outside a discriminator, a boolean or numeric literal is a `Bool`, `Double` or `Int`. A union alternative that is one literal (TypeScript's `"auto" | number` or `false | { … }`) is a case with no payload that encodes as that value and matches only it.
- **Schema-qualified names.** An enum or union declared for a component schema's property is named after the schema and the property (`AuthAction.capability` → `AuthActionCapability`, `Order.status` → `OrderStatus`), as on Dart, so it doesn't take a generic name like `Status` or `Kind` that your app declares too. The prefix is always added (`User.userType` → `UserUserType`), and an enum or union on a discriminated variant's field is named after the variant and its union (`Notification.payload`'s `email` arm's `priority` → `EmailNotificationPayloadPriority`), also as on Dart.
- **One input type for every Auth block.** A union parameter the spec names (`x-blocks-type-name`, which the backend writes for a TypeScript type alias like the `Auth` block's `AuthActionInput`) is declared once at the top level, with its variants nested inside it (`AuthActionInput.SignIn`). Every namespace whose parameter has that shape takes the same type, so one sign-in screen serves two Auth blocks: `try await blocks.authApi.setAuthState(input: input)` and `try await blocks.adminAuthApi.setAuthState(input: input)`. The names each operation declared before (`AuthApi.SetAuthState.Input`, `AuthApi.SetAuthState.SignIn`) stay as deprecated typealiases. A parameter whose name another type already has or whose shape differs from the first one's keeps its own nested `Input`, and codegen prints a `swift:` warning that names it. So does, without a warning, one whose union has an arm that isn't a discriminated object (that arm's case is named after the union, `to_Variant2`), or whose operation declares another type of that name (`figure: { label }` beside `input: Figure`).
- **`Sendable` models.** Generated structs, enums and unions are `Sendable` when everything they store is, so a Swift 6 actor can keep or return an `AuthState`. A type that stores a `RealtimeChannel` isn't `Sendable`, and neither is a type that stores one of those.
- **Default values** from the spec become Swift initializer defaults.
- **Public initializers.** Every generated struct has a `public init` with its properties sorted by name (`SignIn(password:username:)`, `AuthUser(displayName:userId:username:)`), not in the order the backend declares them, then an open record's `attributes:` or a hybrid arm's `challenge:`; optional and nullable properties default to `nil`. Dart and Kotlin keep declaration order; Swift keeps sorted labels so code written against earlier releases still compiles. You can construct models and operation inputs from another module, a test target or a SwiftUI preview: `Note(id: "n1", title: "Hello")`.
- **Transferables anywhere.** A realtime channel, a file handle or an OIDC client can sit in any of your types, at any depth (a property, an array, a dictionary, an optional). `RealtimeChannel`, `FileDownloadHandle`, `FileUploadHandle` and `OIDCClient` are `Codable`: they decode from the server's `{ "__blocks": … }` descriptor and encode back to it. An `OIDCClient` needs the `BlocksClient` that fetched it, so decode a type holding one with `client.makeDecoder()`; generated operations do this for you. A union alternative that is a transferable (`RealtimeChannel<Note> | { error: string }`) carries it: `case result_Variant0(RealtimeChannel<Note>)`.
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
