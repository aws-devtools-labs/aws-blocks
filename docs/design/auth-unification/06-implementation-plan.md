# Auth Unification — Implementation Plan

**Companion to the strategy doc** (an internal design document, v4, not published). That doc says *what* and *why* and holds the 12 recorded decisions (Q1–Q12) and the 4 locked ones (D0–D3). This doc is the execution breakdown: numbered tasks, one PR each, with files, acceptance criteria and dependencies.

**Baseline:** `origin/main` @ `b58f2487` (2026-10-01). Integration branch `refactor/auth-blocks`, currently 54 commits behind — T0 fixes that.

**Working rule:** one task = one PR = `main` stays green. Any task over ~1,500 changed lines or two weeks old is a signal to split it (see *Top risks* in the strategy doc).

---

## ⚠️ One decision changed under us

**Q12 (group membership) has been overtaken by events.** You chose "token claims for now; don't close #583". **#583 merged on 2026-09-26** (`2e72825d`), and `bb-auth-cognito/DESIGN.md` Decision 3 was rewritten to match it, so live-group reads are now the documented, deliberate design on `main`:

- `requireRole` calls `AdminListGroupsForUser` per guarded request, deduped per request via a `WeakMap` memo (`index.aws.ts:1658-1672`).
- `cognito-idp:AdminListGroupsForUser` moved into the **base** IAM statement — it is no longer admin-only.
- Returned `groups` is narrowed to the declared set; a deleted user fails closed with 403.

The strategy doc already anticipated this: *"If #583 merges before P4a, `bb-auth` adopts whatever is on `main` then."* **This plan therefore assumes `bb-auth` ships live-group reads**, and T13 inherits the memo and the fail-closed mapping.

Going back to token claims would now be a breaking behaviour change to shipped, documented behaviour, plus an IAM reduction — so it should not be done silently as part of this refactor. If you do want token claims, say so and it becomes its own PR against `bb-auth-cognito` first.

**Other branch states as of today:** #575 merged (branch deleted). Still open: #208 (198 commits behind), #297 (73), #588 (59).

---

## Dependency graph

```
A1 A2 A3  (independent fixes — land any time, no dependencies)
                     │
B1 ──► B2            │   B3  B4  B5   (safety net; B1 gates D-stage)
  └────────────────┐  │
C1 ──► C2          │  │   (auth-common contract)
                   ▼  ▼
                  D1 (types gate)
                   │
                  D2 (skeleton)
                   │
         ┌─────────┼─────────┬─────────┐
        D3        D5        D6        D7     (D3 gates D4)
         │
        D4 (immutability guard)
         └─────────┴─────────┴─────────┘
                   │
                  D8 (upgrade-in-place harness)
                   │
         E1  E2  E3  E4   (consumers — parallel)
                   │
                  F1 (cutover) ──► F2 (codemod + MIGRATION.md)
```

**Start here:** T0, then A1 and B1 in parallel.

---

## Stage 0 — Setup

### T0 · Refresh the worktree, commit the research
- `git rebase origin/main` on `refactor/auth-blocks` (no commits yet, so this is a fast-forward), `npm install`, `npm run build`.
- Commit the six untracked research docs plus this plan under `docs/design/auth-unification/`.
- **Accept:** `npm run build && npm test` green at current main; docs committed.
- **Changeset:** none (docs only, no publishable package touched).
- **Size:** trivial.

---

## Stage A — Independent fixes (no dependency on the refactor)

These are real defects found during research. They stand on their own, reduce risk later, and are good warm-up PRs. None blocks anything.

### A1 · Fix multi-`Set-Cookie` loss on the RPC path
The highest-value bug found. On AWS, a response that sets two cookies silently loses one.
- `packages/core/src/lambda-handler.ts:615` builds RPC responses with `Object.fromEntries(responseHeaders.entries())`, collapsing duplicate headers. Only the RawRoute path (`:673-678`) emits `multiValueHeaders`.
- Cognito `set`s the session cookie (`cookies.ts:74`) and `append`s the autoSignIn bridge cookie (`:229/254`), so one is dropped on AWS.
- Fix in `core`; emit `multiValueHeaders` (or `cookies[]`) on the RPC path too.
- **Accept:** unit test asserting two `Set-Cookie` values survive; **sandbox e2e** — the dev server splits correctly, so this cannot reproduce locally.
- **Changeset:** patch, `@aws-blocks/core` + `@aws-blocks/blocks`.
- **Size:** small code, non-trivial test setup.

