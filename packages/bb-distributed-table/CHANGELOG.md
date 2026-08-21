# @aws-blocks/bb-distributed-table

## 0.1.6

### Patch Changes

- 08ab129: `DistributedTable`: make production DynamoDB tables secure by default, and add options to tune it.
  
  Previously every table this block provisioned shipped with Point-in-Time Recovery disabled, deletion protection off, no explicit SSE-KMS, and CDK's default removal policy — so a stray `cdk destroy` could permanently and unrecoverably delete customer data, and at-rest data used an AWS-owned key with no CloudTrail auditability.
  
  Durability posture now comes from the stack-wide **`BlocksDefaults`** (see `BlocksPresets` in `@aws-blocks/core/cdk`): a `production` stack retains + protects + backs up its tables, a `sandbox` stack is disposable. So on a production deploy a table defaults to:
  
  - **Point-in-Time Recovery** enabled (`defaults.pointInTimeRecovery`) — 35-day continuous backups
  - **Deletion protection** enabled (`defaults.deletionProtection`)
  - **`RemovalPolicy.RETAIN`** (`defaults.removalPolicy`) — stack deletion orphans rather than destroys the table
  - **SSE-KMS** with the AWS-managed `aws/dynamodb` key (auditable, no per-key charge)
  
  Under the `sandbox` preset PITR, deletion protection, and RETAIN all flip off/`DESTROY`, so throwaway stacks stay cheap and `sandbox:destroy` tears down in one command. (The block no longer reads the `sandboxMode` context for durability — that posture flows through the stack `defaults`.)
  
  Every default is overridable per table:
  
  - `protection` (`'disposable' | 'retained' | 'locked'`) — one knob spanning removal policy + deletion protection, so the contradictory "protect + destroy" state can't be expressed. When set it wins over the stack `defaults`.
  - `pointInTimeRecovery` (`boolean | { retentionDays: number }`) — overrides `defaults.pointInTimeRecovery` for this table. `true` enables PITR with the default 35-day window, `false` disables it, and `{ retentionDays: n }` (1–35) pins a shorter window to trim backup cost. Window and on/off are one field, so "days set but PITR off" can't be expressed.
  - `encryption` (`'aws-managed' | 'customer-managed'`, or `DistributedTable.fromKmsKey(arn)` to share an existing customer-managed key across tables instead of provisioning one CMK each).
  
  Tables bound via `fromExisting()` are unaffected, and now emit a synth-time warning if durability/encryption options are passed alongside them (they're ignored). An unrecognized `protection`/`encryption` value, or an out-of-range `pointInTimeRecovery.retentionDays`, also warns at synth rather than silently falling back.
  
  > **Behavior change on next production deploy of an existing app:** the table will gain PITR, deletion protection, an SSE-KMS specification, and a `Retain` deletion policy (from the `production` preset). These are in-place updates (no table replacement). Because deletion protection becomes enabled, a future `cdk destroy` of a prod stack will refuse to delete the table until you relax it (`protection: 'disposable'`/`'retained'`). And because the removal policy is now `Retain`, deleting the stack orphans the table — redeploying the same app then fails with `Table already exists` until the orphaned table is removed or imported.
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
- Updated dependencies [08ab129]
- Updated dependencies [5bfae0a]
  - @aws-blocks/core@0.3.0
  - @aws-blocks/bb-logger@0.1.5

## 0.1.5

### Patch Changes

- 7b4c62d: Add infrastructure `defaults` chosen once at the app entry point, replacing the per-block `sandboxMode` logic and the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin dance for removal-policy and deletion-protection.
  
  `@aws-blocks/core/cdk` now exports `BlocksDefaults` and the `BlocksPresets.sandbox` / `BlocksPresets.production` starting points. `BlocksStack.create` / `BlocksBackend.create` take a required `defaults` prop; start from a preset and override individual fields with a spread. `defaults` is anchored on the owning `BlocksStack`/`BlocksBackend` (resolved by walking up the construct tree, like `handler`/`executionRole`), so multiple backends in one stack each keep their own posture. Building Blocks read the resolved values via `scope.defaults`, and a per-block option always wins (`option ?? scope.defaults.field`).
  
  Adopted across the stateful Building Blocks: `bb-kv-store`, `bb-data`, `bb-distributed-data`, `bb-distributed-table`, and `bb-knowledge-base` now take their removal policy and deletion protection from `defaults` instead of reading the `sandboxMode` context themselves. (`bb-distributed-table` reads `defaults` directly for now; a richer per-block `protection` override lands with #282.)
  
  The `create-blocks-app` scaffolding templates are updated to pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production` (replacing the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin), so newly-generated apps satisfy the required prop.
  
  **Breaking:** `BlocksStack.create` / `BlocksBackend.create` now require a `defaults` field — pass `BlocksPresets.sandbox` or `BlocksPresets.production` (typically `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`). The previously-shipped experimental `hardening` prop and its `resolve*` helpers are removed; log-retention, API throttling, access-logging and point-in-time-recovery move into `defaults` in follow-up, per-feature changes.
- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-logger@0.1.4

## 0.1.4

### Patch Changes

- 5b2aede: `DistributedTable`: reconcile reads with the schema via a new `readValidation` mode (default `'coerce'`).

  **Behavioral change to the read path (preview).** Writes always validated against `schema`, but reads (`get`, `getBatch`, `query`, `scan`) returned the raw stored value. After a schema change, a row written under the old schema no longer conformed to type `T`: a newly added field was absent from the read (so the value silently violated `T`, and a `.default()` was never applied or persisted on write-back), and a required-no-default field made the read-modify-write cycle (`get()` → mutate → `put()`) throw `ValidationFailed`.

  Reads now reconcile stored items with the schema via `readValidation?: 'off' | 'coerce' | 'strict'`:

  - **`'coerce'`** (default) — apply the schema (fill defaults, narrow types) so legacy rows conform to `T` and round-trip cleanly, **without dropping data**: the coerced output is deep-merged over the raw stored item, so attributes not in the current schema (older-schema fields, columns another writer owns) are preserved rather than silently stripped on a read-modify-write. Arrays are replaced wholesale. On a value that can't be coerced, return the raw value + log a warning — **never throws**.
  - **`'strict'`** — throw `ValidationFailed` on any non-conforming item (opt-in; treats a mismatch as corruption).
  - **`'off'`** — return the raw stored value with no validation (the previous default behavior).

  ```ts
  const orders = new DistributedTable(scope, "orders", {
    schema: orderSchemaV2, // adds `currency: z.string().default('USD')`
    key: { partitionKey: "orderId" },
    // readValidation: 'coerce' is the default
  });
  const order = await orders.get({ orderId: "o1" }); // legacy row → currency: 'USD'
  await orders.put({ ...order, total: 20 }); // conforms to T; round-trips
  ```

  Migration note: the default is now `'coerce'` (previously reads returned raw values). Pass `readValidation: 'off'` to restore raw reads. Coercion is best-effort and validator-dependent — transform-bearing schemas (e.g. Zod) fill defaults and narrow types; check-only Standard Schema validators pass values through unchanged. `null` (a missing item) is untouched in all modes.

- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [2d3dfdc]
- Updated dependencies [3c56267]
  - @aws-blocks/core@0.1.17
  - @aws-blocks/bb-logger@0.1.3

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
