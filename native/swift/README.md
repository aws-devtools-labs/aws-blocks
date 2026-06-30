# AWS Blocks Swift

A Swift Package and code generator that produces type-safe Swift client code from an AWS Blocks spec. It reads your spec at build time and emits idiomatic Swift `struct`s, `enum`s, and `async throws` API methods that call your backend with full type safety on iOS and macOS.

## Quick Start

### 1. Add the package dependency

In your `Package.swift`:

```swift
dependencies: [
    .package(url: "https://github.com/aws-devtools-labs/aws-blocks-swift.git", from: "0.1.0"),
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

// Each API namespace becomes its own class with a built-in BlocksClient.
// Pass a custom server or use the default from the spec.
let auth = AuthApi(server: BlocksServer(name: "prod", url: "https://api.example.com"))

// Sign in
let state = try await auth.setAuthState(input: .signIn(SetAuthState.SignIn(
    username: "alice",
    password: "P@ss1"
)))

// Open-shape Cognito sign-up with custom attributes
_ = try await auth.setAuthState(input: .signUp(SetAuthState.SignUp(
    username: "alice",
    password: "P@ss1",
    attributes: ["email": "alice@example.com", "custom:department": "platform"]
)))
```

## Features

- **End-to-end type safety.** Every method on the spec becomes a typed `async throws` function. Discriminated unions become Swift `enum`s with associated values; `oneOf` arms become individually-named cases.
- **Native Foundation types.** `format: "uuid"` → `UUID`, `format: "date-time"` → `Date`, `format: "uri"` → `URL`. Strings with constraints become plain `String` with `precondition` validation in the memberwise init.
- **Open-shape records.** `T & Record<string, V>` (e.g. Cognito's signUp custom attributes) renders as `let attributes: [String: V]` with a flattening custom Codable.
- **Hybrid discriminated arms.** Regrouped `oneOf` arms (e.g. Cognito's seven `confirmSignIn` challenge shapes) render as one named struct with an embedded discriminated union — both halves flatten into a single JSON envelope.
- **Schema constraints emit runtime validation.** `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `multipleOf`, `minItems`, `maxItems` all generate `precondition` checks at construct time.
- **`const` literals** are first-class single-value enums.
- **Default values** from the spec become Swift initializer defaults.
- **Schema-ref reuse.** A `oneOf` variant referencing a component schema reuses that named type instead of inventing a duplicate struct.

## Configuration

The build plugin discovers `blocks.spec.json` automatically next to your target. To override the spec location or run codegen outside SwiftPM, use the CLI:

```bash
swift run swift-code-generator path/to/blocks.spec.json path/to/output-dir
```

This emits two files into the output directory: `Models.swift` (shared types) and `API.swift` (one class per API namespace with typed `async throws` methods).

## Targets

| Target | Purpose |
|---|---|
| `BlocksRuntime` | Runtime library shipped to your app: HTTP client, WebSocket realtime, file handles, Keychain cookies |
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

- Swift 5.9+
- Xcode 15+ (for iOS / macOS app builds)

## License

Apache License 2.0. See [LICENSE](../../LICENSE) at the repo root.
