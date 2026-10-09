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
let state = try await auth.setAuthState(input: .signIn(AuthApi.SetAuthState.SignIn(
    password: "P@ss1",
    username: "alice"
)))

// Open-shape sign-up with custom attributes, sent flat beside username and password
_ = try await auth.setAuthState(input: .signUp(AuthApi.SetAuthState.SignUp(
    password: "P@ss1",
    username: "alice",
    attributes: ["email": "alice@example.com", "custom:department": "platform"]
)))
```

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
