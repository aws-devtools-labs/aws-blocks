---
"@aws-blocks/bb-secret": minor
"@aws-blocks/blocks": minor
"@aws-blocks/core": patch
---

feat(bb-secret): add the `Secret` Building Block — a single application secret backed by AWS Secrets Manager

Introduces `@aws-blocks/bb-secret`, re-exported from `@aws-blocks/blocks` as `Secret` (and `SecretErrors`, `SecretOptions`). Each instance is one high-value credential — a third-party API key, OAuth client secret, database connection string, webhook signing key, or encryption key — stored in AWS Secrets Manager (distinct from `AppSetting`, which is backed by SSM Parameter Store).

- `get(): Promise<T | null>` — reads the value, returning `null` when unset or missing (no throw for not-found).
- `put(value): Promise<void>` — sets or updates the value at runtime.
- `Secret.fromExisting(arn)` — wrap a secret owned outside the stack (no create/seed/delete; read/write + grant only).
- Optional `schema` (any StandardSchemaV1 — Zod/Valibot/ArkType) for typed JSON secrets with validation on `get`/`put`.
- `removalPolicy` per-instance override; otherwise follows the stack-wide defaults (production retains, sandbox destroys).

The CDK layer provisions one `secretsmanager.Secret` (name derived from `fullId`), grants the shared execution role scoped `secretsmanager:GetSecretValue` + `PutSecretValue`, requests the Secrets Manager interface VPC endpoint, and passes the ARN to the runtime via `registerConfig` (`BLOCKS_SECRET_ARN_<ID>`). Runtime methods are `synthGuard`-stubbed on the construct. The local mock persists plaintext under `.bb-data` (dev only) and the browser entry throws `NotSupported`. Covered by unit tests (mock + CDK synth) and the shared `test-apps/comprehensive` e2e suite (local/sandbox/production).
