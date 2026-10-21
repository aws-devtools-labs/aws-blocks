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

// Open-shape Cognito sign-up with custom attributes
_ = try await blocks.authApi.setAuthState(input: .signUp(AuthApi.SetAuthState.SignUp(
    password: "P@ss1",
    username: "alice",
    attributes: ["email": "alice@example.com", "custom:department": "platform"]
)))
```

`Blocks()` uses the first server in the spec: `Servers.local` after `npm run dev`, `Servers.sandbox` after `npm run sandbox`. Switching backends is a regeneration, not an edit. To pin one server from a multi-server spec, name it: `Blocks(server: Servers.sandbox)`. A server the spec doesn't list takes its full RPC URL: `Blocks(server: BlocksServer(name: "prod", url: "https://api.example.com/prod/aws-blocks/api"))`. Pass `tokenStore:` your own `TokenStore` to keep OIDC tokens across launches (each OIDC block keeps its own keys there), or `session:` a `URLSession` you own.

Create one `Blocks` in app-scoped state, such as the Demo's `AppState`, not in a `View` initializer or a `@State` default. Each `blocks.<namespace>` is a stored, `Sendable` wrapper over the same client. `close()` makes later calls throw `ClientClosedError`, lets calls in flight finish, then releases the instance's `URLSession`; an instance that is never closed releases it once nothing references it. That session carries RPC and OIDC calls; realtime channels and file transfers use a shared one and keep working. Generated types are `nonisolated`, so they behave the same under Xcode's default `MainActor` isolation: create, call and close `Blocks` from any actor or task. A file that imports two generated modules names the one it means: `FeatureA.Blocks()`.

## Features

- **End-to-end type safety.** Every method on the spec becomes a typed `async throws` function. Discriminated unions become Swift `enum`s with associated values; `oneOf` arms become individually-named cases.
- **Native Foundation types.** `format: "uuid"` → `UUID`, `format: "date-time"` → `Date`, `format: "uri"` → `URL`. Strings with constraints become plain `String` with `precondition` validation in the memberwise init.
- **Open-shape records.** `T & Record<string, V>` (e.g. Cognito's signUp custom attributes) renders as `let attributes: [String: V]` with a flattening custom Codable.
- **Hybrid discriminated arms.** Regrouped `oneOf` arms (e.g. Cognito's seven `confirmSignIn` challenge shapes) render as one named struct with an embedded discriminated union — both halves flatten into a single JSON envelope.
- **Schema constraints emit runtime validation.** `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `multipleOf`, `minItems`, `maxItems` all generate `precondition` checks at construct time.
- **`const` literals** are first-class single-value enums.
- **Default values** from the spec become Swift initializer defaults.
- **Schema-ref reuse.** A `oneOf` variant referencing a component schema reuses that named type instead of inventing a duplicate struct.
- **Unbound transferables.** A direct result with an unbound transferable tag returns `UnknownTransferable`, a carrier for the raw `tag` and `descriptor`, instead of a raw `Data?` that did not type-check. Only bare direct results are covered.
- **Declared native packages.** When `x-blocks-native-bindings` binds the tag and its package has a `swift` field, generated source imports the declared module and returns that type via `<Type>.fromBlocksDescriptor`. See [the schema generation guide](../../docs/native-clients/schema-generation-guide-for-devs.md#x-blocks-native-bindings-document-root).

## Configuration

The build plugin discovers `blocks.spec.json` automatically next to your target. To override the spec location or run codegen outside SwiftPM, use the CLI:

```bash
swift run swift-code-generator path/to/blocks.spec.json path/to/output-dir
```

This emits two files into the output directory: `Models.swift` (shared types) and `API.swift` (one class per API namespace with typed `async throws` methods, the `Blocks` entry point that holds them, and `Servers`).

A `blocks.codegen.json` beside the spec is picked up by the build plugin, or passed to the CLI as a third argument. In an Xcode project it must be a member of the target, like the spec; otherwise generation stops and names the file:

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
