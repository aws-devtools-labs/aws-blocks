# AWS Blocks Kotlin – Agent Guide

Context for AI coding agents working in this repository.

## Project Overview

A Gradle plugin + runtime that generates type-safe Kotlin client code from OpenRPC specifications. Three modules:

- **codegen** — pure JVM: parser → model builder → Kotlin code generator
- **plugin** — Gradle plugin wiring codegen into Android/KMP build variants
- **runtime** — Kotlin Multiplatform library (Android, iOS, JVM, Desktop): HTTP client, WebSocket, file handles, OIDC auth

Plus **fixture-goldens**, a check-only module (not published) that compiles every codegen fixture's Kotlin golden against the runtime, and runs round-trip tests that decode and encode real wire JSON through the goldens of the fixtures that have them (`fixture-goldens/round-trips/<fixture>/`, each compiled against that fixture's golden only).

## Key File Paths

### Codegen Module

| Purpose | Path |
|---------|------|
| OpenRPC parser | `codegen/src/main/java/com/aws/blocks/kotlin/parser/OpenRpcParser.kt` |
| Model builder (3-pass pipeline) | `codegen/src/main/java/com/aws/blocks/kotlin/builder/CodegenModelBuilder.kt` |
| Kotlin code generator | `codegen/src/main/java/com/aws/blocks/kotlin/generator/KotlinCodeGenerator.kt` |
| Transferable serializer generator | `codegen/src/main/java/com/aws/blocks/kotlin/generator/TransferableSerializerGenerator.kt` |
| Naming utilities | `codegen/src/main/java/com/aws/blocks/kotlin/generator/Names.kt` |
| RpcModel (parser output) | `codegen/src/main/java/com/aws/blocks/kotlin/model/RpcModel.kt` |
| CodegenModel + ResolvedType | `codegen/src/main/java/com/aws/blocks/kotlin/model/CodegenModel.kt` |
| Constraints | `codegen/src/main/java/com/aws/blocks/kotlin/model/Constraints.kt` |

### Plugin Module

| Purpose | Path |
|---------|------|
| Plugin entry point | `plugin/src/main/kotlin/com/aws/blocks/plugin/AwsBlocksCodegenPlugin.kt` |
| Extension DSL | `plugin/src/main/kotlin/com/aws/blocks/plugin/AwsBlocksExtension.kt` |
| Codegen Gradle task | `plugin/src/main/kotlin/com/aws/blocks/plugin/AwsBlocksCodegenTask.kt` |
| Dump model task | `plugin/src/main/kotlin/com/aws/blocks/plugin/AwsBlocksDumpModelTask.kt` |

### Runtime Module (Kotlin Multiplatform)

| Purpose | Path |
|---------|------|
| HTTP client | `runtime/src/commonMain/kotlin/com/aws/blocks/kotlin/BlocksClient.kt` |
| Server configuration | `runtime/src/commonMain/kotlin/com/aws/blocks/kotlin/BlocksServer.kt` |
| Request envelope | `runtime/src/commonMain/kotlin/com/aws/blocks/kotlin/BlocksRequest.kt` |
| HTTP client factory | `runtime/src/commonMain/kotlin/com/aws/blocks/kotlin/HttpClientFactory.kt` |
| Cookie storage | `runtime/src/commonMain/kotlin/com/aws/blocks/kotlin/PersistentCookiesStorage.kt` |
| WebSocket channel | `runtime/src/commonMain/kotlin/com/aws/blocks/kotlin/realtime/RealtimeChannel.kt` |
| Connection pool | `runtime/src/commonMain/kotlin/com/aws/blocks/kotlin/realtime/WebSocketPool.kt` |
| File download handle | `runtime/src/commonMain/kotlin/com/aws/blocks/kotlin/filebucket/FileDownloadHandle.kt` |
| File upload handle | `runtime/src/commonMain/kotlin/com/aws/blocks/kotlin/filebucket/FileUploadHandle.kt` |
| OIDC auth client | `runtime/src/commonMain/kotlin/com/aws/blocks/kotlin/oidc/OidcClient.kt` |
| Exception hierarchy | `runtime/src/commonMain/kotlin/com/aws/blocks/kotlin/exceptions/` |
| JSON utilities | `runtime/src/commonMain/kotlin/com/aws/blocks/kotlin/json/BlocksJson.kt` |

### Example Apps & Spec

