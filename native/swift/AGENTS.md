# AWS Blocks Swift – Agent Guide

Context for AI coding agents working in this directory.

## Project Overview

A Swift Package that generates type-safe Swift client code from an OpenRPC specification, plus a runtime library that executes the generated code against an AWS Blocks backend. Three targets:

- **BlocksCodegen** — pure Swift: parser → model builder → Swift code generator. Ships as a SwiftPM target, invoked via the `swift-code-generator` executable or the `BlocksCodegenCommandPlugin` build plugin.
- **BlocksRuntime** — iOS + macOS: HTTP client (one per generated `Blocks`), WebSocket-backed realtime channels, file upload/download handles, Keychain cookie store.
- **swift-code-generator** — CLI executable that wraps `BlocksCodegen` for one-shot generation outside SwiftPM.

## Key File Paths

### Codegen target

| Purpose | Path |
|---------|------|
| OpenRPC spec parser | `Sources/BlocksCodegen/OpenRPCParser.swift` |
| Spec-level types (decode-time IR) | `Sources/BlocksCodegen/SpecTypes.swift` |
| Parser-output IR (`TypeRef`) | `Sources/BlocksCodegen/RPCModel.swift` |
| Resolved IR (`ResolvedType`, `Constraints`, `FormatKind`) | `Sources/BlocksCodegen/CodegenModel.swift` |
| Builder (TypeRef → ResolvedType) | `Sources/BlocksCodegen/CodegenModelBuilder.swift` |
| Swift code generator | `Sources/BlocksCodegen/SwiftCodeGenerator.swift` |
| Generated `Blocks` entry point, namespace class headers, `Servers` | `Sources/BlocksCodegen/SwiftCodeGenerator+EntryPoint.swift` |
| Naming + identifier helpers | `Sources/BlocksCodegen/Helpers.swift` |
| Generator CLI entry | `Sources/swift-code-generator/runGenerator.swift` |

### Runtime target

| Purpose | Path |
|---------|------|
| HTTP client | `Sources/BlocksRuntime/BlocksClient.swift` |
| Session lifecycle: `close()`, in-flight request gate | `Sources/BlocksRuntime/SessionGate.swift` |
| Request envelope | `Sources/BlocksRuntime/BlocksRequest.swift` |
| Untyped JSON value | `Sources/BlocksRuntime/JSONValue.swift` |
| Keychain-backed cookies | `Sources/BlocksRuntime/KeychainCookieStore.swift` |
| Cookie parsing, attribute matching, expiry and stored record | `Sources/BlocksRuntime/StoredCookie.swift` |
| Cookie jar: store `Set-Cookie`, build `Cookie` header over a `CookieItemStore` | `Sources/BlocksRuntime/CookieJar.swift` |
| Realtime WebSocket channel | `Sources/BlocksRuntime/Realtime/RealtimeChannel.swift` |
| Realtime connection pool | `Sources/BlocksRuntime/Realtime/WebSocketSession.swift` |
| File download handle | `Sources/BlocksRuntime/FileBucket/FileDownloadHandle.swift` |
| File upload handle | `Sources/BlocksRuntime/FileBucket/FileUploadHandle.swift` |
| Transferables nested in a result: descriptor decoding, read-only encoding | `Sources/BlocksRuntime/TransferableCoding.swift` |
| Error types | `Sources/BlocksRuntime/BlocksError.swift`, `Realtime/RealtimeError.swift`, `FileBucket/FileBucketError.swift` |

### Plugins

| Purpose | Path |
|---------|------|
| Build-time codegen plugin | `Plugins/BlocksCodegenBuildPlugin/Plugin.swift` |
| Command-line codegen plugin | `Plugins/BlocksCodegenCommandPlugin/Plugin.swift` |

### Tests

