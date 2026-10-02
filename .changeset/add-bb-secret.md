---
"@aws-blocks/bb-secret": minor
"@aws-blocks/blocks": minor
"@aws-blocks/core": patch
---

feat(bb-secret): add the `Secret` Building Block — a single application secret backed by AWS Secrets Manager

Introduces `@aws-blocks/bb-secret`, re-exported from `@aws-blocks/blocks` as `Secret` (and `SecretErrors`, `SecretOptions`). Each instance is one high-value credential — a third-party API key, OAuth client secret, database connection string, webhook signing key, or encryption key — stored in AWS Secrets Manager (distinct from `AppSetting`, which is backed by SSM Parameter Store).

- `get(options?): Promise<T | null>` — reads the value, returning `null` when unset or missing (no throw for not-found). `options.version` reads `'current'` (default), `'previous'` (the value before the last change — a rotation grace window), or a specific `SecretVersion` from `listVersions()`.
- `put(value): Promise<void>` — sets or updates the value at runtime; the prior value becomes the `'previous'` version.
- `listVersions(): Promise<SecretVersionInfo[]>` — lists retained versions (metadata only, newest first — never values); a returned item passes straight to `get({ version })`.
- `Secret.fromExisting(arn)` — reference a secret owned outside the stack (no create/seed/delete/tag; read/write + grant only). The sanctioned path for centrally-managed secrets shared across many installations.
- `name?` — an explicit, well-known Secrets Manager secret name so a team or CI/CD pipeline can set/rotate the value out-of-band via the `aws` CLI; defaults to a name derived from the scope tree.
- Optional `schema` (any StandardSchemaV1 — Zod/Valibot/ArkType) for typed JSON secrets with validation on `get`/`put`.
- `removalPolicy` per-instance override; otherwise follows the stack-wide defaults (production retains, sandbox destroys).

**Versions & rotation.** `get({ version })` + `listVersions()` expose the current/previous values and the retained version list, so a key rollout can validate against the previous value during a grace window. The read surface is an options object with a `SecretVersion` / `SecretVersionInfo` (base/subtype) handle contract, so deeper access can be added non-breaking; anything beyond current/previous is left to the AWS SDK against `secret.secretArn`. Automatic rotation is intentionally out of scope — it is credential-type-specific (AWS ships hosted rotators only for database engines); rotate via `put()`/console/CLI, or drive `put()` from a `CronJob` for a custom schedule.

**Management & lifecycle.** A declaration carries only the name, never the value. Values are set out-of-band via three complementary approaches: auto-generated (random, for opaque values); the built-in `/aws-blocks/settings` route (redirects to the settings resource group in the console when deployed, opens `.bb-data/settings.json` locally); or a well-known `name` + the `aws secretsmanager` CLI for CI/CD. There is intentionally no constructor-time value seeding (no source literals, no env-seeding) — consistent with how hosting `secret()` separates declare from set.

**Resource group + local settings route (`@aws-blocks/core`).** BB-created secrets are tagged `aws-blocks-stack=<stackName>` and the stack's `-settings` resource group now matches `AWS::SecretsManager::Secret` alongside `AWS::SSM::Parameter`, so secrets appear next to `AppSetting` parameters in the console. The local mock persists to the shared `.bb-data/settings.json` (the same file `AppSetting` uses), and the `/aws-blocks/settings` route copy now covers both AppSetting and Secret values — one route for settings and secrets, local and deployed.

The CDK layer provisions one `secretsmanager.Secret`, grants the shared execution role scoped `GetSecretValue` + `PutSecretValue`, requests the Secrets Manager interface VPC endpoint, and passes the ARN to the runtime via `registerConfig` (`BLOCKS_SECRET_ARN_<ID>`). Runtime methods are `synthGuard`-stubbed on the construct. The browser entry throws `NotSupported`. Covered by unit tests (mock + CDK synth) and the shared `test-apps/comprehensive` e2e suite (local/sandbox/production).