### A2 · Correct the false MFA claim in the OIDC README
`packages/bb-auth-oidc/README.md:369` sells Cognito federation on "MFA on social sign-in". Per AWS, federated users get **no** additional authentication factors — no MFA, no device tracking, no adaptive auth. This is the primary stated reason customers pick the more expensive path, and it is false.
- **Accept:** claim removed/corrected; no other README drift.
- **Changeset:** patch, `@aws-blocks/bb-auth-oidc` + umbrella.
- **Size:** trivial.

### A3 · Pin `featurePlan` on the OIDC federation pool
`bb-auth-oidc`'s `cognito-pool` leaves `featurePlan` unset, so Cognito defaults it to the paid **Essentials** tier. `AuthCognito` already pins it.
- **Verify first:** on an existing deployment, pinning a value equal to what the service already defaulted to is a no-op; pinning a *different* one is a tier change on `UpdateUserPool`. Pin `essentials` to match the live default, and say so in the PR body.
- **Accept:** cdk synth test asserts the property is present; `cdk diff` against a pre-existing sandbox stack shows no tier change.
- **Changeset:** patch.
- **Size:** trivial code, one synth test.

---

## Stage B — Safety net (P1). Prerequisite, not cleanup.

> Until B3 and B5 land, "CI is green" means very little for the auth AWS layer. B1 is what makes every later CDK change reviewable.

### B1 · Resource-identity golden fixture for `AuthCognito`  ← **the tripwire**
- Generalise `synthUnderCdkConditions` (`packages/bb-auth-cognito/src/index.cdk.test.ts:72`) into a reusable helper — today it returns table-specific data. The child-process synth under `--conditions=cdk` is required: importing `index.cdk.js` directly leaves nested `KVStore`/`AppSetting` on mock entries that emit no CloudFormation.
- New `packages/bb-auth-cognito/src/resource-identity.cdk.test.ts` + `__fixtures__/resource-identity.json`, pinning per resource: `{logicalId, Type, physicalName}`.
- Cover: `pool`, `client`, `sessions`, `session-secret`, `group-<name>`; plus `userPoolName: this.fullId`, the derived config keys `BLOCKS_AUTH_COGNITO_<UPPER_FULLID>_{USER_POOL_ID,CLIENT_ID,REGION}`, the cookie name `auth_<fullId>`, and **`client` has no `GenerateSecret`** (replace-only — see the frozen contract).
- **Accept:** passes at HEAD; renaming any child id locally fails with a diff *naming the resource*. Put that demonstration in the PR body.
- **Changeset:** patch (test-only changes in a publishable package still trip `changeset-guard verify-coverage`).
- **Size:** medium. **Gates:** D3.

### B2 · `AuthOIDC` identity snapshot — documentation, not a gate
Snapshot `cognito-pool` (named `${fullId}-federation`), `domain`, `app-client`, the `idp-registration-*` custom resources and `sessions`. This is the evidence behind the per-block upgrade table, including the domain-prefix collision. Mark it clearly as non-gating; it is deleted with the package at F1.
- **Accept:** snapshot committed; a comment in the file says why it is not a CI gate.
- **Size:** small. **Depends:** B1's helper.

### B3 · Make `conditional-exports.test.ts` actually prove parity
Three real holes (`packages/blocks/src/conditional-exports.test.ts`):
1. `assertSuperset` computes only `missing = default − condition` (`:56`) — **one direction**, so an *extra* export is invisible. That is why `extractUserAttributes`, which exists only in `index.aws.ts`, passes today.
2. Only `aws-runtime` per BB (`:84-85`) and `cdk` on the umbrella (`:68-69`). Never `cdk` or `browser` per BB.
3. Discovery requires an `aws-runtime` condition (`:34`), so `auth-common` is never checked.
- Make it bidirectional, add `cdk` + `browser` per BB, include `auth-common`.
- **Expect it to fail on landing.** Fix or allowlist each gap with a comment naming the symbol and why.
- **Accept:** test green; PR body lists every previously-invisible gap found.
- **Size:** small test change, unknown fallout — triage before promising a size.

