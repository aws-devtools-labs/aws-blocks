---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
---

Add `secret()` support to hosting for self-hosted deployments.

Introduces a `secret()` reference for sensitive values (API keys, third-party credentials, custom domains) backed by an SSM Parameter Store SecureString — so they're never hardcoded in source, committed to git, or written into the CloudFormation template.

- **`secret('KEY')` marker** — exported from `@aws-blocks/hosting` (and re-exported from `@aws-blocks/core` / `@aws-blocks/blocks`). A dependency-free value object so it can later be shared with `@aws-blocks/pipeline` without a dependency cycle. Pass it into `Hosting` props.
- **Two resolution strategies, chosen per prop:**
  - `compute.environment` values resolve at **runtime** (the secure default): the SSM parameter *name* (never the value) is injected as `BLOCKS_SECRET_PARAM_<KEY>`, the compute role is granted `ssm:GetParameter` (scoped to that one ARN) + `kms:Decrypt` (conditioned on `kms:ViaService`), and the value is fetched + decrypted on first use via `getSecret('KEY')`. The secret stays encrypted at rest and never enters the template.
  - `domain.domainName` and `secret(..., { exposeAsEnv: true })` resolve at **synth time** via an SDK `GetParameter(WithDecryption)` call and are inlined as literals. `ssm-secure` CloudFormation dynamic references are restricted to an allowlist that excludes CloudFront `Aliases` and Lambda env vars, so synth-time SDK resolution is the correct mechanism; a domain is public anyway. Synth-time resolution is async — use the new `await Hosting.create(scope, id, props)`.
- **`getSecret('KEY')` runtime resolver** — reads `process.env.KEY` first (local dev / `exposeAsEnv`), else fetches + decrypts the injected SSM parameter, caching per cold start and coalescing concurrent calls. Mirrors the existing `AppSetting` / external-DB connection-string pattern.
- **`secret` CLI** (`runSecretCli`, `setSecret`, `listSecrets`, `removeSecret`) — `blocks secret set/list/remove` manage SecureStrings at `/blocks/secrets/<KEY>` (flat namespace, 1:1 key↔reference, no stage scoping). `list` returns names only, never values. Wired into the Next.js template as `npm run secret`.

Path convention is centralized in `secretParameterName()` (`/blocks/secrets/<KEY>`), alongside the existing `/blocks/{stage}/db-connection-string`. Backward compatible: `new Hosting(...)` keeps working for plain config and runtime secrets; only synth-time secrets require `Hosting.create()`.
