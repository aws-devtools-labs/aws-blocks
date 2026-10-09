# AWS Blocks Swift – Agent Guide

Context for AI coding agents working in this directory.

## Project Overview

A Swift Package that generates type-safe Swift client code from an OpenRPC specification, plus a runtime library that executes the generated code against an AWS Blocks backend. Three targets:

- **BlocksCodegen** — pure Swift: parser → model builder → Swift code generator. Ships as a SwiftPM target, invoked via the `swift-code-generator` executable or the `BlocksCodegenCommandPlugin` build plugin.
- **BlocksRuntime** — iOS + macOS: HTTP client, WebSocket-backed realtime channels, file upload/download handles, Keychain cookie store.
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
| Naming + identifier helpers | `Sources/BlocksCodegen/Helpers.swift` |
| Generator CLI entry | `Sources/swift-code-generator/runGenerator.swift` |

### Runtime target

| Purpose | Path |
|---------|------|
| HTTP client | `Sources/BlocksRuntime/BlocksClient.swift` |
| Request envelope | `Sources/BlocksRuntime/BlocksRequest.swift` |
| Untyped JSON value | `Sources/BlocksRuntime/JSONValue.swift` |
| Keychain-backed cookies | `Sources/BlocksRuntime/KeychainCookieStore.swift` |
| Realtime WebSocket channel | `Sources/BlocksRuntime/Realtime/RealtimeChannel.swift` |
| Realtime connection pool | `Sources/BlocksRuntime/Realtime/WebSocketSession.swift` |
| File download handle | `Sources/BlocksRuntime/FileBucket/FileDownloadHandle.swift` |
| File upload handle | `Sources/BlocksRuntime/FileBucket/FileUploadHandle.swift` |
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
| Hybrid-arm fixture spec | `../codegen-fixtures/18-hybrid-arm/spec.json` |
| Runtime tests | `Tests/BlocksRuntimeTests/*` |

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
| Generated code depends on `BlocksRuntime` only | Generated `Models.swift` and `API.swift` import `BlocksRuntime`; nothing else |
| Plugins depend on `swift-code-generator` only | Plugins invoke the CLI; must not depend on the runtime |

If you find yourself wanting to break one of these rules, reconsider the approach.

## Codegen Invariants

These rules are load-bearing — the generated wire format depends on them. Breaking them silently regresses end-to-end Cognito sign-up / confirm-sign-in flows.