| Purpose | Path |
|---------|------|
| Parser tests | `Tests/BlocksCodegenTests/OpenRPCParserTests.swift` |
| Builder + resolver tests | `Tests/BlocksCodegenTests/CodegenModelBuilderTests.swift` |
| Hybrid-arm regrouped union tests | `Tests/BlocksCodegenTests/HybridArmTests.swift` |
| Constraints / formats / defaults / const / tuple | `Tests/BlocksCodegenTests/ConstraintsAndDefaultsTests.swift` |
| Helpers / naming | `Tests/BlocksCodegenTests/HelpersTests.swift` |
| Generator output | `Tests/BlocksCodegenTests/SwiftCodeGeneratorTests.swift` |
| Entry-point naming and emission | `Tests/BlocksCodegenTests/BlocksEntryPointGeneratorTests.swift` |
| Declared native binding resolution | `Tests/BlocksCodegenTests/DeclaredBindingParserTests.swift` |
| Declared transferable emission | `Tests/BlocksCodegenTests/DeclaredTransferableBindingTests.swift` |
| Golden files for the 29 shared fixtures | `Tests/BlocksCodegenTests/GoldenFileTests.swift` |
| Hybrid-arm fixture spec | `../codegen-fixtures/18-hybrid-arm/spec.json` |
| Runtime tests | `Tests/BlocksRuntimeTests/*` |
| Build-plugin output compiled in Swift 6 language mode with `.treatAllWarnings(as: .error)`; any new compiler warning in generated code, such as one a runner Xcode update brings, fails CI | `Tests/BlocksGeneratedCodeTests/` (its `blocks.spec.json` is un-ignored in `.gitignore`) |
| The same spec's output under Xcode 26 app defaults: `.defaultIsolation(MainActor.self)` plus approachable concurrency | `Tests/BlocksGeneratedMainActorTests/` (its `blocks.spec.json` copy is un-ignored too) |

## Build and Test Commands

```bash
# All commands run from native/swift/

# Build everything (codegen, runtime, plugins, CLI)
swift build

# Run all tests
swift test

# Filter to one suite
swift test --filter HybridArmTests
swift test --filter ConstraintsAndDefaultsTests
swift test --filter BlocksGeneratedCodeTests

# Generate code from a spec into a target directory
swift run swift-code-generator path/to/blocks.spec.json path/to/output-dir
```

End-to-end wire-shape harness lives in a sibling repo (`cognito-cli-test`) and is the canonical way to verify the generated Codable round-trips a real Cognito sandbox payload. 

## Module Dependency Rules

These constraints must be maintained:

| Rule | Reason |
|------|--------|
| `BlocksCodegen` must NOT import iOS / UIKit / SwiftUI APIs | It's a build-time tool; runs on Linux CI / macOS terminals where iOS frameworks are unavailable |
| `BlocksCodegen` must NOT depend on `BlocksRuntime` | They ship independently; codegen runs at build time only |
| `BlocksRuntime` must NOT depend on `BlocksCodegen` or any plugin target | It's a runtime-only library shipped to iOS / macOS apps |
| Generated code depends on `BlocksRuntime` only | Generated `API.swift` imports Foundation and `BlocksRuntime`, `Models.swift` only Foundation; nothing else |
| Plugins depend on `swift-code-generator` only | Plugins invoke the CLI; must not depend on the runtime |

If you find yourself wanting to break one of these rules, reconsider the approach.

## Codegen Invariants

These rules are load-bearing — the generated wire format depends on them. Breaking them silently regresses end-to-end Cognito sign-up / confirm-sign-in flows.