### B4 · Close the tsconfig reach gaps
- Root `tsconfig.json:3-19` reaches `bb-auth-cognito` / `bb-auth-oidc` only transitively via the umbrella, so any umbrella reference rework silently drops the four Cognito `*.types-test.ts` files from typechecking. Add both explicitly.
- Add the missing `bb-app-setting` project reference to `packages/bb-auth-cognito/tsconfig.json` (its `index.cdk.ts` imports it).
- **Accept:** `npm run build` green; deleting a `types-test.ts` assertion now fails the build.
- **Size:** trivial.

### B5 · Default-run tests for the Cognito AWS layer
`packages/bb-auth-cognito/src/index.aws.ts` is **2,580 lines**; `index.aws.test.ts` has 10 tests, all narrow (`extractUserAttributes` and friends). Every substantive suite is `BLOCKS_INTEGRATION=1`-gated and skipped by `npm test`. D5 moves all of it.
- Add command-shape tests against a spied SDK client, following `packages/bb-kv-store/src/parity.test.ts` blocks 5–6: session-record shaping, error mapping (including `UserNotFound` → 403 fail-closed from #583), attribute filtering, cookie parse/verify, and the live-groups memo (one Cognito call per request, not per `requireRole`).
- **Accept:** meaningful default-run coverage of the paths D5 will touch; no new `BLOCKS_INTEGRATION` gating.
- **Size:** large (the biggest of Stage B). Split by area if it grows past ~800 lines.

---

## Stage C — Canonical contract in `auth-common` (P3, additive)

### C1 · `AuthErrors` + guards + the mapping table
- Add `AuthErrors` as-const and `isAuthError()` to `packages/auth-common/src/errors.ts` (new).
- **Fix `BlocksAuth.requireAuth`'s JSDoc** (`packages/auth-common/src/index.ts:47`): it promises `SessionExpiredException`, which only `AuthBasic` throws. Cognito and OIDC throw `NotAuthenticatedException`. The shared interface's own contract is wrong today.
- Add **`requireRole` as an *optional* member** of `BlocksAuth`. Required would break the build immediately: `AuthBasic implements BlocksAuth` (`bb-auth-basic/src/index.ts:148`) has no `requireRole`, and structural implementers like `test-apps/amplify-gen2/aws-blocks/cognito-verifier.ts` would drift. It becomes required at F1.
- Keep **method-shorthand** declarations and add a comment saying why: a property-with-function-type makes parameters contravariant and breaks every narrowing implementation.
- Ship a **table-driven test** mapping every current error name to its canonical name. This is the artifact that makes D3's otherwise-silent break reviewable — renames are invisible because `hasAuthError(state, name)` takes a `string`. Docs/test table only; **no runtime aliases** (D3).
- Note in the table that `InvalidCodeException` splits into `CodeMismatchException` + `ExpiredCodeException`, so every `hasAuthError` call site needs manual review at E-stage.
- **Accept:** `check:api` clean; no existing export removed or renamed yet.
- **Changeset:** minor, `@aws-blocks/auth-common` + umbrella.
- **Size:** medium.

### C2 · Resolve #208 (`submitAuthAction`)
198 commits behind, and `auth-common/src/ui.ts` is exactly the file D7 rewrites — every hunk conflicts and none auto-resolves. **Land it now or convert it into a written requirement on `bb-auth`. Do not plan to rebase it after D-stage.**
- **Accept:** either merged, or closed with its behaviour captured as an acceptance criterion on D7.
- **Size:** depends; decide before starting D7.

---

## Stage D — Build `packages/bb-auth` (P4)

`"private": true` and **absent from the umbrella** for all of Stage D and E (Q3). No changeset names it until F1. Consumers import it workspace-locally.

### D1 · The types gate — land before any runtime code
A `types-test.ts` proving the mode-gating mechanism, with no implementation behind it. The rest-tuple technique ships today for `auth.admin` (`bb-auth-cognito/src/types.ts:331`), but this application is unproven, and the intuitive alternative is **recorded as a failure here**: a conditional *property* type made `AuthCognito<O>` invariant and regressed 14 call sites (`docs/tech-design/BB-auth-cognito-admin-implementation-plan.md:13`).
- Eight cases: `PasswordGate` on/off, `FederationGate` on/off, provider-id narrowing (`'okta'` accepted, `'github'` rejected), and `emailPassword` true / omitted / object.
- Plus a `takesWide(auth: Auth)` **variance regression guard** — the thing that broke last time.
- **Accept:** `tsc --build` green; every `@ts-expect-error` genuinely errors (flip one to confirm the test can fail).
- **Size:** small. **Gates:** everything else in Stage D.

### D2 · Package skeleton
- `packages/bb-auth/` per `packages/bb-kv-store`: `package.json` with the full conditional-export map (**`"private": true`**), `tsconfig.json`, `api-extractor.json`, `README.md`, `DESIGN.md`, `prebuild` version script → `src/version.ts`.
- `src/types.ts` (types-only, `import type` exclusively), `src/errors.ts`.
- Regenerate `files[]` and the `test` glob from the actual `src/` — do **not** copy a reference package.json verbatim.
- Register in root `workspaces` + root `tsconfig.json`. **Not** in the umbrella.
- `DESIGN.md` seeds: the mock↔AWS divergence table, the **CloudFormation-import runbook** (`removalPolicy: 'retain'` + `DeletionProtection: ACTIVE`, `cdk import`, verify, re-point), and the **account-linking known gap** (one sentence).
- **Accept:** builds, empty test passes, `lint:deps` clean, invisible to `changeset-guard` (private).
- **Size:** medium.

### D3 · CDK layer — identity-identical to `AuthCognito`
The highest-stakes task in the plan.
- Reproduce the frozen contract exactly: child ids `pool`, `client`, `sessions`, `session-secret`, `group-<name>`; `userPoolName: this.fullId`; `client` **without** `GenerateSecret`.
- Hosted-UI federation (social, SAML, `federateVia: 'cognito'`) uses a **separate** client construct — never the existing `client`. `GenerateSecret` is replace-only, and replacing `client` invalidates every refresh token in `sessions`.
- Same `registerConfig` keys. `synthGuard` stubs for **every** runtime method — neither existing block has them, so synth-time misuse currently throws a bare `TypeError`.
- **Q4:** pool honours `this.defaults.removalPolicy` / `deletionProtection` when the per-block option is unset. Today it is `DESTROY` even under `BlocksPresets.production` (`bb-auth-cognito/src/index.cdk.ts:229-231`), while its own `sessions` KVStore does inherit the preset. Warn when `removalPolicy` is unset.
- **Q6 — conditional provisioning:** with no email/password, social, SAML or `federateVia: 'cognito'` provider, synthesize **no Cognito resources** — only `sessions` and `session-secret`. Adding one later creates `pool`/`client` under the frozen ids: additive, not a replacement. An idle-pool config still pins `featurePlan` and applies the 128-char `fullId` check.
- Carry over two `bb-auth-oidc` bug fixes as requirements: the `https://localhost` callback placeholder (`bb-auth-oidc/src/index.cdk.ts:241`) and `SignInWithApple` validated-but-silently-dropped (`:280-300`).
- **Accept — all three:**
  1. B1's `AuthCognito` identity fixture passes **unchanged** for `new Auth(stack,'auth')`.
  2. A **property-level snapshot** of `pool` and `client` for `new Auth(stack,'auth')` equals `new AuthCognito(stack,'auth')`, except an explicit allowlist (e.g. `DeletionPolicy` under Q4). Identity pinning alone would miss a changed default such as `signInWith` — and a changed `signInWith` is a rollback-on-update, not a visible diff.
  3. Synth tests for the Q6 matrix: default config, direct-only, social-only, mixed.
- **Size:** large. **Depends:** B1, D1, D2.

### D4 · Immutability guard for the four service-immutable properties (Q5)
CloudFormation reports "No interruption" for sign-in/alias attributes, `UsernameConfiguration.CaseSensitive`, required attributes and existing custom attributes — then `UpdateUserPool` rejects and the stack rolls back. `cdk diff` cannot see this. **No such guard exists today**; the `signInWith` code often cited as a precedent only rejects an empty list (`bb-auth-cognito/src/index.cdk.ts` `mapSignInWith`).
- **Two layers, per Q5:**
  - A **committed baseline file** recording the four properties per block instance, diffed at synth, with an explicit "I know, re-baseline it" escape hatch.
  - A **deploy-time custom resource** that reads the live pool and rejects the change *before* `UpdateUserPool` runs, so the failure is an actionable message rather than a rollback.
- Rejected: a CDK context lookup — it needs AWS credentials at synth and breaks credential-free CI and offline dev.
- **Accept:** changing each of the four fails at synth with a message naming the property and the remedy; **paired negative tests** prove the permitted changes still pass — password policy, MFA config, token validities, callback URLs, `SupportedIdentityProviders`. Without those, a false positive is worse than no guard.
- **Size:** medium–large. **Depends:** D3.

### D5 · Base class + native engines
- `AuthBase extends Scope implements BlocksAuth`: sessions, cookies, `AuthState` builders, `createApi()`, RawRoutes, `requireAuth`/`requireRole`/`checkAuth`/`getCurrentUser`, mode gates, error mapping. Follows `bb-auth-oidc`'s proven shape (169-line entries), not Cognito's two independent 2,332/2,465-line classes.
- `engines/native-cognito.ts` (real SDK, lazy client — the module is imported during client codegen outside Lambda) and `engines/native-mock.ts`.
- `registerSdkIdentifiers` in the constructor; `getSdkIdentifiers(this)` **at call time**, never in the constructor.
- **Inherit from #583:** live-group reads with the per-request `WeakMap` memo, declared-set narrowing, and `UserNotFound` → 403 fail-closed.
- **Q2:** sign-up always sends an email code; `autoSignIn` (default on) signs the user in after `confirmSignUp` rather than requiring a second password entry — `AuthCognito`'s existing behaviour, no Lambda. Document the 50 emails/day default-sender cap in `README.md`.
- **Q10:** `validateUser` runs on both sign-in and sign-up; the PreSignUp trigger is provisioned **only** when the option is set.
- Pick **one** cookie-name prefix and document it: mock is `_`-joined (`bb-auth-oidc/src/index.mock.ts:168`), AWS is `-`-joined (`index.aws.ts:166`), so sessions don't survive a mock↔AWS switch today.
- Do **not** carry over `bb-auth-basic`'s cookie reader (`src/index.ts:379`) — its regex is unanchored and unescaped, so `my_auth_foo=` satisfies a lookup for `auth_foo`. Use Cognito's anchored reader with `constantTimeEquals`.
- **Accept:** `parity.test.ts` mock↔AWS; **sandbox e2e** (the serialization-bearing layer); the frozen-contract tests from D3 still green.
- **Size:** very large — **split it**: (a) base + sessions/cookies, (b) native-mock, (c) native-cognito. **Depends:** B5, D3.

### D6 · Federation engines
- `engines/federation-direct.ts` (the D0 default for `oidcProviders`): real OIDC discovery, PKCE, JWKS verification. Grade A for offline dev — the same code path locally and in production, only the issuer URL differs.
- `engines/federation-hosted-ui.ts` for social, SAML and `federateVia: 'cognito'`.
- `engines/stub-idp.ts` carried over from `bb-auth-oidc`: real RS256 via `jose`, discovery document, JWKS, `/authorize` account picker, HMAC-signed codes, real PKCE S256 verification, `/userinfo`, `/revoke`. **Without it, `emailPassword: false` has no offline sign-in at all.**
- **Per-provider** engine selection — this fixes a live bug where a single `cognitoFederated()` entry silently makes every co-declared provider unreachable.
- **Q1:** `userId` / `userSub` for direct-federated users is `` `${iss}:${sub}` ``, matching `AuthOIDC` today so existing keys survive.
- Routes stay under `/aws-blocks/auth/*` (the prefix both blocks already use), explicit per provider, **no wildcards and no root route**. Native OIDC runtimes keep their paths.
- **Federated `signOut()` must also hit `/logout`**, or the managed-login cookie silently re-authenticates.
- Hosted-UI providers are unmockable locally: ship a mock shim or an actionable "unavailable locally" error — **never a 404**.
- **Accept:** stub-IdP sign-in works offline with `emailPassword: false`; a multi-provider config reaches every provider; **sandbox e2e** per transport.
- **Size:** large. **Depends:** D2, D5(a).

### D7 · Browser entry + UI
- `index.browser.ts`: a throwing **named-export superset** of the default entry, plus a test that it does **not** import `./index.mock.js`.
- Move `CUSTOMIZING-AUTH-UI.md` out of `auth-common` and fix the `docs/DECISIONS.md:271` link to it.
- `AuthAction`-based form model: `url`-bearing actions for federated sign-in, so the RPC surface stays exactly `getAuthState()` / `setAuthState()` and `getClient()` disappears.
- **Q11:** reactive store (`subscribeAuthState` / snapshot) as a follow-up PR after #208's outcome (C2).
- **Careful:** `auth-common/src/ui.ts`'s `data-testid` strings are public API since #272 — every e2e selector in test apps, templates and native demos depends on the exact strings. And `packages/core/src/redact.ts:22,38,53` keys redaction off auth field names, so **renaming any action or field silently un-redacts secrets from logs**; any rename needs a matching `redact.ts` change and a test (`redact.test.ts:105,118` asserts `'Set Up Authenticator'`).
- **Accept:** conditional-export parity (B3 now enforces `browser`); no `data-testid` changed without updating every consumer.
- **Size:** medium. **Depends:** D2, C2.

### D8 · Upgrade-in-place harness
The proof that existing `AuthCognito` deployments survive. **Run at D3, not only at cutover.**
- New `test-apps/comprehensive/test/upgrade-in-place.ts`, driving `deploy()`/`destroy()` from `@aws-blocks/blocks/scripts`, pinned to one stack via `BLOCKS_STACK_SUFFIX`. It needs a CI home: the production job's per-PR suffix means there is no long-lived stack to upgrade into.
- Steps: deploy pre-refactor (`AuthCognito`) from a `git worktree` → seed a user, sign in, **keep the cookie**, record `userPoolId`/`userSub`/table/SSM names → switch to `Auth` → `cdk diff` shows no replacement on `UserPool` or `UserPoolClient` → **`deploy()` again, same suffix, no `destroy()`** → assert **`UPDATE_COMPLETE`, not `UPDATE_ROLLBACK_COMPLETE`**, surfacing the `UpdateUserPool` error on failure (exactly what `cdk diff` withheld) → assert `userPoolId` byte-identical, seeded user still signs in, table/SSM names unchanged, and **the pre-upgrade cookie is still valid** (not merely "cleanly signed-out") → `destroy()` in a `finally`.
- Run via **tmux + polling**, never as a blocking foreground command (deploys take 2–3 min). Never leave a sandbox running.
- **Accept:** passes against `Auth`; deliberately renaming a child id makes it fail at the `cdk diff` step.
- **Size:** medium. **Depends:** D3.

---

## Stage E — Move consumers onto `bb-auth` (P5). Before anything is deleted.

Parallel after Stage D. Each sub-PR keeps `main` green.

### E1 · Test apps
- `test-apps/comprehensive`: 8 instances (`aws-blocks/index.ts:121,133,136,145,169,219,229,255`), 7 test files, `index.html`, `package.json`. Basic instances are **converted, not kept**.
- Also `hosting-spa`, `hosting-ssr`, `hosting-ssr-nuxt`, `auth-cognito-passkeys`, `native-bindings`, `vpc-smoke` (the only app importing `bb-auth-cognito` directly).
- `amplify-gen2` has only a shadow verifier (`aws-blocks/cognito-verifier.ts:91`) — update it to the new `BlocksAuth` shape. `hosting-ssr-sveltekit` and `db-pull-typecheck` construct no old block.
- **Zero type casts** in customer-representative code. A cast here means a public type is wrong — fix the type in `bb-auth`.
- **Accept:** `test:e2e:local` + sandbox e2e green.
- **Size:** large.

### E2 · `create-blocks-app` templates
- Four templates construct an old block: `default`, `react`, `demo`, `auth-cognito`. `bare`/`backend`/`nextjs` only mention them in comments; `amplify` has the shadow verifier.
- Rename or retire the `auth-cognito` template (`src/index.ts:219`, `README.md:136`, `cli.test.ts:36`).
- Update the shared `resources/AGENTS.md` (L41 describes Basic's instant sign-in — replace with the Q2 verify-then-auto-sign-in flow).
- **Accept:** `npm run test:templates` + `e2e-templates`.
- **Size:** medium.

### E3 · Native SDKs
- Regenerate fixtures with `native/codegen-fixtures/regenerate-all.sh`. The `auth-common` state machine **is** `18-hybrid-arm`; `23-cognito-nested-unions` and `20-multiple-namespaces` are affected too.
- Rewrite the Basic e2e suites: Kotlin `AuthBasicE2ETest.kt`, Swift `AuthBasicE2ETests.swift`, Dart `auth_basic_test.dart`.
- The three hand-written OIDC protocol implementations have **no typecheck against TS** — only native e2e catches drift.
- Fix the phantom `@aws-blocks/bb-auth-supabase@^0.3.34` (`native/swift/Demo/typescript-demo/package.json:30`).
- Close the two coverage gaps found by the baseline (`NATIVE-BASELINE.md`): run native OIDC e2e against `bb-auth`'s local stub IdP, making anything that can't run skip *visibly* rather than pass in 0.000s; and add a check that the auth fixture matches the spec the live block emits.
- **Accept:** every command in `NATIVE-BASELINE.md` passes, at or above baseline counts; fixtures regenerate with no unexplained drift; CI's `native-sdk-e2e`, `native-sdk-swift`, `native-dart-analysis` and `native-kotlin-analysis` would be green.
- **Size:** large.

### E4 · Docs and compiler-invisible references
- Docs: `packages/blocks/README.md` catalog + the **"which option and why" table** (email/password vs social vs OIDC-direct vs OIDC-cognito vs SAML; columns: cost tier, offline dev, groups/`auth.admin`, MFA, PKCE-only IdPs — this is the deliverable that answers the original complaint), `VPC-DESIGN.md`, `docs/design/API-DESIGN.md`, `docs/guides/extending-with-existing-aws-resources.md`, `packages/foundations/README.md:13-45`, `docs/tech-design/BB-auth-cognito-admin*.md`, root `README.md:44`, `bb-kv-store/DESIGN.md`.
- Also stale and misleading to an implementer: `docs/reference/ARCHITECTURE-LAYERS.md` and `building-block-structure.md` still document `infra.ts`/`materialize()`.
- Code refs: `core/src/common/index.ts:56,64` (JSDoc recommends `AuthBasic`), `core/src/errors.ts:119`, `core/src/api.ts:156`, `bb-app-setting/src/secrets-bulk.ts:10`.
- **String-emitted, invisible to the compiler:** `packages/bb-data/src/db-pull/templates.ts:181-215` emits `AuthOIDC` imports as strings inside a markdown fence; `packages/bb-data/src/db-pull.test.ts:282-285` asserts `AuthOIDC` present and `AuthCognito` absent — **that assertion inverts**.
- Agent-bench: `.github/workflows/agent-bench.yml:86,90,93` + `scripts/agent-bench/*` pin tasks to the old templates and blocks.
- **Accept:** every snippet, command, package name and relative link verified at HEAD (AGENTS.md rule 11); `sync-docs:check` and `block-catalog-check` green.
- **Size:** medium–large.

---

## Stage F — Cutover (P6)

> **Execution note (2026-10-03):** F1 is split, because templates and docs import from the umbrella and can't move to `Auth` until the umbrella exports it, while the old packages can't be deleted until templates and docs have moved. Order: **F1a** (`bb-auth` public + exported from the umbrella next to the old blocks) → **E2** (templates) + **E4** (docs) → **F1b** (delete the old packages, consolidate changesets, make `requireRole` required, cookie cutover). Nothing is released between them, so L27's "same release" holds.

### F1 · The breaking release — one PR
**Pre-flight:** release (or delete) every pending changeset naming an old package. Leftovers make this PR fail `changeset-guard validate-structure` with "package name that does not exist in the workspace", and `changeset version` would fail too.
- Flip `bb-auth` public; add to the umbrella (`index.ts`, `index.cdk.ts`, `ui.ts`, `sdk-identifiers.ts` — it has typed overloads for `AuthCognito`/`AuthOIDC` at `:21-22,57-58` — deps + `aws-blocks.vendorize`, `tsconfig.json`, README catalog via `npm run sync-docs`, `API.md` via `npm run update:api`).
- Delete `bb-auth-basic`, `bb-auth-cognito`, `bb-auth-oidc` from root `workspaces`, root `tsconfig.json` and the umbrella. Delete B2's non-gating snapshot with them.
- Regenerate `official-bb-names.generated.ts`; drop the hard-coded `'AuthOIDC'` alias (`scripts/generate-bb-names.mjs:33`). Telemetry names change.
- Delete `scripts/publish/test-local-registry.sh` (hard-codes `bb-auth-basic`, appears unreferenced).
- Make `requireRole` **required** in `BlocksAuth`.
- Nominate a new Composite-BB archetype exemplar (`docs/design/scaffold-new-bb.md:47` names `bb-auth-basic`).
- Amend `docs/DECISIONS.md` decision "D — naming" (L133 already points at two missing files) and root `AGENTS.md:103,110,209`.
- **Cookie cutover:** reject-and-clear **only** the Basic JWT format under `auth_${fullId}`. **Cognito cookies stay valid** — same name, HMAC secret and table, so there is no reason to log those users out. An unparseable cookie never 500s and is never treated as authenticated.
- `conditional-exports.test.ts`'s `>= 8` floor needs no edit (19 BBs discovered today).
- **Accept:** full CI, sandbox e2e, upgrade-in-place. After publish, `npm deprecate` the three old packages pointing at `bb-auth`.
- **Changeset:** one minor covering `bb-auth`, `auth-common`, `blocks`, `core`, `create-blocks-app` and the three removed packages. `changeset-guard block-major` forbids majors; at 0.x a minor is already a hard wall for `^` consumers.
- **Size:** large but mostly mechanical.

### F2 · `MIGRATION.md` + codemod (Q8)
- Per-block before→after, built on the upgrade-consequences table (including the `cognitoFederated()` domain collision and its two-deploy workaround).
- Codemod in `bb-auth`'s **published bin** (`npx @aws-blocks/bb-auth migrate`) — a repo-only script cannot reach customers. Swaps imports/class names, renames changed methods and error names, leaves `TODO`s where a person must decide.
- **It must never rewrite the block `id` argument** — the one change that would destroy a surviving Cognito pool. A fixture test asserts this explicitly.
- Flag every `hasAuthError` / `isBlocksError` call site for manual review, since `InvalidCodeException` splits in two.
- **Accept:** codemod fixture tests, including the `id`-preservation assertion; every `MIGRATION.md` snippet runs.
- **Size:** medium.

---

## Per-PR gates

`npm run lint`, `lint:deps`, `build`, `check:exports-consistency`, `check:api`, `test:unit`, `test:e2e:local`, `publish:local`. CI adds `e2e-templates`, `e2e-sandbox`, `e2e-sandbox-vpc`, `e2e-production`, `e2e-hosting`, `e2e-telemetry`, `changeset-check`, `block-catalog-check`. CDK work synths with `--conditions=cdk`.

**Sandbox e2e required at:** A1, D3 (via D8), D5, D6, E1, F1.

**Review-checklist item for every PR in Stage D and F:** does this change any string literal passed as a child construct id? That is the single edit that silently destroys a user pool.

---

## Abort / rollback criteria

- **D3 acceptance (i) or (ii) cannot be met** — the unified CDK layer can't reproduce `AuthCognito`'s identity and properties. Stop; the "existing deployments survive" premise is broken and the plan needs rework, not a workaround.
- **D8 shows a `UserPool` or `UserPoolClient` replacement** that isn't understood. Stop and diagnose; do not allowlist it.
- **A Stage-D branch exceeds ~1,500 changed lines or two weeks.** Split it.
- Everything through E is additive: `bb-auth` is private and the old blocks are untouched, so abandoning before F1 costs only the new package. **F1 is the point of no return.**
