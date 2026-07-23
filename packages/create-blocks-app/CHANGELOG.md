# @aws-blocks/create-blocks-app

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