| Invariant | Where it lives | Don't break |
|---|---|---|
| **Hybrid arm flat envelope** — when a `oneOf` arm has both outer `properties` AND a nested `oneOf`, the outer fields and the inner discriminator + payload share one JSON object. | `SwiftCodeGenerator.swift::emitRecordStruct` (the `embeddedUnion` branch). | The merged Codable forwards `try self.challenge.encode(to: encoder)` against the SAME `Encoder`. Any code path that nests the embedded union inside its own keyed container breaks the wire shape. |
| **Open-shape `T & Record<string, V>`** — records that carry `additionalPropertiesType` flatten an `attributes: [String: V]` map at the JSON top level. | `SwiftCodeGenerator.swift::openRecordLines`, used by `recordStructBody` (component schemas) and `emitNestedRecordStruct` (operation-scoped records, union variants), so every scope flattens. A union variant passes its discriminator as a fixed key; an attribute named like a fixed key isn't sent. | Custom `DynamicKey`-keyed Codable. Auto-derived Codable would nest the map under an `attributes` key — the server rejects that shape. |
| **Embedded union naming** — inner unions get a parent-prefixed name (e.g. `ConfirmSignInChallenge`), not just the field name. | `CodegenModelBuilder.swift` (variant resolution). | Two regrouped arms whose inner discriminator field is both called `challenge` would collide if the prefix were dropped. |
| **Inline union arms are NOT registered as top-level types** — they live as `UnionVariant` records inside their parent union. | `CodegenModelBuilder.swift::resolveType` (`asUnionVariant: true`). | Registering them produces `Input_Variant<N>` ghost structs that mirror the named per-action variants. |
| **A component schema's inline-object properties nest by path** — `Shipment.destination.geo` generates `Shipment.Destination.Geo`, and an enum or union inside a nested object nests with it. Enums and unions directly on a schema stay top-level. A nested name that would shadow a component schema, a Swift/runtime type, or a reserved name is prefixed with its enclosing type's name (`Order.OrderAddress`, `Holder.HolderDate`). | `CodegenModelBuilder.swift::resolveType` (`nestsInSchema`, `nestedTypeName`); `SwiftCodeGenerator.swift::emitRecordStruct` (`children`). | Registering them top-level by property name means two schemas with a same-named inline property share the first one's struct, which compiles but decodes the second shape wrongly. |
| **Nested type names are allocated per scope** — a type is named after its property (an array's element singularized, a map's value `…Value`, a channel's message `…Message`), so siblings can derive one name (`item` / `items: [{…}]` → `Item`). The property whose own type it is keeps the name; a derived sibling takes the name without singularizing (`Items`, `FeedsMessage`, as Kotlin and Dart name them), else a numeric suffix (`TagsValue_2`). An operation's inline result keeps `Result`. At the top level of Models.swift a component schema owns its name, and an inline enum or union shares a name only with an equal type, else it's prefixed with its schema's name (`TicketStatus`). An operation's signature names the shallowest type of a name (`Swap.Item`, not `Swap.Result.Item`). | `CodegenModelBuilder.swift` ("Name Allocation": `directClaims`, `allocateNestedName`, `allocateTopLevelName`); `SwiftCodeGenerator.swift::generateAll` (the operation name map). | Two declarations of one name don't compile (`invalid redeclaration`). At the top level, first-wins registration compiled but typed a property with another type of the same name, so it didn't decode. `NestedTypeNameCollisionTests` and fixture `30-name-collisions`. |
| **Params are positional, with `null` placeholders** — the server calls the method with `params` as its argument list (`parseRpcRequest`), so every argument keeps its slot, as the TypeScript client sends it: up to the last required one each is in its slot (a nil optional encodes as `null`); a trailing optional one is appended when set, as `JSONValue.null` when a later one is set (`if let b { … } else if c != nil { _params.append(JSONValue.null) }`), and trailing unset ones are left off. | `SwiftCodeGenerator+Names.swift::requestLines`. | Appending only the set optionals sent `["a","c"]` for `echoArgs(first: "a", middle: nil, last: "c")`, which the server read as `middle = "c"`. `OptionalParameterSlotTests`, `RpcWireE2ETests`. |
| **Generated names step aside for spec names; names Swift can't declare are sanitized** — an operation's locals (`_params`, `request`, `result`, `descriptor`) take `_2` beside a parameter of their name; the body reads `self.client` when a parameter is `client` (a channel's decoder closure captures `[client = self.client]`); a parameter named `self` or like a type the body spells (`JSONDecoder`, the result type) keeps its label and takes an internal name (`JSONDecoder JSONDecoder_2: String`). The class's `client` property steps aside for an operation named `client`, an operation's enum for a type the class spells (`Item_2`, `String_2`), a namespace class for a top-level type and `Servers` (`Api_2`, `Servers_2`), an open record's `attributes` and a hybrid arm's `challenge` for a property of their name (`attributes_2`). Properties, parameters, functions, enum cases and servers that aren't identifiers are sanitized and unique per scope (the spec name that's an identifier keeps it: `a_b`, `a.b` → `a_b_2`), keyword cases are backticked, and every spec string spliced into a literal goes through `swiftStringContent`. | `SwiftCodeGenerator+Names.swift` (`operationNames`, `apiClassMemberNames`, `apiClassNames`, `extrasPropertyName`, `enumCaseLines`); `Helpers.swift` (`swiftIdentifiers`, `SwiftNameScope`, `swiftStringContent`, `specTypeName`). | A parameter named `client` hid the property (`no member 'execute'`); `attributes` was declared twice; `back\slash` broke its literals (`invalid escape sequence`). Every name that collides with nothing is unchanged. `GeneratedNameCollisionTests` and fixture `35-generated-name-collisions`. |
| **Transferables decode through `Codable`** — a model can hold a `RealtimeChannel`, file handle or `OIDCClient` at any depth, because each is `Codable` in BlocksRuntime (decode from the `{ "__blocks": … }` descriptor, encode back to it). `Models.swift` imports BlocksRuntime when it names one. An operation whose result holds an `oidc/client` at any depth decodes with `client.makeDecoder()`, which carries the client in `userInfo[.blocksClient]`. | `RealtimeChannel.swift`, `FileDownloadHandle.swift`, `FileUploadHandle.swift`, `OIDCClient.swift` (`init(from:)` / `encode(to:)`); `TransferableCoding.swift`; `SwiftCodeGenerator+Transferables.swift::needsClient`. | Decoding an `OIDCClient` with a plain `JSONDecoder()` throws. `needsClient` must follow every path a decoder takes (fields, containers, union variants, open-record values, embedded unions, channel message types, nested and component types), or a result that holds an OIDC client deep down fails to decode. |
| **One JSON coding for the wire** — dates are ISO 8601 strings (`"2026-10-05T12:34:56.789Z"`, what `JSON.stringify` sends). Every decoder and encoder comes from `BlocksJSONCoding` (through `BlocksClient.makeDecoder()` / `makeEncoder()`, a channel's message decoder, and request encoding). A result or channel message holding a `Date` or an `OIDCClient` decodes with `client.makeDecoder()`; `format: date` is a `String`. A value (a positional param, a union's value arm) encodes through a container, never its own `encode(to:)`. | `BlocksJSONCoding.swift`; `SwiftCodeGenerator+Transferables.swift::needsClientDecoder`; `BlocksArrayParams.swift`; `emitTransparentUnionCoding`. | A plain `JSONDecoder()` for a `Date` expects a number and fails on every server date; `value.encode(to:)` bypasses the encoder's strategies (a `Date` becomes a number, a `URL` `{"relative": …}`). |
| **Literals keep their JSON type** — `const` / one-value `enum` booleans and numbers parse to `TypeRef.literal`, strings to a one-value `unionLiteral`. A discriminator decodes and encodes its values as their type (`Bool`, `Double`, `Int`, `String`); a one-literal union arm is a payload-less case that encodes its value and decodes only from it (not a fallback). | `SpecTypes.swift` (`constLiteral`); `CodegenModelBuilder.swift::detectDiscriminator`, `literalValue(of:)`; `SwiftCodeGenerator.swift::emitDiscriminatedCoding`. | Stringifying them sends `"true"` for a boolean discriminator and fails to decode the server's `true`. |
| **Every generated struct has a `public init`** — properties in declaration order, the synthesized init's labels, optional and nullable properties default to `nil`, spec defaults as defaults, constraint guards in the body. Open records and embedded-union structs emit their own (with `attributes:` / `challenge:`). A property named `self` takes the label `self` with a different parameter name (`self_`); a parameter named `self` would hide the instance, so the assignment would target the parameter. | `SwiftCodeGenerator.swift::recordStructBody` and `emitNestedRecordStruct`; `Helpers.swift::initArgumentName`. | Swift's synthesized memberwise init is `internal`, so a consumer in another module (the generated client in its own package, a test target, a preview) couldn't construct a model or an operation's inline `Input`. `PublicInitTests.testConsumerInAnotherModuleConstructsModels` compiles the output as its own module and type-checks a second module against it (macOS only). |
| **No structural deduplication** — two methods returning the same anonymous shape produce two distinct types named after the methods. | `CodegenModelBuilder.swift` (no `structuralKey` registry). | The TS compiler can synthesize identical mapped-type objects from unrelated source types; deduping would cause `setCookie() -> DeleteTodoResponse`-style naming. Deduping would cause incoherent naming. |

## Swift Concurrency

Generated code is Swift Concurrency-ready: `func setAuthState(input: Input) async throws -> AuthState` is the standard signature. The runtime client (`BlocksClient`) is a `@MainActor`-free, sendable type — it can be called from any actor. There is no `@MainActor` isolation on generated types or the runtime.

Generated `struct`s and `enum`s are pure value types, automatically `Sendable` when their fields are. Don't add reference types to the IR or to runtime-shipped data classes.

WebSocket lifecycle (`RealtimeChannel`, `WebSocketSession`) uses an `actor` for connection-pool state. Keep it that way — `WebSocketSession` is the only place reference-type concurrency lives in this stack.

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

1. `swift test` — runs `SwiftCodeGeneratorTests` (snapshot-style) and `HybridArmTests` (substring assertions).
2. `bash scripts/compile-fixture-goldens.sh` — compiles every fixture's Swift golden as its own module against `BlocksRuntime` (the golden tests only compare text).
3. **Always** run the `cognito-cli-test --shape-test` harness afterwards — substring tests can't catch nested-vs-flat envelope regressions in custom Codable.

### After changing the runtime

1. `swift test --filter BlocksRuntimeTests`
2. Run the demo app under `Demo/swift-demo/` against a deployed Cognito sandbox to catch behavioural regressions in HTTP / WebSocket / Keychain.

