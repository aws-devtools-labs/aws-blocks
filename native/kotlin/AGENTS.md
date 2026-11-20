# AWS CDK Blocks Kotlin – Agent Guide

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
| Plugin entry point | `plugin/src/main/kotlin/com/aws/blocks/plugin/CdkBlocksCodegenPlugin.kt` |
| Extension DSL | `plugin/src/main/kotlin/com/aws/blocks/plugin/CdkBlocksExtension.kt` |
| Codegen Gradle task | `plugin/src/main/kotlin/com/aws/blocks/plugin/CdkBlocksCodegenTask.kt` |
| Dump model task | `plugin/src/main/kotlin/com/aws/blocks/plugin/CdkBlocksDumpModelTask.kt` |

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
| Example spec file | `example/typescript/cdk-blocks/blocks.spec.json` |
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

# Clean everything (useful after spec changes)
./gradlew clean
```

The e2e suite (`e2e/`) is also its own Gradle build, driven by `run-e2e.sh`, which generates the
spec from `test-apps/native-bindings`, runs codegen, starts the dev server and runs one target's
tests. One `commonTest` suite runs on all three targets.

```bash
# E2E on the JVM (default), the iOS simulator, or an Android emulator
./run-e2e.sh --target jvm
./run-e2e.sh --target ios
./run-e2e.sh --target android   # boot an emulator first; the script does not

# Against an already-running endpoint, skipping the local dev server
./run-e2e.sh --target android --blocks-url https://example.com/cdk-blocks/api
```

The Android target runs as an instrumented test APK (`connectedAndroidDeviceTest`), which is the
only way to exercise the runtime's Android source set: the Android Keystore-backed credential store,
the cookie jar built on it, the `androidx.startup` context wiring. `BLOCKS_URL` and `RUN_OIDC` reach
the device as instrumentation arguments, and `run-e2e.sh` forwards the device's port 3001 to the
host with `adb reverse` so one `BLOCKS_URL` works on every target.

Each example app is its own Gradle build that composes this one in, so its tasks are not in the
root build and are run from the app's own directory. Both read a `blocks.spec.json` emitted from
`example/typescript`, which is gitignored, so a fresh checkout has no spec to generate from until
one exists.

```bash
# Generate code for the Android example app (debug variant)
cd example/android && ./gradlew :app:cdkBlocksCodegenDebug

# Build the Android example app (triggers codegen automatically)
cd example/android && ./gradlew :app:assembleDebug

# Build the KMP example app (desktop target)
cd example/kmp && ./gradlew :composeApp:desktopJar

# Dump the intermediate model (useful for debugging spec interpretation)
cd example/android && ./gradlew :app:cdkBlocksDumpModel

# Check generated output location (Android)
find example/android/app/build/generated/source/cdk/blocks/debug -name "*.kt"

# Check generated output location (KMP)
find example/kmp/composeApp/build/generated/source/cdk/blocks/commonMain -name "*.kt"
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
2. Run `cd example/android && ./gradlew :app:cdkBlocksDumpModel` to verify the model looks correct
3. Run `cd example/android && ./gradlew :app:assembleDebug` to verify generated code compiles

### After changing the model builder (`CodegenModelBuilder`)

1. Run `./gradlew :codegen:test`
2. Run `cd example/android && ./gradlew :app:cdkBlocksDumpModel` — inspect type definitions, namespaces, relationships
3. Run `cd example/android && ./gradlew :app:assembleDebug` to verify end-to-end

### After changing the generator (`KotlinCodeGenerator`)

1. Run `./gradlew :codegen:test`
2. If the output changed: regenerate the goldens (`../codegen-fixtures/regenerate-all.sh`), then run `bash scripts/compile-fixture-goldens.sh` — the golden tests only compare text, this compiles them — and `./gradlew :fixture-goldens:roundTripFixtureGoldens`, which checks the compiled goldens read and write the wire format (CI runs both in the `fixture-goldens` job of `.github/workflows/native-kotlin-analysis.yml`)
3. Run `cd example/android && ./gradlew clean :app:assembleDebug` — clean build ensures no stale output
4. Inspect generated files: `find example/android/app/build/generated/source/cdk/blocks/debug -name "*.kt"`
5. Verify the example app still compiles and the generated API surface matches expectations

### After changing the runtime

1. Run `./gradlew :runtime:build`
2. Run `cd example/android && ./gradlew :app:assembleDebug` to verify the Android example app still links correctly
3. If you changed `BlocksClient` or transferable hydration, verify the example app runs on an emulator
4. If you changed an Android-only source (storage, cookies, context wiring), run `./run-e2e.sh --target android` against a booted emulator — the host JVM has no equivalent of those paths
5. If you changed the Android credential store (`KeyValueStore.android.kt`,
   `EncryptedPreferencesLegacySource.android.kt`), the step above covers its normal reads and
   writes: the e2e sign-in tests reach the real Keystore through the cookie jar. What they do not
   reach is the one-time read of an `EncryptedSharedPreferences` file left by an earlier version,
   since a fresh install has none, and the API 33+ `KeyStoreException` fault classification.
   Exercise those on an emulator before release, covering the migration, a downgraded file, `clear`
   against a file not yet migrated, a lost key, a corrupted value, and a legacy file holding one
   entry that will not decrypt. Two cases a modern image cannot reach at all: on an API 23–32 image,
   an `EncryptedSharedPreferences.create` fault below 33 cannot be told apart from a lost
   `MasterKey`, so the store drops the earlier session rather than retry; and on API 24+, `clear`
   against a legacy file written by an earlier process and never opened in this one, which is where
   `deleteSharedPreferences` is reported to return false on some builds. Do not drop
   `androidx.security:security-crypto` until that run has covered this list: once
   `EncryptedPreferencesLegacySource` is deleted, a fault in the legacy read cannot be caught at
   all.

### After changing the plugin DSL

1. Run `./gradlew :plugin:test`
2. Verify the example app's `build.gradle.kts` still configures correctly
3. Run `cd example/android && ./gradlew :app:assembleDebug`

### After updating the spec file

1. Run `cd example/android && ./gradlew :app:cdkBlocksDumpModel` to verify parsing
2. Run `cd example/android && ./gradlew clean :app:assembleDebug`
3. Fix any compilation errors in the example app from changed API signatures

## Changesets

Changes to this package need a changeset in `native/kotlin/.changeset/`, keyed
`"aws-cdk-blocks-kotlin"`. The version in `package.json` is the source of truth and
`gradle.properties` follows it, so run `scripts/sync-version.sh` after any bump.

Pick the bump type by what the change does to a caller. From 1.0.0 the package follows
semantic versioning, so these are not interchangeable:

| Bump | Use for |
|------|---------|
| `major` | Anything source-breaking: a removed or renamed public declaration, a changed signature or return type, a new exhaustive-`when` branch, or a behaviour change a caller must handle |
| `minor` | New public API that existing code keeps compiling against |
| `patch` | Fixes and internal changes with no public API change |

Before 1.0.0 every breaking change was filed as `minor`, because a `minor` bump on a
`0.x` version is already breaking under semver. That is no longer true: a `minor`
release off 1.x reads as safe to tools that resolve ranges, such as Dependabot,
Renovate, or a `1.+` Gradle constraint, and they will pull it in without review. A
source-breaking change filed as `minor` now ships to those callers as a silent break.
