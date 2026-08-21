---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
"@aws-blocks/pipeline": minor
"@aws-blocks/create-blocks-app": patch
---

Add `secret()` / `config()` support to hosting and pipeline for self-hosted deployments — externalized values that are never hardcoded in source, committed to git, or written into the CloudFormation template.

**Two intent functions; the store is implied by which you call.**

- **`secret('KEY')` → AWS Secrets Manager** — for sensitive values (API keys, tokens, credentials).
- **`config('KEY')` → SSM Parameter Store** (free tier) — for non-sensitive externalized values (feature flags, a custom domain, a connection ARN).

The developer never selects a store; it is derived from the function (`storeForKind`), so the CLI write, the IAM grant, the synth-time fetch, and the runtime read can never disagree.

**Runtime read — two getters, one per store.** `getSecret('KEY')` reads Secrets Manager; `getConfig('KEY')` reads SSM. Each reads its own injected locator env var (`HOSTING_SECRET_PARAM_<KEY>` vs `HOSTING_CONFIG_PARAM_<KEY>`), so the store is unambiguous. Both read `process.env.KEY` first, so **local dev needs no AWS** (put the value in a `.env` file). Values are fetched + decrypted on first use, cached (per-kind `cacheTtlSeconds` for rotation without a cold start; otherwise cached for the process lifetime), and never enter the template. The getters live in `@aws-blocks/hosting` / the CDK-free `@aws-blocks/hosting/secret` subpath (import them there — `@aws-blocks/core` already exports a backend `getConfig`).

**CDK wiring.** In `Hosting` `environment` (and `domain`) a `secret()`/`config()` marker injects only the store *locator* and grants the compute role least-privilege read (`secretsmanager:GetSecretValue` / `ssm:GetParameter`, scoped to the exact ARN) + `kms:Decrypt` (conditioned on `kms:ViaService`). When a `stage` is set the grant covers BOTH the stage locator `<prefix>/<stage>/<key>` and the shared fallback `<prefix>/<key>` (the fallback read is what lets a stage fall back to a shared value), so treat the shared entry as readable by every stage sharing that prefix. A **synth-time** position — `domain.domainName` — accepts only `config()` (or a plain string), never `secret()`: the value is resolved via an SDK read and **inlined as a literal into the template** (a domain must be a literal before CloudFront/ACM), so a secret there would defeat its own purpose; a domain is public anyway. Synth resolution is async, so use `await Hosting.create(...)`. (Runtime `environment` markers still accept both `secret()` and `config()` — those inject only the locator and never inline.) Per-kind namespace/cache config is set via the separate `secretStore` / `configStore` props (`{ prefix, stage, cacheTtlSeconds }`), defaulting to the neutral `/hosting/secrets` and `/hosting/config` prefixes.

**Namespacing (avoid cross-app collisions).** A **Blocks** app is scoped automatically: the `Hosting` / `Pipeline` blocks and the `npm run secret` / `config` CLIs default to `/blocks/<stackId>/secrets` and `/blocks/<stackId>/config`, where `stackId` is the app's stable id from the committed `.blocks/config.json`. Both the CLI and the CDK synth read that same file, so two Blocks apps in one account/region never collide, and the write and the read can never diverge (when the file is absent — e.g. a bare test — both sides fall back to the unscoped `/blocks/*` identically). `stackId` is stage-independent (prod and sandbox share it; use the opt-in `stage` segment for per-stage values). A **standalone** hosting/pipeline app (the framework-neutral leaf) has no `.blocks/config.json`, so its defaults (`/hosting/secrets`, `/hosting/config`) stay account-global — give each app its own `secretStore.prefix` / `configStore.prefix` (and matching CLI `--prefix`) when more than one deploys to an account. Use `--region` (or `AWS_REGION`) to write the value in the same region the app deploys to.

**Bring-your-own (BYO).** `environment` (hosting) and `buildSecrets` (pipeline) also accept an existing CDK `ISecret` / `IParameter` handle alongside the managed markers: the construct grants read via the handle and injects its locator, so `getSecret`/`getConfig` resolve it identically — managed *provisions*, BYO *references*.

**Pipeline.** `source.connectionArn` accepts a `config()` marker (resolved to a literal at synth; a connection ARN is a reference inlined into the template, so `secret()` is a type error there — same rule as `domain`). `buildSecrets` accepts `secret()` markers or BYO `ISecret` handles and wires them as CodeBuild `SECRETS_MANAGER` env vars fetched at build time (masked in logs, never inlined) — build-time credentials are secrets, so this surface is Secrets-Manager-only. Namespace config via `secretStore` / `configStore`.

**CLI.** `secret set|list|remove` (Secrets Manager) and `config set|list|remove` (SSM), sharing one engine (`setValue`/`listValues`/`removeValue`/`runValueCli`). Blocks apps get `npm run secret` / `npm run config` (scoped per app to `/blocks/<stackId>/secrets` and `/blocks/<stackId>/config`); standalone/pipeline apps get the `hosting-secret` and `hosting-config` bins. A **secret** value is never read from argv/shell history — `secret set` takes it from a hidden prompt or `--value-stdin` (a positional value is a hard error); a non-sensitive **config** value may be passed positionally. `list` prints names only, never values. All commands accept `--prefix`, `--stage`, and `--region` (write to the same region the app deploys to).

**Templates.** `@aws-blocks/create-blocks-app` templates scaffold a `secret` script (`npm run secret`) wired to the Blocks CLI, so a newly-created app can manage secrets out of the box.