| Invariant | Where it lives | Don't break |
|---|---|---|
| **Hybrid arm flat envelope** — when a `oneOf` arm has both outer `properties` AND a nested `oneOf`, the outer fields and the inner discriminator + payload share one JSON object. | `SwiftCodeGenerator.swift::emitRecordStruct` (the `embeddedUnion` branch). | The merged Codable forwards `try self.challenge.encode(to: encoder)` against the SAME `Encoder`. Any code path that nests the embedded union inside its own keyed container breaks the wire shape. |
| **Open-shape `T & Record<string, V>`** — records that carry `additionalPropertiesType` flatten an `attributes: [String: V]` map at the JSON top level. | `SwiftCodeGenerator.swift::emitRecordStruct` (the `isOpen` branch). | Custom `DynamicKey`-keyed Codable. Auto-derived Codable would nest the map under an `attributes` key — the server rejects that shape. |
| **Embedded union naming** — inner unions get a parent-prefixed name (e.g. `ConfirmSignInChallenge`), not just the field name. | `CodegenModelBuilder.swift` (variant resolution). | Two regrouped arms whose inner discriminator field is both called `challenge` would collide if the prefix were dropped. |
| **Inline union arms are NOT registered as top-level types** — they live as `UnionVariant` records inside their parent union. | `CodegenModelBuilder.swift::resolveType` (`asUnionVariant: true`). | Registering them produces `Input_Variant<N>` ghost structs that mirror the named per-action variants. |
| **One generated `Blocks` per spec** — `public final class Blocks` stores one property per namespace; it is not an extension on a runtime type (Kotlin #704's shape). | `SwiftCodeGenerator+EntryPoint.swift`; `blocksMemberNames` and `reservedNamespaceClassNames` in `Helpers.swift`. | Extension members on a shared runtime type are visible module-wide, so two generated modules make `Blocks()` ambiguous or silently pick one by file order; a generated type is qualified as `FeatureA.Blocks()` on every toolchain. Qualify every runtime type the class names (`BlocksRuntime.TokenStore`), add any type it names unqualified to `reservedNamespaceClassNames`, and add any new `Blocks` member to `blocksMemberNames`. |
| **No structural deduplication** — two methods returning the same anonymous shape produce two distinct types named after the methods. | `CodegenModelBuilder.swift` (no `structuralKey` registry). | The TS compiler can synthesize identical mapped-type objects from unrelated source types; deduping would cause `setCookie() -> DeleteTodoResponse`-style naming. Deduping would cause incoherent naming. |

## Swift Concurrency

Generated code is Swift Concurrency-ready: `func setAuthState(input: Input) async throws -> AuthState` is the standard signature. `BlocksClient`, `BlocksServer`, the generated `Blocks` and the generated namespace classes are checked `Sendable`, and none is `@MainActor`. Generated code compiles in the app's target, so it would inherit that target's default isolation; every top-level generated type is emitted `nonisolated` (Swift 6.1+), so generated code behaves the same with or without Xcode's `MainActor` default isolation. The package is `swift-tools-version: 6.2` (Xcode 26); its own targets build in Swift 5 language mode (`swiftLanguageModes: [.v5]`) until the runtime is migrated, and the two generated-code test targets build in Swift 6 mode.

Generated model `struct`s and `enum`s are public, so they are not implicitly `Sendable`; returning them across actors fails in Swift 6 language mode. Don't add reference types to the IR or to runtime-shipped data classes.

`WebSocketSession` guards the process-wide connection pool with an `NSLock`. `SessionGate` guards each client's `URLSession` with an `OSAllocatedUnfairLock`, and every request goes through `SessionGate.send(_:)`: a task created on an invalidated `URLSession` terminates the process. `BlocksClient.baseHost` is computed over an `OSAllocatedUnfairLock`, not a stored `static var`: apps set it, and a Swift 6 app target rejects references to mutable stored statics. `BlocksClient` keeps the one move of tokens saved under the unscoped OIDC keys in an `OSAllocatedUnfairLock`, so every `OIDCClient` on it waits for that move: `TokenStore` has no compare-and-set, so a marker in the store can't replace it. Generated code never forms a realtime message decoder: it decodes `RealtimeChannel<M>` through `Decodable`, because a closure formed in an app target with `MainActor` default isolation traps when the socket task calls it in Swift 6 mode.

## Common Workflows

### After changing the parser (`OpenRPCParser.swift` / `SpecTypes.swift`)

1. `swift test --filter OpenRPCParserTests` — verify decode-time invariants.
2. `swift test` — run the full suite to catch downstream IR regressions.

### After changing the builder (`CodegenModelBuilder.swift`)

1. `swift test --filter CodegenModelBuilderTests`
2. `swift test --filter HybridArmTests` — the hybrid-arm fixture spec exercises every IR feature.
3. Regenerate against a real Cognito spec and inspect the diff: `swift run swift-code-generator <spec> /tmp/out && diff -u <baseline> /tmp/out/Models.swift`.
4. Run the wire-shape harness in `cognito-cli-test` (`swift run CognitoCliTest --shape-test`) — this is the only end-to-end check that catches wire-shape regressions.

### After changing the generator (`SwiftCodeGenerator.swift`)

1. `swift test` — runs `SwiftCodeGeneratorTests` (snapshot-style), `HybridArmTests` (substring assertions), `GoldenFileTests`, and `BlocksGeneratedCodeTests`, which compiles the build plugin's output.
2. `REGENERATE_FIXTURES=1 swift test --filter GoldenFileTests` when the output changes on purpose, then review the `../codegen-fixtures/*/swift/` diff. Never hand-edit a golden or change an existing `spec.json`.
3. **Always** run the `cognito-cli-test --shape-test` harness afterwards — substring tests can't catch nested-vs-flat envelope regressions in custom Codable.

### After changing the runtime

1. `swift test --filter BlocksRuntimeTests`
2. Run the demo app under `Demo/swift-demo/` against a deployed Cognito sandbox to catch behavioural regressions in HTTP / WebSocket / Keychain.

