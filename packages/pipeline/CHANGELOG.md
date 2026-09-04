# @aws-blocks/pipeline

## 0.2.1

### Patch Changes

- 5960fa4: Pipeline: reject invalid stage names at synth instead of failing minutes into deploy.
  
  A stage name becomes a prefix of the derived CloudFormation stack name (`<stageName>-<stackId>`), which CloudFormation requires to match `/^[A-Za-z][A-Za-z0-9-]*$/`. `validateStageName` previously allowed underscores (and leading digits), so a stage named e.g. `qa_east` passed validation but produced a stack name (`qa_east-App`) that CloudFormation rejects only after provisioning starts. It now enforces the stack-name contract up front and throws at synth with an actionable message and a suggested valid name (e.g. `qa-east`).
- Updated dependencies [1da58fd]
  - @aws-blocks/hosting@0.2.1

## 0.2.0

### Minor Changes

- 9d4ccea: Add `secret()` / `config()` support to hosting and pipeline for self-hosted deployments — externalized values that are never hardcoded in source, committed to git, or written into the CloudFormation template.
  
  **Two intent functions; the store is implied by which you call.**
  
  - **`secret('KEY')` → AWS Secrets Manager** — for sensitive values (API keys, tokens, credentials).
  - **`config('KEY')` → SSM Parameter Store** (free tier) — for non-sensitive externalized values (feature flags, a custom domain, a connection ARN).
  
  The developer never selects a store; it is derived from the function (`storeForKind`), so the CLI write, the IAM grant, the synth-time fetch, and the runtime read can never disagree.
  
  **Runtime read — two getters, one per store.** `getSecret('KEY')` reads Secrets Manager; `getConfig('KEY')` reads SSM. Each reads its own injected locator env var (`HOSTING_SECRET_PARAM_<KEY>` vs `HOSTING_CONFIG_PARAM_<KEY>`), so the store is unambiguous. Both read `process.env.KEY` first, so **local dev needs no AWS** (put the value in a `.env` file). Values are fetched + decrypted on first use, cached (per-kind `cacheTtlSeconds` for rotation without a cold start; otherwise cached for the process lifetime), and never enter the template. The getters live on the **CDK-free `@aws-blocks/hosting` entry** — the value API (`secret`/`config`/`getSecret`/`getConfig`) is the package's `.`, and its module graph pulls in no CDK, no `fast-glob`, and no `node:fs`, so importing it into an SSR/runtime bundle (including the edge runtime) is safe. Build-time tooling lives off `.` so it never enters a runtime bundle: the CDK construct + resolution engine on `@aws-blocks/hosting/constructs`, and the CLI + typegen engines on `@aws-blocks/hosting/scripts`. (`@aws-blocks/core` already exports a backend `getConfig`, so import the hosting getters from `@aws-blocks/hosting`.)
  
  **CDK wiring.** In `Hosting` `environment` (and `domain`) a `secret()`/`config()` marker injects only the store *locator* and grants the compute role least-privilege read (`secretsmanager:GetSecretValue` / `ssm:GetParameter`, scoped to the exact ARN) + `kms:Decrypt` (conditioned on `kms:ViaService`). When a `stage` is set the grant covers BOTH the stage locator `<prefix>/<stage>/<key>` and the shared fallback `<prefix>/<key>` (the fallback read is what lets a stage fall back to a shared value), so treat the shared entry as readable by every stage sharing that prefix. A **synth-time** position — `domain.domainName` — accepts only `config()` (or a plain string), never `secret()`: the value is resolved via an SDK read and **inlined as a literal into the template** (a domain must be a literal before CloudFront/ACM), so a secret there would defeat its own purpose; a domain is public anyway. Synth resolution is async, so use `await Hosting.create(...)`. (Runtime `environment` markers still accept both `secret()` and `config()` — those inject only the locator and never inline.) Per-kind namespace/cache config is set via the separate `secretStore` / `configStore` props (`{ prefix, stage, cacheTtlSeconds }`), defaulting to the neutral `/hosting/secrets` and `/hosting/config` prefixes.
  
  **Namespacing (avoid cross-app collisions).** A **Blocks** app is scoped automatically: the `Hosting` / `Pipeline` blocks and the `npm run secret` / `config` CLIs default to `/blocks/<stackId>/secrets` and `/blocks/<stackId>/config`, where `stackId` is the app's stable id from the committed `.blocks/config.json`. Both the CLI and the CDK synth read that same file, so two Blocks apps in one account/region never collide, and the write and the read can never diverge (when the file is absent — e.g. a bare test — both sides fall back to the unscoped `/blocks/*` identically). `stackId` is stage-independent (prod and sandbox share it; use the opt-in `stage` segment for per-stage values). A **standalone** hosting/pipeline app (the framework-neutral leaf) has no `.blocks/config.json`, so its defaults (`/hosting/secrets`, `/hosting/config`) stay account-global — give each app its own `secretStore.prefix` / `configStore.prefix` (and matching CLI `--prefix`) when more than one deploys to an account. Use `--region` (or `AWS_REGION`) to write the value in the same region the app deploys to.
  
  **Bring-your-own (BYO).** `environment` (hosting) and `buildSecrets` (pipeline) also accept an existing CDK `ISecret` / `IParameter` handle alongside the managed markers: the construct grants read via the handle and injects its locator, so `getSecret`/`getConfig` resolve it identically — managed *provisions*, BYO *references*.
  
  **Pipeline.** `source.connectionArn` accepts a `config()` marker (resolved to a literal at synth; a connection ARN is a reference inlined into the template, so `secret()` is a type error there — same rule as `domain`). `buildSecrets` accepts `secret()` markers or BYO `ISecret` handles and wires them as CodeBuild `SECRETS_MANAGER` env vars fetched at build time (masked in logs, never inlined) — build-time credentials are secrets, so this surface is Secrets-Manager-only. Namespace config via `secretStore` / `configStore`.
  
  **CLI.** `secret set|list|remove` (Secrets Manager) and `config set|list|remove` (SSM), sharing one engine (`setValue`/`listValues`/`removeValue`/`runValueCli`). Blocks apps get `npm run secret` / `npm run config` (scoped per app to `/blocks/<stackId>/secrets` and `/blocks/<stackId>/config`); standalone/pipeline apps get the `hosting-secret` and `hosting-config` bins. A **secret** value is never read from argv/shell history — `secret set` takes it from a hidden prompt or `--value-stdin` (a positional value is a hard error); a non-sensitive **config** value may be passed positionally. `list` prints names only, never values. All commands accept `--prefix`, `--stage`, and `--region` (write to the same region the app deploys to).
  
  **Type-safe reads (zero code) — `getSecret` / `getConfig` autocomplete + typo errors.** The runtime getters are typed against two augmentable registries (`HostingSecretRegistry` / `HostingConfigRegistry`): empty by default they accept any `string` (unchanged, non-breaking), and once populated they narrow to your declared keys — editor autocomplete, and a typo (or reading a `config` key via `getSecret`, i.e. the wrong store) becomes a compile error. You populate them with **no code change** via the new `hosting-typegen` CLI (`npm run typegen`, `--watch` to regenerate on save, `--check` for CI): it statically scans your `secret('...')` / `config('...')` calls (TypeScript compiler API — no app execution, no AWS credentials) and generates a `.d.ts` (`.blocks/hosting-values.d.ts`) that augments the `@aws-blocks/hosting` entry (where the getters live), narrowing them to your declared keys. The generated file is derived from your `secret()`/`config()` calls, and `--check` fails CI when it's stale. Add `.blocks/**/*.d.ts` to your tsconfig `include`. In a Blocks app this is automatic: the dev server (`npm run dev`) auto-detects `secret()`/`config()` usage and runs the generate-and-watch step itself (a no-op when the app declares no secrets, and non-fatal), so keys update as you type with no second command; standalone hosting apps use `hosting-typegen --watch`.
  
  **Typed, parsed values via a schema.** `secret('KEY', { schema })` / `config('KEY', { schema })` accept any Standard Schema (Zod, Valibot, ArkType — typed as `StandardSchemaV1`, library-neutral). `typegen` builds a TypeScript `Program`, infers the schema's output type, and inlines it into the generated `.d.ts`, so **`getSecret`/`getConfig` return the inferred type** (e.g. `const { beta } = await getConfig('FEATURE_FLAGS')`) instead of `string` — no `JSON.parse(...)` and no `any`. At runtime the value is JSON-parsed (a per-key flag is injected at synth); the schema itself isn't shipped to the runtime, so this is parse-to-type, not a deep re-validation across the bundle boundary.
  
  **Templates.** `@aws-blocks/create-blocks-app` templates scaffold a `secret` script (`npm run secret`) wired to the Blocks CLI, and a `typegen` script (`npm run typegen` → `runTypegenCli` from `@aws-blocks/blocks/scripts`) with `.blocks/**/*.d.ts` added to the tsconfig `include`, so a newly-created app can manage secrets and get type-safe `getSecret`/`getConfig` out of the box.

