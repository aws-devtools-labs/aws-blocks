# Codegen Fixtures

Each fixture directory contains:
- A `spec.json` file (the OpenRPC spec that drives code generation)
- Platform-specific subdirectories (`kotlin/`, `swift/`, `dart/`) containing generated code

## Rules

- **DO NOT** directly edit any of the platform files (`kotlin/`, `swift/`, `dart/`). These are auto-generated. To fix issues in the generated code, modify the relevant code generator and then re-generate the files.
- **DO NOT** change an existing `spec.json` to fix a codegen issue. The spec represents the intended input; the fix belongs in the generator.
- **You CAN** add to an existing `spec.json` to cover additional cases.
- **You CAN** create new fixture directories with new specs for additional coverage.
- **Exception:** `18-hybrid-arm` and `23-cognito-nested-unions` mirror the live `Auth` block's spec. Update their `spec.json` only with `node native/codegen-fixtures/check-live-auth-fixtures.mjs --write` (then `regenerate-all.sh`), never by hand.
