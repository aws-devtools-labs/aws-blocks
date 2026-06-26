# Architectural Decisions

This document records significant decisions made during AWS Blocks development, including rationale and alternatives considered. This document should be updated when the technical design changes.

## Format

Each decision follows this structure:

```
## D-[ID]: [Brief Title]

**Date**: YYYY-MM-DD
**Authors:** ____ (Who authored this decision.)

### Context
[What's the issue we're addressing]

### Decision
[What we decided to do]

### Rationale
[Why we chose this approach]

### Alternatives Considered
[What else we looked at and why we didn't choose it]

### References
[Links to discussions, RFCs, etc]
```

## Decisions

## D-001: Mock data stored in `.bb-data/{fullId}/` via `getMockDataDir()`

**Date**: 2026-03-31
**Authors:** wirej

### Context
Building Block mocks need persistent local storage. The POC used in-memory Maps (lost on restart) and the design docs referenced `./bb-data/{fullId}.json` as flat files. We needed a consistent, discoverable convention.

### Decision
All BB mock data lives under `.bb-data/` at the project root. Each BB gets its own subdirectory at `.bb-data/{scope.fullId}/` and decides what files to put inside. `core` exports `getMockDataDir(scope)` which returns the path and creates the directory if needed.

### Rationale
- `.bb-data` follows the dotfolder convention used by frameworks (Nuxt uses `.nuxt`, Next.js uses `.next`, Wrangler uses `.wrangler`)
- Per-BB subdirectories avoid filename collisions and let BBs store multiple files (e.g., Database needs WAL files alongside the DB)
- The utility creates the directory so BBs don't duplicate `mkdirSync` boilerplate
- `getMockDataDir` takes a `Scope` (not a string) to keep the API type-safe and avoid callers constructing paths manually

### Alternatives Considered
- `bb-data/` (flat, no dot prefix) — less idiomatic, visible clutter in project root
- `.blocks/data/` — extra nesting for no benefit
- `mockDataPath(fullId, suffix)` returning a file path with suffix — pushed file naming decisions into the utility; BBs should own their folder contents
- `this.mockDataPath()` on `Scope` — wrong because CDK and AWS runtime also extend Scope; mock-only method doesn't belong on the base class

## D-002: BB documentation ships as README.md + DESIGN.md