| Purpose | Path |
|---------|------|
| Example spec file | `example/typescript/aws-blocks/blocks.spec.json` |
| Android example app | `example/android/app/` |
| Android app build config | `example/android/app/build.gradle.kts` |
| Android: MainActivity | `example/android/app/src/main/java/com/aws/blocks/example/MainActivity.kt` |
| Android: CursorTracker | `example/android/app/src/main/java/com/aws/blocks/example/CursorTracker.kt` |
| Android: FileTransfer | `example/android/app/src/main/java/com/aws/blocks/example/FileTransfer.kt` |
| KMP example app | `example/kmp/composeApp/` |
| KMP app build config | `example/kmp/composeApp/build.gradle.kts` |
| KMP: App (shared UI) | `example/kmp/composeApp/src/commonMain/kotlin/com/aws/blocks/example/App.kt` |

## Build and Test Commands

```bash
# Build all modules (codegen, plugin, runtime)
./gradlew build

# Run codegen tests only
./gradlew :codegen:test

# Run plugin tests only
./gradlew :plugin:test

# Compile every codegen fixture's Kotlin golden (../codegen-fixtures/*/kotlin/), one compilation per fixture
bash scripts/compile-fixture-goldens.sh

# Round-trip wire JSON through the goldens of fixtures with tests in fixture-goldens/round-trips/<fixture>/ (JVM)
./gradlew :fixture-goldens:roundTripFixtureGoldens

# Dump the intermediate model (useful for debugging spec interpretation)
./gradlew awsBlocksDumpModel

# Generate code for the Android example app (debug variant)
./gradlew :example:android:app:awsBlocksCodegenDebug

# Build the Android example app (triggers codegen automatically)
./gradlew :example:android:app:assembleDebug

# Build the KMP example app (desktop target)
./gradlew :example:kmp:composeApp:desktopJar

# Clean everything (useful after spec changes)
./gradlew clean

# Check generated output location (Android)
find example/android/app/build/generated/source/aws/blocks/debug -name "*.kt"

# Check generated output location (KMP)
find example/kmp/composeApp/build/generated/source/aws/blocks/commonMain -name "*.kt"
```

## Module Dependency Rules

These constraints must be maintained:

| Rule | Reason |
|------|--------|
| `codegen` must NOT import Android APIs | It's a pure JVM library; must run on CI without Android SDK |
| `codegen` must NOT depend on `runtime` | They ship independently; codegen runs at build time only |
| `runtime` must NOT depend on `codegen` or `plugin` | It's a runtime-only KMP library |
| `plugin` depends on `codegen` only | Plugin invokes codegen; must not depend on runtime |
| Generated code depends on `runtime` only | Generated .kt files import from `com.aws.blocks.kotlin.*` |

If you find yourself needing to break one of these rules, something is wrong with the approach — reconsider.

## Common Workflows

### After changing the parser (`OpenRpcParser`)

1. Run `./gradlew :codegen:test` to verify parsing still works
2. Run `./gradlew awsBlocksDumpModel` to verify the model looks correct
3. Run `./gradlew :example:android:app:assembleDebug` to verify generated code compiles

### After changing the model builder (`CodegenModelBuilder`)

1. Run `./gradlew :codegen:test`
2. Run `./gradlew awsBlocksDumpModel` — inspect type definitions, namespaces, relationships
3. Run `./gradlew :example:android:app:assembleDebug` to verify end-to-end

### After changing the generator (`KotlinCodeGenerator`)

1. Run `./gradlew :codegen:test`
2. If the output changed: regenerate the goldens (`../codegen-fixtures/regenerate-all.sh`), then run `bash scripts/compile-fixture-goldens.sh` — the golden tests only compare text, this compiles them — and `./gradlew :fixture-goldens:roundTripFixtureGoldens`, which checks the compiled goldens read and write the wire format (CI runs both in the `fixture-goldens` job of `.github/workflows/native-kotlin-analysis.yml`)
3. Run `./gradlew clean :example:android:app:assembleDebug` — clean build ensures no stale output
4. Inspect generated files: `find example/android/app/build/generated/source/aws/blocks/debug -name "*.kt"`
5. Verify the example app still compiles and the generated API surface matches expectations

### After changing the runtime

1. Run `./gradlew :runtime:build`
2. Run `./gradlew :example:android:app:assembleDebug` to verify the Android example app still links correctly
3. If you changed `BlocksClient` or transferable hydration, verify the example app runs on an emulator

### After changing the plugin DSL

1. Run `./gradlew :plugin:test`
2. Verify the example app's `build.gradle.kts` still configures correctly
3. Run `./gradlew :example:android:app:assembleDebug`

### After updating the spec file

1. Run `./gradlew awsBlocksDumpModel` to verify parsing
2. Run `./gradlew clean :example:android:app:assembleDebug`
3. Fix any compilation errors in the example app from changed API signatures
