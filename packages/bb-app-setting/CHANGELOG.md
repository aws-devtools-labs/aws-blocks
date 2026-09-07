# @aws-blocks/bb-app-setting

## 0.2.0

### Minor Changes

- 1ff9d03: `AppSetting`: support a customer-managed KMS key for secrets via `kmsKeyArn`.
  
  Secret (`SecureString`) parameters were always encrypted with the default `aws/ssm` AWS-managed key, so their decrypt scope couldn't be controlled (e.g. for cross-account access or a dedicated key policy). Passing `kmsKeyArn` (also accepted by `AppSetting.fromExisting`) now encrypts the secret with that customer-managed key:
  
  - the bulk-init Custom Resource creates the parameter with the CMK (`KeyId`);
  - the shared handler is granted `kms:Decrypt`/`Encrypt` scoped to that specific key ARN (instead of the `aws/ssm` `ViaService` wildcard);
  - the runtime `put()` re-specifies the key on overwrite so it doesn't silently fall back to `aws/ssm`;
  - adding/changing/removing `kmsKeyArn` on an already-deployed secret re-encrypts its current value under the new key at deploy time, so decryption keeps working after a key rotation.
  
  `kmsKeyArn` is only valid with `secret: true` and must be a non-empty ARN. The default (no `kmsKeyArn`) is unchanged.

### Patch Changes

- 309a236: refactor(bb): attach IAM grants to the shared execution role
  
  Data and auth blocks now grant permissions to the shared Blocks execution role
  (`this.executionRole`) instead of the handler function directly. Grants land on
  the same role the handler assumes, so the effective runtime permissions are
  identical — this decouples IAM wiring from the concrete Lambda function ahead of
  the multi-compute model.
  
  For `bb-distributed-data`, the DSQL endpoint and region now flow through the
  config registry (loaded into `process.env` at cold start, like every other
  block) rather than being set as direct handler environment variables, and the
  migration Lambda maps the shared execution role's ARN.
- Updated dependencies [5798492]
- Updated dependencies [f00adb0]
- Updated dependencies [f00adb0]
- Updated dependencies [08ab129]
- Updated dependencies [9d4ccea]
- Updated dependencies [5bfae0a]
- Updated dependencies [0ac3879]
- Updated dependencies [e4dac4a]
  - @aws-blocks/core@0.3.0
  - @aws-blocks/bb-logger@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-logger@0.1.4

## 0.1.3

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
  - @aws-blocks/bb-logger@0.1.2

## 0.1.2

### Patch Changes

- 18880ff: Minor test improvements
- Updated dependencies [18880ff]
  - @aws-blocks/core@0.1.2

## 0.1.1

### Patch Changes

- 270c049: docs: scrub and port documentation from internal staging repo
- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
