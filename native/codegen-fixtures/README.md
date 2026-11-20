# Cross-Platform Codegen Fixtures

Shared OpenRPC spec fixtures for verifying codegen output across Kotlin, Swift, and Dart.

## Workflow After Codegen Changes

1. Make your codegen change
2. [Run the tests](#running-tests) — they fail with a diff showing old vs. new output
3. Review the diff to confirm the change is intentional
4. [Regenerate the golden files](#regenerating-golden-files) for the affected platform(s)
5. For a Dart change, check that the [Dart goldens analyze clean](#dart-goldens-must-analyze-clean) (0 errors)
6. For a Swift change, check that the [Swift goldens compile](#swift-goldens-must-compile)
7. For a Kotlin change, check that the [Kotlin goldens compile](#kotlin-goldens-must-compile) (0 errors) and that every round trip passes
8. Commit the updated golden files alongside the codegen change

## Structure

Each numbered directory contains:
- `spec.json` — the OpenRPC 1.3.2 input spec
- `kotlin/` — golden-file outputs from Kotlin codegen, or `codegen-error.txt` for a spec Kotlin refuses to generate (the error message; for example a transferable parameter, since transferables are read-only)
- `swift/` — golden-file outputs from Swift codegen, or `codegen-error.txt` for a spec Swift refuses. Swift and Kotlin refuse the same specs with the same message, so the two `codegen-error.txt` files are identical (`GoldenFileTests` checks it)
- `dart/` — golden-file outputs from Dart codegen, or `codegen-error.txt` for a spec the Dart codegen refuses to generate

## Running Tests

Tests automatically discover all fixtures and assert codegen output matches golden files.

**Kotlin:**
```bash
cd native/kotlin && ./gradlew :codegen:test --tests "com.aws.blocks.kotlin.CodegenFixturesTest"
```

**Swift:**
```bash
cd native/swift && swift test --filter GoldenFileTests
```

**Dart:**
```bash
cd native/dart/packages/blocks_codegen && dart test test/golden_file_test.dart
```

## Regenerating Golden Files

After making intentional codegen changes, regenerate golden files and commit the diff.

**All platforms at once:**
```bash
./native/codegen-fixtures/regenerate-all.sh
```

**Kotlin only:**
```bash
cd native/kotlin && ./gradlew :codegen:regenerateFixtures
```

**Swift only:**
```bash
cd native/swift && REGENERATE_FIXTURES=1 swift test --filter GoldenFileTests
```

**Dart only:**
```bash
cd native/dart/packages/blocks_codegen && REGENERATE_FIXTURES=1 dart test test/golden_file_test.dart
```

## Dart Goldens Must Analyze Clean

The golden-file tests compare text, so they can't tell whether a golden compiles. A separate check runs `dart analyze` over every fixture's Dart golden, against the in-repo `blocks_runtime` and the SDK's strict `analysis_options.yaml`, and fails on any error (CI: the `fixture-goldens` job of `.github/workflows/native-dart-analysis.yml`):

```bash
bash native/dart/scripts/analyze-fixture-goldens.sh
```

## Swift Goldens Must Compile

A separate check compiles every fixture's Swift golden and fails on any error:

- It compiles `Models.swift` + `Api.swift` as the fixture's own library module against the in-repo `BlocksRuntime`, for the package's minimum macOS. A separate module is how an app that keeps its generated client in its own Swift package builds it, so access control applies.
- It skips a fixture whose Swift golden is `codegen-error.txt`.
- It needs macOS (`xcrun swiftc`).
- CI runs it in the `fixture-goldens` job of `.github/workflows/native-sdk-swift.yml`.

```bash
bash native/swift/scripts/compile-fixture-goldens.sh
```

## Kotlin Goldens Must Compile

A separate check compiles every fixture's Kotlin golden against the in-repo runtime (JVM):

- Each fixture is its own compilation unit (a source set of the `:fixture-goldens` Gradle module, since the goldens share a package and type names), with no opt-ins beyond what the golden declares.
- It fails on any compiler error; warnings are advisory.
- It needs a JDK 17 as `JAVA_HOME`.
- CI runs it in the `fixture-goldens` job of `.github/workflows/native-kotlin-analysis.yml`.

```bash
bash native/kotlin/scripts/compile-fixture-goldens.sh
```

Compiling can't show that a generated serializer reads and writes the wire format. So a fixture `NN-name` may also have Kotlin round-trip tests in `native/kotlin/fixture-goldens/round-trips/NN-name/`: Kotest tests in a source set of their own, compiled against that fixture's golden only, that decode and encode real wire JSON through the generated types. They are a step of the same `fixture-goldens` CI job. With a JDK 17 as `JAVA_HOME`, from `native/kotlin`:

```bash
./gradlew :fixture-goldens:roundTripFixtureGoldens
```

To add round trips for a fixture, create `native/kotlin/fixture-goldens/round-trips/NN-name/` (named exactly like the fixture) with a `*Test.kt` file; the Gradle module picks it up.

## Auth Fixtures Must Match the Live Block

Regenerating golden files only proves the generators are stable against the committed `spec.json`. A separate check compares three fixtures with the spec `test-apps/native-bindings` emits from the live `Auth` block (CI: the `setup` job of `.github/workflows/native-sdk-e2e.yml`):

| Fixture | Mirrors | Compared |
|---------|---------|----------|
| `18-hybrid-arm` | The sign-in state machine (`createApi()`'s `setAuthState`) | The spec |
| `23-cognito-nested-unions` | `Auth.signIn` / `confirmSignIn`'s result unions | The spec |
| `37-oidc-provider-enum` | The typed `oidc/client` of the live `oidcAuthApi.getClient` (`Auth.createOidcApi()`) | The shape only, since fixture 37 carries its own provider ids |

```bash
npm run build   # from the repo root
node native/codegen-fixtures/check-live-auth-fixtures.mjs --generate
```

When the block's surface changes on purpose, rewrite the two specs from the live block and regenerate (`--write` doesn't touch fixture 37; edit its `spec.json` by hand):

```bash
node native/codegen-fixtures/check-live-auth-fixtures.mjs --write
./native/codegen-fixtures/regenerate-all.sh
```

## Adding a New Fixture

1. Create a new numbered directory: `native/codegen-fixtures/NN-name/`
2. Add a `spec.json` with the OpenRPC spec
3. Run `./native/codegen-fixtures/regenerate-all.sh`
4. Review the generated golden files
5. Commit everything together
