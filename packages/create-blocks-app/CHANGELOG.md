# @aws-blocks/create-blocks-app

## 0.1.21

### Patch Changes

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
- 0ac3879: `sandbox` / `deploy`: fail fast with an actionable message when AWS credentials are missing or expired.
  
  Both commands previously spent ~10 seconds synthesizing the CDK app before the first AWS call, so an unconfigured or expired credential surfaced only afterwards — as an opaque CDK/CloudFormation error that didn't name the real cause. `startSandbox` and `deploy` now run a bounded STS `GetCallerIdentity` check up front and, on a real credential error (missing/expired/invalid), exit immediately with guidance (`aws configure` / `aws sso login`, `AWS_PROFILE`, or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) instead of wasting the synth.
  
  The check is deliberately conservative: it only blocks on a genuine credential error (surfacing the SDK error *name*, never the raw message, which can embed an ARN/account id); a network or service error warns and lets the deploy proceed; and it skips (with a warning) when no region is set in `AWS_REGION` / `AWS_DEFAULT_REGION`, rather than guessing a region in the wrong partition (GovCloud/China). The scaffolded `sandbox` template entrypoint now `.catch`es and exits cleanly, matching `deploy`, so the guidance prints without an unhandled-rejection stack trace.

## 0.1.20

### Patch Changes

