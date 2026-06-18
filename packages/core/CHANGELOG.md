# @aws-blocks/core

## 0.1.2

### Patch Changes

- 18880ff: Fix `deploy`, `sandbox`, and `destroy` failing on Windows: spawn `npm`/`npx`/`cdk` via `cross-spawn` (resolves the `.cmd` shims) and import the backend through a `file://` URL so absolute paths like `D:\...` work during CDK synth.

## 0.1.1

### Patch Changes

- 270c049: docs: scrub and port documentation from internal staging repo
- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/hosting@0.1.1

## 0.1.0

Initial version
