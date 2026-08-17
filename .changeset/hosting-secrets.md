---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
"@aws-blocks/pipeline": minor
---

Add `secret()` / `config()` support to hosting and pipeline for self-hosted deployments — externalized values that are never hardcoded in source, committed to git, or written into the CloudFormation template.

**Two intent functions; the store is implied by which you call.**

- **`secret('KEY')` → AWS Secrets Manager** — for sensitive values (API keys, tokens, credentials).
- **`config('KEY')` → SSM Parameter Store** (free tier) — for non-sensitive externalized values (feature flags, a custom domain, a connection ARN).

The developer never selects a store; it is derived from the function (`storeForKind`), so the CLI write, the IAM grant, the synth-time fetch, and the runtime read can never disagree.

**Runtime read — two getters, one per store.** `getSecret('KEY')` reads Secrets Manager; `getConfig('KEY')` reads SSM. Each reads its own injected locator env var (`HOSTING_SECRET_PARAM_<KEY>` vs `HOSTING_CONFIG_PARAM_<KEY>`), so the store is unambiguous. Both read `process.env.KEY` first, so **local dev needs no AWS** (put the value in a `.env` file). Values are fetched + decrypted on first use, cached (per-kind `cacheTtlSeconds` for rotation without a cold start; otherwise cached for the process lifetime), and never enter the template. The getters live in `@aws-blocks/hosting` / the CDK-free `@aws-blocks/hosting/secret` subpath (import them there — `@aws-blocks/core` already exports a backend `getConfig`).

**CDK wiring.** In `Hosting` `environment` (and `domain`) a `secret()`/`config()` marker injects only the store *locator* and grants the compute role least-privilege read on that one resource (`secretsmanager:GetSecretValue` / `ssm:GetParameter`, scoped to the exact ARN) + `kms:Decrypt` (conditioned on `kms:ViaService`). A `domain` marker resolves at **synth time** via an SDK read and is inlined (a domain must be a literal before CloudFront/ACM) — async, so use `await Hosting.create(...)`. Per-kind namespace/cache config is set via the separate `secretStore` / `configStore` props (`{ prefix, stage, cacheTtlSeconds }`), defaulting to the neutral `/hosting/secrets` and `/hosting/config` prefixes.

**Bring-your-own (BYO).** `environment` (hosting) and `buildSecrets` (pipeline) also accept an existing CDK `ISecret` / `IParameter` handle alongside the managed markers: the construct grants read via the handle and injects its locator, so `getSecret`/`getConfig` resolve it identically — managed *provisions*, BYO *references*.

**Pipeline.** `source.connectionArn` accepts a `secret()` or `config()` marker (resolved to a literal at synth). `buildSecrets` accepts `secret()` markers or BYO `ISecret` handles and wires them as CodeBuild `SECRETS_MANAGER` env vars fetched at build time (masked in logs, never inlined) — build-time credentials are secrets, so this surface is Secrets-Manager-only. Namespace config via `secretStore` / `configStore`.

**CLI.** `secret set|list|remove` (Secrets Manager) and `config set|list|remove` (SSM), sharing one engine (`setValue`/`listValues`/`removeValue`/`runValueCli`). Blocks apps get `npm run secret` / `npm run config` (pinned to `/blocks/secrets` and `/blocks/config`); standalone/pipeline apps get the `hosting-secret` and `hosting-config` bins. `set` reads the value from a hidden prompt or `--value-stdin` (never argv/shell history); `list` prints names only, never values.

Also fixes a latent pipeline bug: stage-stack validation now uses `cdk.Stack.isStack()` instead of `instanceof cdk.Stack`, so a consumer resolving a different `aws-cdk-lib` copy (monorepo / linked-package installs) is no longer misdetected as "no stacks in stage".