### Patch Changes

- 947a1bd: Fix `Pipeline.create()` failing with "stage '<name>' contains no stacks" when the
  consumer app resolves a different `aws-cdk-lib` copy than `@aws-blocks/pipeline`
  (monorepo, linked-package, or `file:` installs — e.g. an Amplify self-hosting app).
  
  `validateStageStacks` detected a stage's stacks with `instanceof cdk.Stack`, which
  returns `false` across module copies — so a `stageFactory` that *did* create a
  `Stack` was misdetected as empty and synth aborted. It now uses
  `cdk.Stack.isStack()`, which matches on a shared `Symbol.for` marker and is
  cross-copy-safe.
- Updated dependencies [9d4ccea]
  - @aws-blocks/hosting@0.2.0

## 0.1.1

### Patch Changes

- e98bab4: feat(pipeline): extract Pipeline construct into @aws-blocks/pipeline package, add partialBuildSpec for CodeBuild runtime control

  `@aws-blocks/core` receives a minor bump (not patch): it gains a new runtime dependency on `@aws-blocks/pipeline` and adds new public re-exports from its CDK entrypoint (`__PIPELINE_STAGE_SCOPE__`, `Pipeline`, `DeployStage`, and the pipeline configuration types). New backwards-compatible public surface is a minor change per semver.
