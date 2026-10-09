# Cross-Platform Codegen Fixtures

Shared OpenRPC spec fixtures for verifying codegen output across Kotlin, Swift, and Dart.

## Structure

Each numbered directory contains:
- `spec.json` — the OpenRPC 1.3.2 input spec
- `kotlin/` — golden-file outputs from Kotlin codegen
- `swift/` — golden-file outputs from Swift codegen
- `dart/` — golden-file outputs from Dart codegen

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

## Adding a New Fixture

1. Create a new numbered directory: `native/codegen-fixtures/NN-name/`
2. Add a `spec.json` with the OpenRPC spec
3. Run `./native/codegen-fixtures/regenerate-all.sh`
4. Review the generated golden files
5. Commit everything together

## Workflow After Codegen Changes

1. Make your codegen change
2. Run tests — they fail with a diff showing old vs. new output
3. Review the diff to confirm the change is intentional
4. Run regeneration for the affected platform(s)
5. Commit the updated golden files alongside the codegen change