**Date**: 2026-03-31
**Authors:** wirej
**Status**: Amended by [D-008](#d-008-bb-documentation-follows-a-progressive-disclosure-model-readme-entry-point--task-scoped-references) (2026-06-09, pranavosu) — the fixed two-file rule was generalized to a progressive-disclosure model that allows additional task-scoped reference docs. The decision below is preserved as originally written.

### Context
The tech design described three documentation artifacts (preliminary design docs, agent-facing `docs/` folder with progressive disclosure, and JSDoc) with unclear relationships. The umbrella package was copying BB READMEs into `dist/docs/` as a workaround for monorepo symlink issues.

### Decision
Each BB package ships two files:
- **`README.md`** — usage doc for agents and humans (API, examples, best practices, scaling/cost). Since README.md is the natural entry point for any package, it's a good fit for the primary doc — reducing extra hops while clearly separating customer-facing content from internal design.
- **`DESIGN.md`** — infrastructure details, mock parity gaps, serialization, interface decisions. For extenders and advanced customers. Ships via `"files"` in package.json.

The preliminary design doc (`docs/tech-design/BB-*.md`) becomes a redirect to the package's README and DESIGN once implemented. The `copy-docs.mjs` script was removed.

### Rationale
- README.md is already the standard entry point agents and humans look for — using it as the primary doc reduces discovery friction
- Design details (parity gaps, CDK config) are useful for extenders but not for app developers — separate file keeps README focused
- Removing copy-docs eliminates stale copies and build complexity

### Alternatives Considered
- `docs/` subfolder with progressive files (API.md, BEST_PRACTICES.md, SCALING.md) — fragments information across many files, increases hops
- Moving design doc into the package as the README — conflates two audiences (app developers vs BB authors)
- Keeping design docs only in `docs/tech-design/` — not available in `node_modules` for extenders

## D-003: BB error `name` propagates over the wire

**Date**: 2026-04-01
**Authors:** wirej

### Context
Section 11 originally chose not to send `error.name` over the wire, arguing it would leak DynamoDB internals. In practice, this meant the client only received a message string and HTTP status code. E2e tests had to match on brittle message text (`/conditional request failed/i`), and frontend code couldn't distinguish between different BB error types without parsing messages. This contradicted the "just calling code" DX goal — customers shouldn't need HTTP status codes at the top of their minds.

### Decision
The wire format now carries `name` (the BB-level error name) alongside `message` and HTTP status. The handler serializes `{ error, name }` with the appropriate status code. The client proxy reconstructs an `ApiError` with `.name` set to the BB error name. `Error.cause` stays server-side. `isBlocksError()` checks `error.name` on both sides — same field, same call, same behavior regardless of context.

### Rationale
- BB error names (`ConditionalCheckFailedException`) are AWS Blocks' own abstraction — not raw AWS internals. They're the same constants customers use in `isBlocksError()` on the server.
- Using `.name` consistently (not a separate `.code` field) means the same `isBlocksError` call works identically on server and client.
- Unhandled errors (plain `Error` with no custom `.name`) still serialize as generic 500s with no name — the safety net against leaking internals is preserved.
- `cause` (ES2022 `Error.cause`) never crosses the wire — it's for server-side debugging only.

### Alternatives Considered
- Keep stripping `error.name` (original design) — forces brittle message matching or HTTP status code branching on the client
- Use a separate `.code` property on `ApiError` — introduces inconsistency between server (`.name`) and client (`.code`) for the same concept

### References
- Section 11 "Alternatives Considered" updated with reversal note
- Implementation: `ApiError` class + `isBlocksError` in `core/errors.ts`, handler changes in `dev-server.ts` and `lambda-handler.ts`, client proxy in `client/index.ts`

## D-004: Auth-first naming convention for auth Building Blocks

**Date**: 2026-04-07
**Authors:** Jon Wire

### Context
Auth Building Blocks span multiple packages (`AuthBasic`, `AuthOIDC`, `AuthCognito`) and share a common interface. We needed a naming convention for the classes, types, and packages.

### Decision
Use **auth-first** naming: the word `Auth` comes first in all auth-related identifiers.

- Classes: `AuthBasic`, `AuthOIDC`, `AuthCognito`
- Types: `AuthBasicUser`, `AuthBasicOptions`, `AuthBasicErrors`
- Packages: `bb-auth-basic`, `bb-auth-oidc`, `bb-auth-cognito`, `auth-common`

### Rationale
1. **IDE discoverability** — customers start typing `Auth` and autocomplete shows all auth Building Blocks together (`AuthBasic`, `AuthCognito`, `AuthOIDC`), making it easy to compare options
2. **Import grouping** — in sorted import lists, all auth-related imports cluster together alphabetically
3. **Package listing** — `npm ls` and file explorers show `bb-auth-*` packages grouped, making the auth family visible at a glance
4. **Consistent with the common interface** — `BlocksAuth` is the shared interface, so `Auth*` as a prefix reads naturally as "an auth provider that uses [strategy]"

### Alternatives Considered
- **Strategy-first naming** (`BasicAuth`, `OIDCAuth`, `CognitoAuth`) — more natural English but scatters auth blocks across the alphabet in autocomplete and import lists. Customers searching for "auth" wouldn't see them grouped.

### References
- Common interface: `packages/auth-common/src/index.ts`
- Design docs: `docs/tech-design/BB-auth-common.md`, `docs/tech-design/BB-auth-basic.md`

## D-005: Auth state machine uses a unified form model (no redirect action type)

**Date**: 2026-04-08
**Authors:** Jon Wire

### Context
The auth state machine needs to support both internal actions (username/password sign-in via `setAuthState()`) and external actions (OAuth/OIDC sign-in via browser navigation to an external provider). Early designs used a discriminated union (`AuthFormAction | AuthRedirectAction`) to distinguish these.

### Decision
All actions are forms. There is no separate "redirect" action type. Actions differ only in whether they have a `url` field:

- **No `url`**: client collects field values and calls `setAuthState(name, fields)`
- **With `url`**: client submits a regular HTML form to that URL (GET or POST)

The server bakes all OAuth parameters (client_id, scope, state nonce, etc.) into the `url` when constructing the `AuthState`. Fields with `defaultValue` provide parameters the server supplies but the client may override.

### Rationale
1. **OAuth IS a form submission** — navigating to `https://accounts.google.com/o/oauth2/auth?...` is just a GET form submission to an external URL. Modeling it as a separate "redirect" type obscures this.
2. **No redirect cycles** — earlier designs put `redirectUrl` on `AuthState` itself, which risked infinite loops in naive Authenticator implementations. With the form model, the state machine only returns renderable states; navigation is a side effect of form submission.
3. **`setAuthState` always returns `AuthState`** — no special return types, no branching on response shape. The state machine contract stays simple.
4. **Simpler Authenticator** — the component has one rendering path (forms) with one branch (does this form submit internally or externally?). No discriminated union to switch on.

### Alternatives Considered
- **Discriminated union** (`AuthFormAction | AuthRedirectAction`) — adds type complexity, requires the Authenticator to switch on `action.type`, and implies "redirect" is fundamentally different from "form" when it isn't.
- **`redirectUrl` on `AuthState`** — the server response itself instructs the client to navigate. Dangerous: creates potential for redirect loops and conflates "what to render" with "what to do."
- **Separate `getSignInUrl(provider)` method** — keeps the state machine clean but splits the auth API surface into two protocols (state machine + ad-hoc methods).

### References
- Implementation: `packages/auth-common/src/index.ts` (`AuthAction` interface)
- Design: `packages/auth-common/DESIGN.md`

## D-006: `getMockDataDir` supports optional `resourceGroup` for logical grouping

**Date**: 2026-06-09
**Authors:** wirej

### Context
D-001 established `.bb-data/{fullId}/` as the standard mock data path via `getMockDataDir(scope)`. With the addition of AWS Resource Groups (settings vs resources), we want settings-type BBs (AppSetting) to be grouped under a common folder (`.bb-data/settings/`) so customers and agents can easily find all settings in one place.

### Decision
Extend `getMockDataDir` with an optional `options` parameter: `getMockDataDir(scope, { resourceGroup: 'settings' })`. When `resourceGroup` is provided, the path becomes `.bb-data/{resourceGroup}/{fullId}/`. The helper remains the single source of truth for mock data paths, preserving D-001's goal of eliminating boilerplate.

### Rationale
- Keeps the convention centralized in one helper (no hand-rolled `mkdirSync` in BBs)
- Backward-compatible: existing BBs continue calling `getMockDataDir(scope)` unchanged
- The grouping mirrors the AWS Resource Groups concept, making the local-to-cloud mental model consistent
- Agents and humans can `ls .bb-data/settings/` to see all settings at a glance

### Alternatives Considered
- **Flat structure only** (revert to D-001 verbatim): loses discoverability benefit; harder for agents to find settings among dozens of BB data folders
- **Separate helper function**: unnecessary API surface when an optional parameter suffices

### References
- D-001: original mock data convention
- PR #769: AWS Resource Groups and console shortcut routes

## D-007: Auth cookies default to `SameSite=Lax`; cross-domain is opt-in

**Date**: 2026-06-08
**Authors:** pranavosu

### Context
The three auth Building Blocks disagreed on the session cookie's `SameSite` attribute (and the coupled `Secure` / `Partitioned` handling):

| BB | prod | localhost |
|---|---|---|
| `bb-auth-basic` | `Secure; SameSite=None; Partitioned` (hardcoded) | same as prod |
| `bb-auth-cognito` | `Secure; SameSite=None; Partitioned` | `Secure; SameSite=None` (drops `Partitioned`) |
| `bb-auth-oidc` | `Secure; SameSite=Lax; Partitioned` | `SameSite=Lax` (no `Secure`/`Partitioned`) |

`bb-auth-basic` and `bb-auth-cognito` chose `SameSite=None` to make the session cookie work in the legacy cross-port dev setup (frontend `:3000`, backend `:3001`). That choice rested on a misdiagnosis: cross-port is cross-*origin* but **same-site** — `SameSite` is defined by registrable domain + scheme, and the port is not part of "site" (RFC 6265bis). A `SameSite=Lax` cookie is therefore sent on a same-site cross-port request, so `None` was never required for it. The actual requirement for a credentialed cross-origin `fetch` is CORS (`Access-Control-Allow-Credentials: true` + a specific `Origin`), which the dev server already set. `bb-auth-oidc` had already chosen `Lax` and worked fine cross-port, which corroborates this. Each BB hand-rolled its own attribute selection, which is how they drifted. No prior decision record resolved this.

The single-origin dev proxy ([#769](https://github.com/aws-devtools-labs/aws-blocks/pull/769)) makes local dev same-origin, so the question is moot either way: `Lax` is correct, and `None`'s extra CSRF surface buys nothing.

### Decision
All three auth BBs default session cookies to `SameSite=Lax`. A single opt-in, `crossDomain` (default `false`), switches a BB to the cross-domain recipe:

- `crossDomain: false` (default) → `SameSite=Lax; Secure` (prod) / `SameSite=Lax` (plain-HTTP localhost; `Lax` does not require `Secure`).
- `crossDomain: true` → `SameSite=None; Secure; Partitioned` (prod) / `SameSite=None; Secure` (localhost; CHIPS `Partitioned` requires HTTPS, so it is dropped).

The attribute selection lives in one shared helper, `@aws-blocks/auth-common/cookies` (`resolveCookieSecurity` / `buildCookieSecurityAttrs`), which every BB calls. A cross-BB parity test asserts identical output for identical inputs so the family converges structurally, not by coincidence of matching strings.

This supersedes the `bb-auth-basic` and `bb-auth-cognito` `None` defaults. It depends on #769: the `Lax` flip must not ship while the legacy two-port templates are still the default dev path.

### Rationale
- **Same-origin by default.** With the dev proxy, both dev and a standard (same-domain) production deploy are same-origin, where `Lax` cookies are never dropped. `Lax` is the correct default for the common case.
- **Smaller CSRF surface.** `Lax` is not sent on cross-site subrequests, which removes a class of CSRF exposure that `None` carries.
- **No CHIPS dependency.** `Lax` needs neither `Partitioned` nor the `Secure`-on-HTTP-localhost browser carve-out, so behavior is honest about plain-HTTP localhost.
- **Cross-domain is the exception.** Frontend and API on different registrable domains (e.g. frontend on Vercel, API on AWS) genuinely need `SameSite=None`. That case opts in via `crossDomain: true` rather than penalizing every same-origin app with the looser default.
- **One helper.** Triplicated attribute logic is what let the BBs diverge; centralizing it is the load-bearing change.

### Alternatives Considered
- **Keep `SameSite=None` as the default.** Wider CSRF surface, depends on CHIPS / browser localhost carve-outs, and is the wrong default now that dev is same-origin. Cross-domain is the minority case and should opt in.
- **Per-BB bespoke selection (status quo).** Already proven to drift; rejected in favor of the shared helper.
- **Naming the opt-in `crossOrigin`.** The earlier (outdated) notes used `crossOrigin`, but the relevant boundary is the registrable domain, not the port-origin, so `crossDomain` is more accurate.

### References
- Helper: `packages/auth-common/src/cookies.ts`
- Enabler: #769 (single-origin dev proxy)
- Related: #704 (docs), #748 (cross-port behavior, obsoleted by the proxy)

## D-008: BB documentation follows a progressive-disclosure model (README entry point + task-scoped references)

**Date**: 2026-06-09
**Authors:** pranavosu
**Amends**: [D-002](#d-002-bb-documentation-ships-as-readmemd--designmd)

### Context
D-002 established a fixed two-file rule: each BB ships `README.md` + `DESIGN.md`. PR #834 (custom auth UI guide, #700) needed a third doc, `packages/auth-common/CUSTOMIZING-AUTH-UI.md`, for a reader goal that fits neither file — it's not quick-start usage (README) and not internal design (DESIGN), but a substantial customization contract. The two-file rule had no clean home for it: the content either bloats the README or is mis-filed in DESIGN.

### Decision
Generalize D-002 from a fixed two-file rule to a **progressive-disclosure model**: one always-read entry point plus as many task-scoped reference docs as the package's surface area warrants.

- **`README.md`** — the entry point, always the first read. Covers what the BB is, when to use it, the common-case API and examples, and indexes the reference docs below.
- **`DESIGN.md`** — the standard reference for internals: infrastructure details, mock parity gaps, serialization, interface decisions. For extenders and advanced customers.
- **Additional task-scoped references** (e.g. `CUSTOMIZING-AUTH-UI.md`) — added when a distinct reader goal has enough surface to warrant its own file, rather than bloating the README or burying usage content in DESIGN.

Every reference doc MUST ship via `"files"` in package.json (so it reaches `node_modules`) and MUST be linked from the README. The preliminary design doc (`docs/tech-design/BB-*.md`) still redirects to the package's README once implemented.

**The bar for adding a reference doc is a distinct reader goal (audience + task), not a line count.** README + DESIGN remains the default and covers most BBs; the model just makes the structure scale principled-ly when a BB's surface is larger. No existing BB needs to change.

### Rationale
- The underlying principle was always progressive disclosure (an entry point plus deeper material disclosed on demand); "README + DESIGN" in D-002 was simply the common case, not the boundary
- A single entry point that indexes task-scoped references mirrors the progressive-disclosure shape the repo already uses for agent skills (`.skills/*/SKILL.md` + `references/`): one always-loaded file, deeper material pulled in only when the reader's task needs it
- Anchoring the rule on "distinct reader goal" rather than a line-count threshold keeps the judgment qualitative and avoids gaming a number

### Alternatives Considered
- **Keep the hard two-file limit (D-002 verbatim)** — too rigid: a BB with a large, distinct usage surface (e.g. auth-common's customization contract) has nowhere clean to put that content. It either bloats the README or is mis-filed in DESIGN.
- **A line-count threshold for a third file (e.g. >150 lines)** — easy to game and arbitrary; length is a symptom, not the criterion. The real signal is whether a distinct reader goal exists.
- **`docs/` subfolder with progressive files (API.md, BEST_PRACTICES.md, SCALING.md) per BB** — over-fragments the common case where README + DESIGN suffices, increasing hops for the majority of BBs
- **Literally co-locating BB docs as agent skills under `.skills/`** — the *shape* converges (entry point + references) but the audience and delivery differ: skills are agent-facing and read from the repo, BB docs are customer-facing and ship in `node_modules`. Borrow the model, don't merge the systems.
- **Recording this as a one-off exception to D-002** — hides a general principle behind a special case; the progressive-disclosure model applies to any BB with a large surface, not just auth-common.

### References
- Amends: D-002 (original two-file rule)
- Skill convention this mirrors: `.skills/blocks-pr-review/` (`SKILL.md` + `references/`)
- First third-file instance: `packages/auth-common/CUSTOMIZING-AUTH-UI.md` (PR #834, issue #700)

## D-009: External databases — Blocks-applied, version-controlled schema migrations

### Context
Before this change, `migrationsPath` + `fromExisting()` was a hard error ("external databases must manage their own schema") — there was no supported path to evolve an external Supabase/Neon schema through Blocks. Customers changed schema by hand in the provider dashboard and re-pulled, and the obvious `bb-data migrate` silently wrote to a throwaway local PGlite the app never reads. This reverses that stance.

### Decision
Blocks applies version-controlled `./migrations` to the external connection-string database across dev/sandbox/production, via these sub-decisions:

- **Host-side execution, not an in-VPC CR Lambda.** The external pooler is publicly reachable (unlike Aurora), so migrations run host-side as a pre-`cdk deploy` lifecycle step, reusing the existing engine-agnostic `runMigrations` + `PgClientEngine` (no new runner/engine).
- **`core` invokes the `bb-data` CLI as a subprocess.** `core` must not depend on `bb-data` (the dependency runs the other way); the connection string is passed via the `BLOCKS_MIGRATE_URL` env var, never argv (not exposed in the process list).
- **`pg_dump` for the baseline.** `db pull` emits `migrations/000_baseline.sql` via `pg_dump --schema-only --schema=public` so fresh/empty environments build from the files; needed only at pull time to generate, never to apply.
- **5432 session port + non-blocking session advisory lock.** DDL, multi-statement file transactions, and a session-held lock need a stable session; the 6543 transaction pooler doesn't guarantee one. `pg_try_advisory_lock` (keyed by stage + migrations dir, bounded retry) serializes concurrent deploys.
- **Best-effort, fail-open production guard.** `npm run dev`/`sandbox` (which share `.env.local`) refuse if the target resolves to the production DB (`.env.production` and/or the production SSM parameter); when neither is resolvable they log a transparency note and proceed. `npm run deploy` intentionally targets production and is unguarded.
- **Forward-only** — no down/rollback migrations.

### Rationale
- Reuses the proven runner/engine rather than new infra; the external pooler's public reachability makes host-side execution sufficient and simpler than the Aurora CR-Lambda path.
- Credentials via env (not argv) keep them out of the process list.
- `pg_dump` is the canonical, complete baseline tool; hand-reconstructed DDL would be subtly wrong and silently diverge new environments.
- The session port + advisory lock are required for safe concurrent DDL; the transaction pooler is unsafe for session-scoped locks.
- The guard is a best-effort safety net for the shared-`.env.local` dev/sandbox path; failing open (with a visible log) avoids blocking offline/unauthenticated CI while still catching the common mistake.

### Alternatives Considered
- **In-VPC CR Lambda (the Aurora path).** Unnecessary infra when the host can reach the DB; retained as a future `--via-lambda` escape hatch for locked-down networks.
- **`core` importing `bb-data` directly.** Circular dependency — rejected in favor of subprocess invocation.
- **Hand-rolled baseline introspection** instead of `pg_dump`. Higher risk of subtly-wrong DDL; rejected.
- **Fail-closed production guard for `sandbox`.** Safer, but blocks offline/unauthenticated CI; rejected as too disruptive — revisit if it proves necessary.
- **Aurora DSQL support.** Out of scope — needs a separate runner (no advisory locks, one-DDL-per-transaction with no DDL/DML mixing, IAM-token auth).

### References
- #793 (this PR); connection/port resolution shipped separately in #861
- Code: `packages/bb-data/src/migrations/external-migrations.ts`, `packages/bb-data/src/migrations/baseline.ts`, `packages/core/src/scripts/external-migrations-step.ts`
- Supersedes the prior "external databases must manage their own schema" error in `bb-data/src/index.{cdk,mock}.ts`

### Known limitation — TLS verification on the DDL/baseline path
The host-side migration, baseline (`pg_dump`), and `--url` CLI connections currently use `ssl: { rejectUnauthorized: false }` — the same posture the runtime engine has historically used for `fromExisting`. #806 is enforcing verify-by-default (with an `ssl: { ca }` override to pin a provider CA) on the runtime/dev paths; this PR's DDL paths do not consume that override yet. **Accepted interim risk:** unverified TLS to the pooler on the deploy/CI host. **Fast-follow:** have these paths adopt #806's `ssl`/CA override (verify, or explicitly pin the CA) once it lands, rather than introducing a separate mechanism here.

## D-010: `--telemetry-file` flag writes regardless of opt-out status

**Date:** 2026-06-10
**Authors:** sarayev

### Context

The Blocks CLI telemetry system needed a way for developers and CI systems to inspect telemetry events locally — both for debugging and for integration testing. The old `BLOCKS_TELEMETRY_DEBUG` env var printed events to stderr, which was hard to parse and couldn't be used programmatically.

### Decision

Add a `--telemetry-file=/path` flag to all CLI scripts that writes telemetry events to a JSON file. The file sink:

1. **Writes regardless of opt-out status** — even when telemetry is disabled (via env var, project config, or global config), the file still captures events
2. **Does NOT prevent HTTP sending** — when telemetry is enabled, both file and HTTP sinks fire
3. **Skips pre-existing files** — if the target file already exists, the sink silently does nothing (protects user data)
4. **One event per file** — each CLI invocation writes exactly one event; if the file already exists, it is skipped

To capture events without sending to the server: combine `--telemetry-file` with `AWS_BLOCKS_DISABLE_TELEMETRY=1`. The file still captures, HTTP does not send.

### Rationale

- Enables integration testing without network dependencies — read the JSON file to verify events were constructed correctly
- Enables local debugging ("what would be sent?") without intercepting HTTP traffic
- Writing identifiers to disk only when `--telemetry-file` is explicitly passed is an intentional privacy trade-off: the user is actively requesting event capture, signaling awareness
- Skipping pre-existing files prevents accidental data corruption
- Additive design (file + HTTP when enabled) means the flag never silently suppresses real telemetry in production

### Alternatives Considered

1. **File replaces HTTP (file-only mode):** Rejected because it would silently suppress real telemetry if a developer forgets to remove the flag. Additive is safer — worst case is an extra file on disk.

2. **File gated by consent (same as HTTP):** Rejected because it makes the flag useless for testing disabled scenarios. The point is to verify "what would the event look like" even when telemetry is off.

3. **Keep `BLOCKS_TELEMETRY_DEBUG` env var (stderr):** Rejected because stderr output can't be programmatically parsed, is mixed with command output, and can't be used in CI test assertions.

4. **Append to existing files:** Rejected because it risks corrupting user files. Fresh file per invocation is safer.

### References

- PR #880: implementation

## D-011: `db pull` is interactive-only; dev/prod intent routes the connection string (R1)

**Date**: 2026-06-11
**Authors:** mehrishi

The interactive `db pull` experience was reworked for clarity and safety, which reversed two
earlier planning decisions and removed a released behavior:

- **Removed the non-interactive (headless) path.** `db pull` previously ran a full, unattended
  pull when `SUPABASE_DB_URL` was set in the environment (via `runDbPullCli`). That path is
  removed: `db pull` now always prompts (dev/prod intent + connection string) and **fails fast**
  with guidance when stdin is not a TTY, instead of hanging or silently pulling.
- **`db pull` now asks dev vs production and routes accordingly.** A **development** pull behaves
  as before (introspect → generate code + `.env.local` + mock settings sidecar + schema baseline).
  A **production** pull configures `.env.production` **only** — it does not introspect, does not
  regenerate code, and never writes the dev artifacts. A production pull is **gated** on a prior
  dev pull (`.env.local` must already hold the connection string); with no dev setup it refuses
  and tells the customer to set up development first. Syncing the production *schema* remains
  `npm run deploy`'s job.
- **Credentials are always gitignored.** `db pull` now creates `.gitignore` (if absent) to ensure
  `.env.local` / `.env.production` are never committable, rather than only updating an existing one.

### Rationale
- The headless path was invoked by nothing automated: `runDbPullCli` is referenced only by its own
  definition and the CLI command wiring; CI's `SUPABASE_DB_URL` feeds the e2e suite and
  `apply-schema.ts`, which call `introspect()` / the generators directly, not the orchestration.
  So removing it breaks no CI and no test. `db pull` is fundamentally a human onboarding command
  (it prompts for a secret), so interactive-only matches its real use and avoids the trap of a
  half-configured headless run.
- Writing a production connection string into `.env.local` (which the dev loop consumes) is the
  exact hazard the dev-loop production guard exists to catch, so production mode must not write dev
  artifacts. Gating production on an existing dev setup prevents bootstrapping an app straight from
  a production database.

### Compatibility
- This removes behavior released in `@aws-blocks/bb-data` 0.13.3. The package is pre-1.0, and no
  known consumer relied on the headless pull, so it ships as a **minor** bump (new UX) rather than
  a major. (Per CONTRIBUTING "removing released behavior" escalation: rationale + no-consumer
  confirmation recorded here.)

### Supersedes
- The planned R1 deferral "dev/prod prompt is clarity + guardrail only; still write dev artifacts
  on prod" (OQ-1) — production now routes to `.env.production` instead.
- The planned R1 requirement to keep non-interactive mode working with env/flag equivalents
  (`--prod` / `--provider`) — non-interactive mode is removed, so those flags are unnecessary.

### References
- PR #922 (this change); follows #895 (db-pull modularization), #793 (external-DB migrations).
- Code: `packages/bb-data/src/db-pull/pull.ts` (`dbPullInteractive`, `dbPullDevInteractive`,
  `dbPullProdInteractive`, `hasDevConnection`, `writeProductionEnv`, `ensureGitignored`,
  `runDbPullCli`).

## D-012: CloudFormation stack naming uses a generated `stackId` with per-machine sandbox isolation

**Date**: 2026-06-19
**Authors:** wirej

### Decision

CloudFormation stack names are derived from a `stackId` stored in `.blocks/config.json` (committed to the repo). The `stackId` is generated once at scaffold time as `<sanitizedName>.slice(0, 16)-<random(6)>`, producing names like `my-app-k7x2mf`.

Stack name scheme:
- **Production:** `<stackId>-prod` (e.g., `my-app-9f3a2b-prod`)
- **Sandbox:** `<stackId>-<username(8)>-<random(6)>` (e.g., `my-app-9f3a2b-alice-0d7e1c`)

The sandbox identifier is generated per-machine and stored in `.blocks-sandbox/sandbox-id.txt` (gitignored).

Both helpers (`getStackId`, `getSandboxId`) are exported from `@aws-blocks/blocks/scripts` and accept an optional `projectRoot` parameter (defaults to `process.cwd()`).

### Rationale
- **Collision avoidance:** The 6-char hex suffix in `stackId` provides ~16.8M combinations (16⁶), making accidental collisions between same-named apps in a shared account negligible.
- **Per-developer sandbox isolation:** Teams sharing a test account need distinct sandbox stacks. The username prefix makes stacks identifiable in the AWS Console; the 6-char hex suffix handles multiple sandboxes per developer and username collisions.
- **Length control:** `name.slice(0, 16)` keeps stack names under ~37 chars total, well within CloudFormation's 128-char limit and readable in the console.
- **Committed vs gitignored:** `stackId` is committed so the whole team and CI deploy to the same production stack. `sandbox-id.txt` is gitignored so each machine gets its own sandbox.

### References
- PR #51; `.blocks/config.json` is also used by telemetry (`telemetry.projectId`).
- Code: `packages/core/src/scripts/stack-id.ts`

### Migration scope
This scheme applies to **newly scaffolded apps only**. Existing apps that adopt the new `index.cdk.ts` must set `stackId` in `.blocks/config.json` to their current production stack name **with the `-prod` suffix removed** — since the template appends `-prod` automatically. For example, if your existing stack is `my-blocks-stack-prod`, set `stackId` to `my-blocks-stack`.


## D-013: External-DB connection-string SSM parameter is stack-scoped via a single shared `getStackName`

**Date**: 2026-06-26
**Authors:** mehrishi

### Context

The external-database connection string was stored in an SSM parameter named only
by stage (`/blocks/{stage}/db-connection-string`). With no app identity in the
name, two Blocks apps deployed to the same account + region + stage computed the
same name and silently overwrote each other's credentials — the second app's
Lambda then read the wrong database with no error. An earlier attempt to add a
discriminator derived from the connection string / database ref broke silently,
because the write side (live environment) and the read side (a ref captured at
`db pull` time) derived it differently and diverged.

D-012 (PR #51) made the deployment's stack name deterministic and committed
(`.blocks/config.json`), so it is computable **before** `cdk synth`, not only
inside the construct tree.

### Decision

The parameter name is stack-scoped: `/<stackName>-db-url`, where `stackName` comes
from a single new `getStackName(projectRoot, { sandbox })` helper. That helper is
also the one place the CDK templates compute the stack name (the `-prod` / sandbox
suffix assembly that D-012 left duplicated inline across templates is removed).

`dbConnectionParameterName(projectRoot, { sandbox })` derives the parameter name
from `getStackName`. It is called by both the pre-deploy writer (`ensureSecrets`)
and the `db pull` generated wiring at synth, with identical inputs supplied by the
same deploy/sandbox orchestrator (`projectRoot` + stage). At runtime the app reads
the synth-stamped `BLOCKS_SSM_PARAM_DB_URL` and never recomputes.

### Rationale

- **Uniqueness (no collision):** the name embeds the per-app `stackId`, so two
  apps never share a name.
- **Write == read by construction:** one function, one set of inputs from one
  orchestrator. The dual-derivation divergence that broke the earlier ref-based
  attempt cannot recur.
- **Discriminator is stack identity, not the connection string:** the name is
  independent of which database the app points at, derived from committed config.
- **No post-deploy machinery:** because the name is computable pre-synth (D-012),
  the writer writes directly to the final name before deploy. No CfnOutput
  round-trip, no after-deploy write-back, no in-stack staging-copy custom resource.
- **Fail fast, not silent:** `getStackName` throws an actionable error when
  `.blocks/config.json` is missing, rather than falling back to a guessed name.

### Alternatives Considered

- **Post-deploy write via CfnOutput** (PR #39's first design): synth emits the
  resolved name, the writer reads it from stack outputs after `cdk deploy`.
  Rejected as unnecessary once D-012 makes the name pre-computable; it also adds a
  first-deploy window and ordering complexity.
- **In-stack staging-copy (`copyFrom`)** (PR #39 spike): mint a staging parameter,
  copy it to the final name inside the CloudFormation transaction. Rejected for
  the same reason — it solves "the name is unknown pre-synth," which is no longer
  true. It is the correct fallback only if external DB ever runs inside a nested /
  Amplify Gen2 stack, where the stack name is tokenized at synth.

### Tradeoff

Writing before deploy means the connection string is persisted to SSM even if the
deploy later fails. Accepted: it is the customer's own value, the write is
idempotent and overwritten on the next deploy, and this matches pre-existing
behavior. The staging-copy spike was the only variant that made the write atomic
with the stack; that property is consciously traded for the removal of all
write-back/staging machinery.

### Compatibility

- **Breaking signature change:** `dbConnectionParameterName` now takes a
  `stackName` string (was `(stage: string)`). `getStackName` now takes a single
  options object `{ sandbox, projectRoot? }` (was `(projectRoot, { sandbox })`).
  The package is pre-1.0 (preview) and no external consumer has committed old-form
  wiring, so this ships as a patch. Apps with stale generated `supabase.ts` must
  run `npx bb-data pull` to regenerate.
- **Prerequisite (D-012):** `getStackName` reads `stackId` from
  `.blocks/config.json`; it throws if absent. Pre-PR #51 apps migrating to this
  version must first set `stackId` in `.blocks/config.json` (see D-012 "Migration
  scope" for instructions) or deploys will fail at the `ensureSecrets` step.
- The previous stage-only parameter (`/blocks/{stage}/db-connection-string`) is
  orphaned and self-heals on the next deploy — the old value remains in SSM but is
  no longer read or written.

### References

- Supersedes the stage-only `dbConnectionParameterName(stage)`.
- Builds on D-012 (PR #51, committed `stackId`).
- Code: `packages/core/src/scripts/stack-id.ts` (`getStackName`),
  `packages/core/src/db-naming.ts`, `packages/core/src/scripts/ensure-secrets.ts`,
  `packages/bb-data/src/db-pull/generate.ts`.