- 7b4c62d: Add infrastructure `defaults` chosen once at the app entry point, replacing the per-block `sandboxMode` logic and the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin dance for removal-policy and deletion-protection.
  
  `@aws-blocks/core/cdk` now exports `BlocksDefaults` and the `BlocksPresets.sandbox` / `BlocksPresets.production` starting points. `BlocksStack.create` / `BlocksBackend.create` take a required `defaults` prop; start from a preset and override individual fields with a spread. `defaults` is anchored on the owning `BlocksStack`/`BlocksBackend` (resolved by walking up the construct tree, like `handler`/`executionRole`), so multiple backends in one stack each keep their own posture. Building Blocks read the resolved values via `scope.defaults`, and a per-block option always wins (`option ?? scope.defaults.field`).
  
  Adopted across the stateful Building Blocks: `bb-kv-store`, `bb-data`, `bb-distributed-data`, `bb-distributed-table`, and `bb-knowledge-base` now take their removal policy and deletion protection from `defaults` instead of reading the `sandboxMode` context themselves. (`bb-distributed-table` reads `defaults` directly for now; a richer per-block `protection` override lands with #282.)
  
  The `create-blocks-app` scaffolding templates are updated to pass `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production` (replacing the `RemovalPolicies`/`SandboxDisableDeletionProtection` mixin), so newly-generated apps satisfy the required prop.
  
  **Breaking:** `BlocksStack.create` / `BlocksBackend.create` now require a `defaults` field — pass `BlocksPresets.sandbox` or `BlocksPresets.production` (typically `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`). The previously-shipped experimental `hardening` prop and its `resolve*` helpers are removed; log-retention, API throttling, access-logging and point-in-time-recovery move into `defaults` in follow-up, per-feature changes.
- 6918752: Use the lazy Lambda handler factory in the React template.
- 8966cfb: fix(telemetry): detect Render and Taskcluster as CI
  
  Telemetry CI detection (`isCI()`) checked a fixed list of CI env vars but
  omitted Render and Taskcluster. Render sets `RENDER=true` on every build and
  service; Taskcluster tasks always set the namespaced `TASKCLUSTER_ROOT_URL`.
  Runs on those platforms were therefore reported as real user sessions instead
  of `ci:true`, inflating user metrics. `RENDER` and `TASKCLUSTER_ROOT_URL` are
  now included in both `isCI()` implementations (`@aws-blocks/core` and
  `@aws-blocks/create-blocks-app`). The umbrella `@aws-blocks/blocks` gets a patch
  bump because it re-exports `@aws-blocks/core`.

## 0.1.19

### Patch Changes

- 1e37c67: docs: per-block docs folders + committed BB catalog with CI sync check; CLAUDE/agents docs resolved via require.resolve

  `@aws-blocks/blocks` now ships one docs folder per Building Block under `docs/<block>/`
  (`README.md` / `API.md` / `DESIGN.md`), plus a committed, marker-delimited Building Block
  catalog in the package README that a `sync-docs --check` CI gate keeps in sync. The README's
  catalog section and the scaffolded `AGENTS.md` (`@aws-blocks/create-blocks-app`) now direct
  tools and agents to locate docs programmatically via
  `require.resolve('@aws-blocks/blocks/docs/<block>/README.md')` (and
  `require.resolve('@aws-blocks/blocks/docs/README.md')` for the catalog) rather than assuming a
  `node_modules/` path or following the human-facing relative links. Also adds a Security
  Considerations section to the package README.

## 0.1.18

### Patch Changes

- 75f5446: Add optional `fallback` parameter to `AuthenticatedContent` for rendering alternative content when the user is not authenticated.
- 8264dd0: Add the missing `vendorize` script to the `auth-cognito` template. Every other deployable template shipped `"vendorize": "blocks-vendorize"`, but auth-cognito omitted it, so `npm run vendorize` (used to inline a Building Block's source for customization) didn't work in scaffolded auth-cognito apps. Also adds a regression test asserting every deployable template carries the standard `vendorize` script.

## 0.1.17

### Patch Changes

- 50dbd0e: Include the local dev-server script and use public AWS Blocks imports when adding AWS Blocks to an Amplify Gen 2 project.

## 0.1.16

### Patch Changes

- fc33428: fix(telemetry): inherit worker stderr in debug mode; enable telemetry in CI for create-blocks-app

  - When `NODE_DEBUG=blocks-telemetry` is set, the telemetry worker subprocess
    inherits the parent's stderr so delivery confirmation is observable. Silent
    by default.
  - Remove CI telemetry suppression from create-blocks-app to match core behavior.
    Telemetry is now enabled in CI (same as all other CLI commands).
  - Make `console` cross-platform and headless-safe: pick the OS browser opener
    (`open`/`xdg-open`/`start`), resolve the region from the environment, and treat
    a missing opener (CI / remote shells) as best-effort success instead of failing.
  - Add an isolated E2E telemetry test suite (`test-apps/telemetry`) that verifies
    payload structure, delivery to the real endpoint, disable mechanisms, and
    per-command success/failure events.

## 0.1.15

### Patch Changes

- f6a7fc7: Fix two security defects in the `demo` template:

  - **Set-Cookie header (CRLF) injection**: the public `setCookie` / `deleteCookie` API methods wrote a user-controlled cookie name/value directly into the `Set-Cookie` response header. Cookie name/value components containing CR (`\r`) or LF (`\n`) are now rejected, preventing HTTP response-header injection / response splitting.
  - **Incomplete HTML escaping (XSS)**: the frontend `escapeHtml` helper escaped `&`, `<`, `>`, and `"` but not the single quote (`'`), leaving an XSS gap when interpolating user-controlled values into single-quoted JS/HTML attribute contexts (e.g. `onchange="toggleTodo('...')"`). Single quotes are now escaped to `&#39;`.

- 919d38c: Env-gate the `getLastCode` OTP helper in the `auth-cognito` template so a verification code can never be captured, logged, or returned from a deployed environment.

  The passwordless-OTP demo exposes `api.getLastCode()` (tagged `@blocksSkipCodegen`) so the local UI can read the emailed code without a real mailbox. Its behavior was documented as "no-op in Sandbox/Production" but nothing enforced it — the `codeDelivery` hook captured the code and the method returned it unconditionally, so a live OTP could leak in a deployed environment. Both the capture and the read are now gated inline on `!process.env.BLOCKS_STACK_NAME` — the marker BlocksBackend injects into every deployed Blocks Lambda and leaves unset in local/mock dev, matching how the framework's generated DB connection resolver distinguishes deployed vs. local. The code is returned in local/mock dev and `null` in a deployed environment.

## 0.1.14

### Patch Changes

- a1de3b8: Fix + polish for `create-blocks-app`:

  - Reject `--template amplify` on a fresh directory up front with a
    helpful message pointing at `--template default` (for a fresh app)
    or the no-arg command (to integrate Blocks into an existing Amplify
    Gen 2 project). The `amplify` template is an overlay auto-selected
    when the CLI detects `amplify/backend.ts`, not a scaffoldable
    starter. Previously the fresh-scaffold path with `--template amplify`
    crashed mid-copy on missing template files.
  - Correct two template descriptions that misstated the frontend:
    `auth-cognito` and `demo` were labeled "Vite + lit-html" but both
    ship a Vite + vanilla-DOM frontend. Descriptions now read
    "Vite + vanilla-DOM frontend with Cognito passwordless email-OTP
    auth end-to-end" and "Fuller example — AuthBasic + KVStore +
    DynamoDB priority-sorted todo (Vite, vanilla-DOM)" respectively.

- 3c365e3: Sanitize user-controlled values in demo template innerHTML assignments
- a1de3b8: Improve `--help` output for `create-blocks-app`:

  - Template discovery is now filesystem-driven — drop a folder under `templates/` with a `package.json` and it auto-registers.
  - `--help` now lists every template with a one-line description, sourced from each template's `blocksTemplateDescription` field.
  - Added `--yes --template nextjs` to the Examples section.

## 0.1.13

### Patch Changes

- e839301: fix: stack-scope the external-DB connection-string SSM parameter to prevent multi-app collision

  The external-database connection string was stored in an SSM parameter named only
  by stage (`/blocks/{stage}/db-connection-string`), so two Blocks apps deployed to
  the same AWS account + region + stage computed the same name and silently
  overwrote each other's credentials.

  The parameter name is now stack-scoped (`/<stackName>-db-url`), derived from a
  single new `getStackName({ sandbox, projectRoot })` helper that is also the one
  place the CDK templates compute the stack name (replacing logic duplicated across
  templates). The same `dbConnectionParameterName(stackName)` — fed the stack name
  from `getStackName({ sandbox, projectRoot })` — is used
  by the pre-deploy writer (`ensureSecrets`) and by the `db pull` generated wiring at
  synth, so the written name and the read name are derived once, from committed
  config (`.blocks/config.json`) — never from the connection string — and cannot
  diverge. The name is computable before synth (enabled by the committed stackId from
  PR #51), so no post-deploy write-back or staging-copy machinery is needed.

  The previous stage-only parameter is orphaned and self-heals on the next deploy.

## 0.1.12

### Patch Changes

- ec1fc6c: Fix multi-tenant data leak in demo template: `listTodos()` no longer falls back to `scan()` when no `sortBy` is provided. All paths now use `query()` with a `userId` filter, ensuring users only see their own todos.

## 0.1.11

### Patch Changes

- a23b1fb: fix(create-blocks-app): serve the react template from a single-origin front door

  The `react` template was the only SPA template without a single-origin dev
  front door: its `server.ts` ran the backend on `:3001` and `package.json`
  used `concurrently` to start Vite on a separate `:3000` origin, with no
  `/aws-blocks` proxy in `vite.config.ts`. As a result `/aws-blocks/*` — including
  the server-initiated OIDC redirect routes (`/aws-blocks/auth/signin/*`) — was
  not reachable from the SPA origin, breaking any browser-navigation auth flow
  (e.g. OIDC) locally.

  The template now matches every other SPA template: `startDevServer` runs Vite
  via `frontendCommand` and exposes a unified front door on `:3000` (backend +
  SPA same origin), and `npm run dev` runs the single dev server. This unblocks
  OIDC / browser-navigation auth in the react template. Surfaced by the agent-bench.

## 0.1.10

### Patch Changes

- f42c604: fix: generate unique stackId in .blocks/config.json, export getStackId/getSandboxId from @aws-blocks/blocks/scripts

  Stack names are now derived from a `stackId` in `.blocks/config.json`, generated at scaffold time as `<name>.slice(0,16)-<random6>`. Templates import `getStackId()` and `getSandboxId()` from `@aws-blocks/blocks/scripts` — no more inline filesystem logic in `index.cdk.ts`.

  Production: `<stackId>-prod`
  Sandbox: `<stackId>-<username(8)>-<random(6)>` (per-machine, gitignored)

## 0.1.9

### Patch Changes

- 95efe42: Honor `--skip-install` when creating a fresh project so scaffolding can complete without running `npm install`.

## 0.1.8

### Patch Changes

- 6c7bb69: fix(create-blocks-app): respect `--template` when adding Blocks to an existing project

  Adding Blocks to an existing project always copied the `aws-blocks/` workspace from
  the `default` (Vite) template, ignoring `--template`. Running
  `npm create @aws-blocks/blocks-app . -- --template nextjs` in a Next.js project
  therefore generated a `scripts/server.ts` whose `frontendCommand` was `npx vite ...`
  instead of `npx next dev ...`, so `npm run dev:server` tried to launch Vite in a
  project without it.

  The requested template now drives the copied `aws-blocks/` workspace, `cdk.json`, and
  devDeps.

## 0.1.7

### Patch Changes

- a98fa95: fix(create-blocks-app): bump `aws-cdk-lib` to `^2.257.0` in the react template

  The react template pinned `aws-cdk-lib` to `2.245.0`, while every block (e.g. `@aws-blocks/bb-realtime`) declares a peer dependency of `aws-cdk-lib@^2.257.0`. The unmet peer caused npm to nest `@aws-blocks/bb-realtime` under `@aws-blocks/blocks/node_modules` instead of hoisting it to the top level. Because the generated `aws-blocks/client.js` imports `@aws-blocks/bb-realtime/mock-middleware` directly from the workspace, Vite failed to resolve it (`Failed to resolve import "@aws-blocks/bb-realtime/mock-middleware"`) and `npm run dev` broke. Aligning the version with the other templates (`^2.257.0`) satisfies the peer dependency so the block hoists correctly.

## 0.1.6

### Patch Changes

- 3d670a9: Report a clear error when `--template` is missing its template name instead of treating the flag as an unknown option or consuming another option as the template value.

## 0.1.5

### Patch Changes

- b8a03a4: Validate unknown `--template` values before reading template metadata so the CLI reports the intended `Unknown template` message instead of a file-system error.

## 0.1.4

### Patch Changes

- ba577bb: List the available starter templates in `create-blocks-app --help` so users can discover valid `--template` values directly from the CLI.

## 0.1.3

### Patch Changes

- bbf0c4a: Add the missing `/.blocks-sandbox/config.json` route handler to the Next.js template so the browser client can discover the API URL.

## 0.1.2

### Patch Changes

- 7b80811: Add in-repo Building Block docs discoverability.

  The `@aws-blocks/blocks` package now ships a `docs/` folder containing every Building Block README (one per block) plus a generated `index.md` with a decision tree and catalog. This gives humans and AI agents a single, stable path to all block documentation — `node_modules/@aws-blocks/blocks/docs/` — instead of scattering them across 19+ individual package paths.

  - `@aws-blocks/blocks`: adds `docs/` to the published package (assembled at build time via `scripts/sync-block-docs.mjs`). README expanded to be a comprehensive guide (architecture, workflow, best practices, common mistakes).
  - `@aws-blocks/create-blocks-app`: AGENTS.md templates updated to point to the blocks README and docs folder as the canonical entry points.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements

## 0.1.0

Initial version
