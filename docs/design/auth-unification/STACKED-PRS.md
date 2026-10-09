# Auth unification: plan for a stack of reviewable PRs

This plan breaks `refactor/auth-blocks` into PRs that each keep `main` green and releasable. It doesn't change any code. Every number here was measured with git on 2026-10-06.

| | |
|---|---|
| Integration branch tip | `a3e1bfb9` (`refactor/auth-blocks`, also `auth/MAIN-SYNC`) |
| Base | `origin/main` @ `12c0ace9` for the analysis below. The branch merged it in `049a49dd`, then merged `da6d4c7d` (12 more commits, R98). The conflict counts below are against `12c0ace9`; re-run §3's check against the current `origin/main` before cutting each PR. |
| What the merge brought | 17 `main` commits, 38 conflicts resolved (R94). Plus FX59 (`5a02dd11`, the #678 port, R93) and the re-frozen `AuthCognito` capture (`69231a25`). |
| Branch size against `main` | 466 commits. 1,015 files, +126,985 / −38,374 lines. Without the deleted packages, lockfile, generated fixtures, API reports and these plan docs, it's 704 files and about 93,500 added lines. |
| Task branches | All 108 task branches exist: the 106 from the plan, plus PUB1-sanitize and FX59. `auth/MAIN-SYNC` points at the tip; `auth/unified-auth-block` isn't a task branch. Each tip is exactly the second parent of its merge on the integration branch. There is no FX47. |

**What I checked against git:**
- the merge order (`git log --first-parent --merges`);
- each task's own diff, simulated onto `12c0ace9` with `git merge-tree --merge-base -X no-renames` (§3);
- which files each PR owns alone, and which it shares with other PRs (§3);
- earlier, a replay of the native groups onto `main` in a throwaway clone.

**Scale.** About 93k reviewable lines can't all fit one-hour PRs at 15–30 PRs. This plan has **33 PRs**:
- 4 are native SDK PRs, which go to different reviewers in parallel;
- 3 pairs can be merged if you want 30 (§2, end).

Each PR lists its **source** size separately. Source is what a reviewer reads closely. Tests and generated fixtures are skimmed.

**What changed since the first version of this plan:** `main` is merged in, so most "hand: … against #…" conflicts are already resolved on the tip, and the recommended way to build PRs is now to **cut them from the tip** (§3). R1 is no longer on the critical path (§4). Five of the earlier splitting risks are resolved (§6).

---

## 1. Principles

1. **Every PR keeps `main` green and releasable.** Each one passes the full per-PR gate on its own:
   - build, lint, `lint:deps`, `check:api`, exports, unit tests, `test:e2e:local`, `publish:local`;
   - `main`'s new `brand-coverage` test (see risk 16);
   - CI's sandbox, production, hosting and native jobs where they apply.
2. **Changesets are released per PR**, as usual. Any PR that changes a published package carries its changeset, and the umbrella gets bumped (`changeset-guard verify-coverage`, `verify-umbrella`). The exceptions are below.
3. **`bb-auth` stays `"private": true` until the cutover.** `changeset-guard` skips private packages (`scripts/changeset-guard.ts:178`), so its PRs need no changeset. Rules:
   - **Don't land any changeset that names `@aws-blocks/bb-auth` before the cutover.** The branch now has **26** of them, including FX59's `auth-wire-safe-error-messages` and the #231 port's `auth-relay-config-error-wire-safe`. They also bump `@aws-blocks/blocks`, so they'd publish umbrella changelog entries about a package that isn't on npm. All 26 are added in PR 31, which makes `bb-auth` public.
   - A branch changeset that names `bb-auth` **and** `core` gets split. The `core` part becomes a core-only changeset in the PR that changes core. This applies to `auth-validate-user-presignup-trigger`, `auth-presignup-trigger-owner` and `auth-hardening-round-2`.
4. **The old blocks get one last patch release before anything moves off them.** This is L7 option (a).
   - PRs 11–13 land on `main` with their *original* changesets, from the task branches;
   - a normal *Version Packages* release (**R1**) ships them as the last `bb-auth-cognito` (0.1.12) and `bb-auth-oidc` (0.2.2) patch;
   - so `a188cdef` (L7 option (b), still on the integration branch) is **not** used in PR 33. R94 corrected its folded text, so it remains a valid fallback if you choose (b).
5. **These ship in one release, with no Version Packages merge in between (L27):**
   - `bb-auth` going public and being exported from the umbrella (F1a);
   - the templates (E2);
   - the customer docs (E4);
   - the removal of the old packages (F1b).

   They are PRs 31, 32 and 33, merged back to back in a freeze window (§5). Nothing that imports `@aws-blocks/bb-auth` from a *published* package (templates, umbrella, customer docs) lands before PR 31. Test apps and native examples are private, so they can move to `Auth` earlier (PRs 29–30).
6. **Independent fixes go first and straight to `main`:**
   - core client, RPC and deploy;
   - data mocks;
   - `bb-file-bucket`;
   - native codegen;
   - test tooling.

   They don't wait for the auth stack, and the auth stack builds on them.
7. **Behaviour changes are signed off where they land, not at the cutover.** That's R88 and R89 (PR 2), L54 (PR 4), FX7's one-handler-per-event-key rule (PR 26), and L71's trade-off (PR 27).
8. **The plan docs (`docs/design/auth-unification/`) aren't part of any PR below.** PUB1-sanitize made them public-safe, but they are working notes about the integration branch. Every recipe excludes that directory. If you want a record on `main`, add `WHAT-CHANGED.md` and the design docs as a docs-only PR next to PR 14.

---

## 2. The stack

How to read the columns:
- **Size** is the tasks' own diffs (`git diff --numstat <merge>^1 <merge>`, summed over the PR's paths). It excludes the plan docs.
- **"src"** is non-test source.
- **Indep.** means it can go straight to `main` now, with no dependency on any `bb-auth` code.
- **Build** says how to make the PR (§3):
  - *cut* means check its files out of the tip; there are no conflicts, because the tip already contains `main`;
  - *split* means some files are shared with another PR, so this PR takes only its own hunks of them. The shared files are named, and the other PR's number is in brackets.

### Track 1: independent fixes (open now)

| # | Title | Tasks | Size | Depends on | Indep. | Risk | Build |
|---|---|---|---|---|---|---|---|
| **1** | core: every `Set-Cookie` survives on the RPC path; error responses forward only clearing cookies; RPC dispatch: A4's two extra cases on top of `main`'s #725 (R98) | A1, A1b, A1c, A4, plus the `core` hunks of FX1, FX7 (`set-cookie.ts` only), FX7b | ~30 files, +1,600 / −120 | — | yes | **High**: RPC wire behaviour (L9); the reachability change itself is already on `main` (#725) | cut 8 files; split `lambda-handler.ts` and its test [25], `set-cookie.ts` and its test [25, 26], `api.ts` [32], `core/README.md` [2, 32], `comprehensive/aws-blocks/index.ts` and `response-cookies.test.ts` [29], `comprehensive/test/e2e.test.ts` [2, 29, 33] |
| **2** | core and data: processes exit, and the Node client retries a stale keep-alive socket once | L8, FX54, `9d1c1c5d`, `e010e83d`, FX55, `d4e9b01a`, FX57 | ~30 files, +1,690 / −70 | — | yes | Medium: at-least-once resend (R88); `deploy()` no longer writes `.bb-data` (R89) | cut 25; split `core/src/common/index.ts` [25, 26, 32], `core/README.md` [1, 32], `comprehensive/test/e2e.test.ts` |
| **3** | CDK helpers: `deployTimeLambdaCode`; vendorized `DistributedTable` / `Database` / `DistributedDatabase` synth; `AppSetting` `parameterName` | A5 without `packages/bb-auth`; D3c's `bb-app-setting` part | ~14 files, +590 / −73 | — | yes | Low | cut 10; split `core/src/cdk/index.ts` and `core/src/index.cdk.ts` [16], `vendorize.test.ts` [29], `docs/guides/extending-with-existing-aws-resources.md` [32] |
| **4** | `bb-file-bucket` shortens over-long derived names; `Agent` uses the derived name | FX11, FX58, plus PUB1-sanitize's 3 test files | 21 files, +360 / −59 | — | yes | Medium: reverses D-FB-8 (L54) | cut 17; split `bb-agent/src/index.cdk.ts` [5] |
| **5** | Conditional-export parity checked in both directions; tsconfig reach | B3 | 14 files, +364 / −47 | — | yes | Low | cut 9; split `bb-agent/src/index.cdk.ts` [4], root `tsconfig.json` [14, 33], `conditional-exports.test.ts` [33] |
| **6** | Test and release tooling: `publish:local` starts clean; `test:templates` ignores `~/.npmrc`; hosting e2e waits for hydration and deploys in Playwright `globalSetup` | FX6, FX4 (`scripts/test-templates-e2e.sh` only), FX15, FX18, FX56 | ~50 files, +1,110 / −120 | — | yes | Low. **Must land before PR 29** (R90) | cut 44; split the hosting apps' `test/e2e.test.ts` and `hosting-spa/package.json` [29] |

### Track 2: native codegen (open now, in parallel; Kotlin, Swift and Dart reviewers)

The merge already did the hand-merges with #656 (Swift) and #691 (Dart), renumbered the branch's fixtures to **27–35**, and regenerated every golden. So these PRs are now mostly *cut*. New fixtures still can't land one language at a time (each language's golden test fails on a missing golden), so PRs 7–9 carry generator and runtime code plus their own language's goldens for fixtures 01–26, and PR 10 adds 27–35.

| # | Title | Tasks | Size | Depends on | Indep. | Risk | Build |
|---|---|---|---|---|---|---|---|
| **7** | Kotlin codegen and runtime: nested inline objects, `unknown` → `JsonElement`, transferables everywhere, union wire format, name collisions, RPC wire slots; CI compiles goldens | FX9 (Kotlin), FX12, FX19, FX24, FX27, FX29, FX32, FX36, FX42, FX45, FX51 (Kotlin) | 57 files, +6,197 / −382 (src +2,303 / −378), plus Kotlin goldens | — | yes | Medium: generated API changes (L59) | cut 58 files (including `docs/native-clients/schema-generation-guide-for-devs.md`); split `OidcClient.kt` and `native/kotlin/README.md` [30]; **regenerate** fixture 18 and 23 goldens against `main`'s spec |
| **8** | Swift codegen and runtime: nested names, `JSONValue`, public inits, typed literals, ISO dates, sorted-key encoding, name collisions; `UnknownTransferable` kept from #656; CI compiles goldens | FX9 (Swift), FX16, FX20, FX22, FX23, FX25, FX28, FX35, FX37, FX46, FX50, `bf907d9d` | ~57 files, ~+7,300 / −650 (src ~+2,200 / −650), plus Swift goldens (including `26-unknown-transferable`, which gains a `public init`) | — | yes | Medium: generated API changes (L55, L60, L63) | cut 80; split `BlocksClient.swift` and `OIDCClient.swift` [30]; regenerate 18 and 23 |
| **9** | Dart codegen and runtime: recursive decode, deep equality, escaping, positional params (`BlocksClient.call(Object)`), transferable params; CI analyzes goldens | FX9b, FX13, FX17, FX21, FX30, FX33, FX38, FX40, FX41, FX48 | ~34 files, ~+7,300 / −600 (src ~+1,800 / −590), plus Dart goldens (including `26-unknown-transferable`, now positional) | — | yes | Medium: `blocks_runtime` and `blocks_codegen` must release together (L57, L65) | cut 55; split `blocks_runtime/CHANGELOG.md` and `oidc_client.dart` [30]; regenerate 18 and 23 |
| **10** | Shared codegen fixtures 27–35, and Kotlin round trips for 34–35 | fixture dirs added by FX9 … FX42 (renumbered in `049a49dd`); FX51's README | ~70 files, ~+9,900 (9 `spec.json` ≈ +2,070, the rest generated) | 7, 8, 9 | yes | Low | cut `native/codegen-fixtures/{27..35}-*`, `regenerate-all.sh`, `native/kotlin/fixture-goldens/round-trips/3{4,5}-*`; split `codegen-fixtures/README.md` [30] |

FX35, FX38 and FX48 also edited native e2e and example call sites. On the tip those suites are already on `Auth` (PR 30), so PRs 7–9 must still port the call-site change by hand to `main`'s pre-`Auth` suites (risk 5).

### Track 3: old auth blocks and `auth-common` (open now; released in R1)

| # | Title | Tasks | Size | Depends on | Indep. of `bb-auth` | Risk | Build |
|---|---|---|---|---|---|---|---|
| **11** | `AuthCognito` resource-identity tripwire, `AuthOIDC` snapshot, offline tests for the Cognito AWS layer | B1, B5 | 15 files, +3,068 / −62 (tests only) | — | yes | Low | **replay** (the tip has deleted these packages, so there's nothing to cut). Clean against `main`. |
| **12** | `AuthCognito`: six defects (3 security); `AuthOIDC` README drops the false federated-MFA claim | B6, A2 | 21 files, +1,193 / −273 | 11 | yes | **High**: security review (L11) | **replay**. Hand-merge `bb-auth-cognito/src/index.aws.ts` with #678 (keep both #678's message table and B6's scrubbing); `auth-common/DESIGN.md` |
| **13** | `auth-common`: canonical `AuthErrors` contract; `submitAuthAction` and the reactive auth store (#208's requirements) | C1; D7's `auth-common` / `blocks` / `docs` parts | 22 files, +2,537 / −337 | — | yes | Medium: `ui.ts` `data-testid` and redaction keys are public API | split almost everything: `auth-common` `index.ts`, `ui.ts`, `errors.ts`, README/DESIGN/API [23, 32, 33], `blocks/src/ui.ts`, `ui.test.ts`, `package.json`, README [31, 32, 33], `docs/DECISIONS.md` [32]. Hold the 2 lines naming `bb-auth` for PR 32 |

### Track 4: `bb-auth`, private (a stack: merge in order, review two or three at a time)

Each PR is the integration branch's `packages/bb-auth` change across a run of merges. Every merge was green on the integration branch, so each layer is a known-good state. **Build:** *replay* the task merges for `packages/bb-auth`. `main` has no `packages/bb-auth`, so the only conflicts with `main` are `package-lock.json` and D7's `auth-common` docs. Then pull down the merge's `bb-auth` fixes named below.

Fixes come later as hardening PRs (25–27), not folded back. Reviewers of 14–24 should know that 25–27 change some of what they read. **The stack must end exactly at the tip:** after PR 27, `git diff a3e1bfb9 -- packages/bb-auth` may show only the hunks that belong to 31–33 (the `private` flag, the README, the frozen-only tests).

| # | Title | Tasks | Size (src) | Depends on | Risk | Reviewers focus on |
|---|---|---|---|---|---|---|
| **14** | Package skeleton, mode-gating types gate, CDK layer identity-identical to `AuthCognito`, browser entry | D1, D3a, D7 (`bb-auth` part); **take the tip's dependency ranges** in `bb-auth/package.json` (core ^0.6.0, `auth-common` ^0.1.9, …; R94) | 44 files, +5,877 (src +2,367) | 5, 11, 13 | **High** | Child construct ids, `userPoolName`, no `GenerateSecret` on `client`; the variance guard in `types-test.ts` |
| **15** | `AuthBase`: sessions, cookies, guards, state machine, engine interfaces | D5a | 28 files, +5,730 / −252 (src +3,513) | 1, 14 | High | Cookie reader (anchored, constant-time), cookie name compatibility with `AuthCognito`; review by its first commit `be13c758` |
| **16** | Immutability guard (synth baseline plus deploy-time custom resource); fail synth when a pool-owning block is renamed or removed; core synth baselines | D4, D4b (includes `core/src/cdk/baselines.ts`, changeset `core-orphaned-baseline-check`) | 25 files, +3,170 (src +1,367) | 14 | High | The negative tests (allowed changes still pass); baseline file format (on-disk: breaking if changed later) |
| **17** | Native Cognito engine, core flows, plus the offline harness | D5c | 17 files, +4,504 (src +1,126) | 15 | Medium | Error mapping, IAM per call, lazy SDK client |
| **18** | Local user-pool engine and the native account and admin surface | D5b | 27 files, +5,434 / −93 (src +3,831) | 17 | Medium | Mock↔Cognito parity; prototype-safe storage |
| **19** | Federation infra: hosted-UI client, domain, IdP registration | D3b | 17 files, +2,395 (src +1,176) | 18 | High | Separate client construct (never the existing `client`); domain-prefix derivation |
| **20** | Direct OIDC engine, stub IdP, federation routes; **#231 port** | D6a; from `049a49dd`: `relay.ts`'s `brandBlocksError`, the wire-safety test in `federation-direct.test.ts`, `FakeIdp`'s `tokenResponse` hook | 27 files, +5,330 / −120 (src +3,215) | 19 | High | PKCE, JWKS, `state`/`nonce`; no root route or wildcard; no raw IdP text on the wire. **`relay.ts` lands here unbranded at D6a, so the port must come with it** (risk 16) |
| **21** | Hosted-UI federation; AWS engine full surface; bearer tokens in the guards; CDK clean-ups | D6b, D5c2, D3c (`bb-auth`), D6c | ~60 files, +6,007 / −436 (src +1,886) | 3, 20 | Medium | `federateVia`, per-provider engine choice, `allowBearerAuth` reach |
| **22** | Codemod (`npx @aws-blocks/bb-auth migrate`) and `MIGRATION.md` | F2; from `049a49dd`: the codemod's `FILE_ALLOWLIST` entries in `packages/blocks/src/brand-coverage.test.ts`, and `migrate-e2e/auth-cognito-template.ts.txt` refreshed from `main`'s template (#684) | 46 files, +4,900 (src +2,798, rest fixtures) | 21 | Medium | Never rewrites the block `id`; `TODO`s where a person decides |
| **23** | Unknown/misplaced options rejected; mock usernames match Cognito; deploy-time Lambdas work vendorized; `AuthUser.displayName` | D5d, D1b, F1c, A5 (`bb-auth` part), D7b (`bb-auth` and `auth-common`) | ~35 files, +2,494 / −322 | 3, 22 | Low | `auth-common`'s `displayName` is additive (patch changeset, `auth-common` only) |
| **24** | Freeze `AuthCognito`/`AuthOIDC`'s outputs as committed fixtures, with proof tests against the live packages | F1b step 1 (`13c86d34`) **plus the re-freeze `69231a25`** (`SSESpecification` and `PointInTimeRecoverySpecification` from #635) | 21 files, +12,160 / −175 (generated, plus proof tests) | 11, 12 | Low (was Medium) | Proof tests 17/17 against `main`'s old packages; nothing to regenerate if 11 and 12 match the tip |
| **25** | Hardening I: open redirect closed; stub IdP `/logout` checks; first-baseline pool warning; account-state masking; `validateUser` PreSignUp trigger, with core Cognito-trigger routing | FX1, FX1b, FX4 (`bb-auth`), FX3, FX2 (plus `core/src/lambda-handler.ts`, `common/index.ts`; core-only changeset, minor) | ~70 files, +3,944 / −122 (src +1,278) | 24 | **High** | Redirect validation; masking parity (L45); trigger fails closed; the 5-second limit (L46) |
| **26** | Hardening II: codemod fixes; trigger ownership; one Lambda event handler per key (core); constant-time checks; deployable stub IdP behind `unsafeAllowDeployed`; stub IdP accepts only registered clients | FX5 (`bb-auth`), FX7 (plus core `common/index.ts`; core-only changeset), FX7b, FX8 (`bb-auth`), FX10 | ~110 files, +3,577 / −398 (src +1,464) | 25 | **High** | Core now **throws** on a second handler for one event key (behaviour change); L51, L44 |
| **27** | Mock↔Cognito attribute and account parity; boolean options type-checked; **wire-safe Cognito messages (FX59, the #678 port)** | FX26, FX31, FX34, FX39, FX43, FX44, FX49, FX53, `cf05b9ed`, **FX59 (`5a02dd11`)** | ~78 files, +4,250 / −285 (src +1,094) | 26 | Medium | Error precedence identical on both engines; `CLIENT_ERROR_MESSAGES` / `clientMessageFor` cover every name; **L71** (clients lose which password rule failed) |
| **28** | Upgrade-in-place harness (`AuthCognito` → `Auth`), pinned to the last `AuthCognito` release | D8, F1d, PUB1-sanitize (`upgrade-in-place.ts`), tip's pin (`@aws-blocks/bb-auth-cognito@0.1.11`) | 22 files, +3,767 / −27 | 16, 27 | Medium | Pin (re-pin to 0.1.12 after R1, risk 11); refuses a vacuous comparison; always `destroy()` in `finally` |

### Track 5: consumers on `Auth`, private (before the cutover)

| # | Title | Tasks | Size | Depends on | Risk | Reviewers focus on |
|---|---|---|---|---|---|---|
| **29** | Test apps on `Auth`: `comprehensive` (8 instances), hosting apps, passkeys, `amplify-gen2`, `vpc-smoke`; test-only RPCs gated behind `testSupport` | E1a, E1b, E1c, E1d, E1e, FX14, FX52, plus the test-app hunks of FX1, FX2, FX3, FX5 (`db-pull-typecheck`), FX8, FX10, FX39 and PUB1-sanitize (`sandbox-admin-e2e.ts`) | ~95 files, +2,894 / −886 | 6, 27, R1, **CI SSM grant** | Medium | **Zero casts** in customer-shaped code; test counts preserved; no ungated admin IAM. Cut 40 files; the 9 shared ones are with 1, 2, 3, 6, 28, 33. |
| **30** | Native SDKs, examples and `native-bindings` on `Auth`; real local and deployed OIDC e2e; live auth-fixture check | E3a, E3b, A6 (native), FX8 / FX1 (native and `native-bindings` hunks), D7b (fixture 18), `79ae1b42`, `3c0ce21d`, the native e2e files the merge renumbered | ~120 files, +3,485 / −1,104 | 10, 27 | Medium | Cut 70 files; take the tip's goldens for fixtures 18 and 23 (`Auth`'s spec); nothing skips silently |

### Track 6: the cutover (one release; merged back to back, see §5)

| # | Title | Tasks | Size | Depends on | Risk | Reviewers focus on |
|---|---|---|---|---|---|---|
| **31** | `bb-auth` public and exported from the umbrella; `create-blocks-app` templates on `Auth` (`auth-cognito` → `auth`, alias kept); per-user data keyed by `userSub` | F1a, E2, A6 (templates), D7b (templates), FX5 (`blocks` `sdk-identifiers`, `create-blocks-app`), **plus the 26 held `bb-auth` changesets** | ~90 files, +1,153 / −616, plus changesets | 28, 29, 30 | High | Export map, `sdk-identifiers` overloads, `official-bb-names`; template e2e. Cut 102 files; the templates already merge `main`'s #684 / #703 / #231 changes on the tip. |
| **32** | All docs on `Auth`; the "which option and why" table; string-emitted references (`db-pull` templates); agent-bench | E4, FX5 (`auth-common` docs, `bb-data` `db-pull`, agent-bench); D7's 2 held lines | ~48 files, +719 / −1,123 | 31 | Medium | Every snippet and link correct at HEAD (rule 11); `sync-docs:check`, `block-catalog-check` |
| **33** | Remove `bb-auth-basic`, `bb-auth-cognito`, `bb-auth-oidc`; `requireRole` required; cutover changeset | F1b steps 2–4 (`c68b2049`, `219608cc`, `d101f15b`, `3bf9cae7`), **without `a188cdef`** | ~165 files, +149 / −37,200 (the three packages, including `main`'s new `oidc-client-engine.test.ts` from #231) | 32 | High (point of no return) | Nothing else deleted; leftover old-package changesets; frozen fixtures still pass. Cut: after 32, every remaining difference from the tip outside the plan docs belongs here. |

**If you want fewer PRs**, merge 4 + 5, 11 + 12 and 31 + 32 to get 30. Don't merge 19 + 20: together they're 7.7k lines. **If you want smaller ones**, split each native PR (7–9) at the point where its CI-compile gate lands (FX24 / FX23 / FX13), and split 15 into its first commit plus the rest.

### Task → PR map (every task lands exactly once)

| PR | Task merges (integration SHA) |
|---|---|
| 1 | A1 `797a5951`, A1b `8923a6aa`, A1c `7a9b93d4`, A4 `4919ddde`; core hunks of FX1 `c3bb68cc`, FX7 `6bcdca4f`, FX7b `d18be9ee` |
| 2 | L8 `2f7a296b`, FX54 `cb26868e`, `9d1c1c5d`, `e010e83d`, FX55 `4a70679e`, `d4e9b01a`, FX57 `c7bf7db7` |
| 3 | A5 `5b924e89` (non-`bb-auth`), D3c `c8c96398` (`bb-app-setting`) |
| 4 | FX11 `4debf99f`, FX58 `85ce3e21`; PUB1-sanitize `ec7a53ea` (`bb-agent`, `bb-file-bucket` tests) |
| 5 | B3 `bc13a335` |
| 6 | FX6 `b1c25ddc`, FX4 `fe883f36` (script), FX15 `687826ce`, FX18 `74627f44`, FX56 `7de03acf` |
| 7 | FX9 `80263173`, FX12 `4cc4f7c8`, FX19 `eac992d9`, FX24 `9b834cb5`, FX27 `dd165ab6`, FX32 `27f6d254`, FX29 `861a03fc`, FX36 `d575bc94`, FX42 `28ea0128`, FX45 `3d01c3d9`, FX51 `8ddd015a` (Kotlin paths) |
| 8 | FX9, FX16 `0ca2c3dc`, FX20 `bc3d7ec8`, FX22 `46aff4f9`, FX23 `ebbec7f7`, FX25 `bf6d685c`, FX28 `fc228a78`, FX35 `6b69985b`, FX37 `d9eee648`, FX46 `f8813f0f`, FX50 `17b9cf69`, `bf907d9d`, FX51 (Swift paths); #656 resolution from `049a49dd` |
| 9 | FX9b `3c0ef3f8`, FX13 `5493e24e`, FX17 `b7d587f7`, FX21 `d0706f55`, FX30 `c96c8e9c`, FX33 `cdf5cdae`, FX38 `07e542f6`, FX40 `8f7d3049`, FX41 `922d4c47`, FX48 `5972b320` (Dart paths); #691 resolution from `049a49dd` |
| 10 | new fixture dirs from the merges in 7–9, as renumbered in `049a49dd`; FX51 (`codegen-fixtures/README.md`) |
| 11 | B1 `99fee908`, B5 `2e5773b9` |
| 12 | B6 `0a7396f8`, A2 `6f182ec8` |
| 13 | C1 `6049063f`, D7 `0d6b071a` (non-`bb-auth`) |
| 14 | D1 `a3dfea54`, D3a `8edbc63b`, D7 `0d6b071a` (`bb-auth`); `049a49dd` (`bb-auth/package.json` ranges) |
| 15 | D5a `bd796943` |
| 16 | D4 `feb37bbc`, D4b `2168c77f` |
| 17 | D5c `0eef8cfe` |
| 18 | D5b `3a32f33f` |
| 19 | D3b `44fe386f` |
| 20 | D6a `14640e92`; `049a49dd` (`relay.ts`, `federation-direct.test.ts`, `fake-idp.ts`) |
| 21 | D6b `d496d56a`, D5c2 `1546153f`, D3c `c8c96398` (`bb-auth`), D6c `079454d4` |
| 22 | F2 `320321d2`; `049a49dd` (`brand-coverage.test.ts` allowlist, `migrate-e2e` template fixture) |
| 23 | D5d `14535b36`, D1b `463a247f`, F1c `55041568`, A5 (`bb-auth`), D7b `6ea2a98f` (`bb-auth`, `auth-common`) |
| 24 | F1b step 1 `13c86d34`, re-freeze `69231a25` |
| 25 | FX1 `c3bb68cc`, FX1b `3d9281e2`, FX4 `fe883f36` (`bb-auth`), FX3 `314fce18`, FX2 `711517eb` |
| 26 | FX5 `41665df5` (`bb-auth`), FX7 `6bcdca4f`, FX7b `d18be9ee`, FX8 `fb2fac82` (`bb-auth`), FX10 `95174bcd` |
| 27 | FX26 `99582f38`, FX31 `19a490c5`, FX34 `1dd841f2`, FX39 `38d83fb9`, FX43 `40720551`, FX44 `1230ec20`, FX49 `640b4aa8`, FX53 `91e88eac`, `cf05b9ed`, FX59 `5a02dd11` |
| 28 | D8 `1968c87e`, F1d `c443319e`; PUB1-sanitize `ec7a53ea` (`upgrade-in-place.ts`); `049a49dd` (the 0.1.11 pin) |
| 29 | E1a `9cd33d7b`, E1b `2663e497`, E1c `3ce8df33`, E1d `cca5dce3`, E1e `7210a5d2`, FX14 `688e29f9`, FX52 `1f002a19`; test-app hunks of FX1, FX2, FX3, FX5, FX8, FX10, FX39, PUB1-sanitize (`sandbox-admin-e2e.ts`) |
| 30 | E3a `2032d91a`, E3b `7159546b`, A6 `40f4c5f2` (native), `79ae1b42`, `3c0ce21d`; native hunks of FX1, FX8, D7b |
| 31 | F1a `1b10aa96`, E2 `678d8208`, A6 (templates), D7b (templates), FX5 (`blocks`, `create-blocks-app`); `049a49dd` (template resolutions); the 26 `bb-auth` changesets |
| 32 | E4 `cf20bfe7`, FX5 (docs, `bb-data`, agent-bench) |
| 33 | F1b `0c315c4a` steps 2–4 (not `a188cdef`) |
| — | C2 `92f1ce94`, the plan-doc hunks of PUB1-sanitize and `049a49dd`, and every `docs(auth)` first-parent commit: plan docs only, not in any PR (principle 8) |

---

## 3. Building each PR

### Conflict check against `12c0ace9`

I replayed each task's own diff (`M^1..M`) onto `12c0ace9` with `git merge-tree --merge-base=M^1 -X no-renames`, ignoring the plan docs. Results, for the 108 task merges (excluding the `main` merge itself):

| Result | Tasks | What it means |
|---|---|---|
| Clean | 17: A2, A4, B1, B5, C1, C2, D1, D8, E1b, E3a, FX6, FX11, FX12, FX15, FX55, FX58, L8 | Applies as is |
| Only "modify/delete" | 23, nearly all `bb-auth` tasks (D5a, D4b, D5b, …) and FX59 | They touch files an earlier task creates. Replaying in stack order makes these go away. |
| Content conflicts | 68 | Against `main` or against an earlier task's edit of the same lines: core RPC, templates, test apps, native generators, Dart CHANGELOGs, `package-lock.json` |

That's about the same as against `b8ec5834`, and it's expected: the task branches didn't change. **The `main` merge resolved these conflicts on the tip, not on the task branches.** So replaying task branches would hit all of them again, and you'd resolve 38 conflicts a second time and might resolve them differently.

### Recommendation: cut PRs from the merged tip, replay only where you must

The tip contains `12c0ace9`. So `git diff 12c0ace9 a3e1bfb9` is the whole branch on top of current `main`, with every conflict already resolved, FX59 and the #231 port in, fixtures renumbered and goldens regenerated. Of the 1,030 files that differ (renames off, plan docs excluded):

| | Files | How to build |
|---|---|---|
| Owned by one PR | ~775 (75%) | **Cut:** `git checkout a3e1bfb9 -- <files>` on a branch from `main`. No conflicts, by construction. |
| Shared only within the `bb-auth` layers (PRs 14–27) | ~83 | **Replay** the task merges in stack order (`main` has no `bb-auth`, so this doesn't conflict with `main`) |
| Shared with another PR | ~76, plus 5 changesets | **Split:** listed in each PR's Build column in §2 |
| Created or renamed by the merge itself | ~83 (fixtures 27–35, a few e2e files, one doc) | Assigned to PRs 7, 10 and 30 in §2 |

Use the merge commit, not the task branch, for every PR outside Track 4, and for Tracks 1–3 except 11 and 12 (those change packages the tip has deleted).

```bash
TIP=a3e1bfb9
BASE=$(git merge-base origin/main "$TIP")      # 12c0ace9 today
git switch -c pr/NN origin/main

# 1. Files this PR owns outright: take them from the tip.
#    The owned list is `git diff --name-only $BASE $TIP -- <this PR's paths>`
#    minus the shared files named in §2.
git checkout "$TIP" -- <owned files>
git rm -q <owned files the tip deletes>        # PR 33 only

# 2. Shared files: the LAST PR that touches a file takes the tip's version.
#    An earlier PR starts from main's file and adds only its own hunks:
PATHS=(<shared file>) replay <this PR's task merges>
#    Resolve any conflict toward the tip's version of those lines. Then
#    `git diff $TIP -- <shared file>` must show only the later PRs' hunks.

# 3. Rebuild the lockfile and anything generated; run the gate.
npm install --package-lock-only && npm install   # second run must change nothing
```

`replay` is unchanged from the first plan. It needs renames off: after the cutover, git otherwise shows new `bb-auth` files as renames of deleted `bb-auth-cognito` files.

```bash
replay() {   # usage: PATHS=(...) replay <sha>...
  for m in "$@"; do
    git -c diff.renames=false diff --binary "$m^1" "$m" -- "${PATHS[@]}" \
        ':!docs/design/auth-unification' | git apply -3 --index || return 1
    git commit -m "$(git log -1 --format=%s "$m" | sed -E 's/^Merge auth\/([^: ]+):? ?/\1: /')" \
               -m "Replayed from $m on refactor/auth-blocks."
  done
}
```

### Per track

| PRs | How |
|---|---|
| 1–6 | Cut and split as listed. The merge's conflict resolutions (#685's `rawRouteErrorFromCatch` with A1's `toProxyResponseHeaders`, #231's `reTagged` errors with FX57's PGlite exit handling, `bb-agent`'s two re-export lines) come for free in the cut files. |
| 7–9 | Cut `native/<lang>` (without `e2e` / `example` / `Demo` / `BlocksE2ETests`), the language's CI workflow, and its goldens for fixtures 01–17, 19–22, 24–26. For fixtures 18 and 23, regenerate against `main`'s spec: the tip's goldens use `Auth`'s spec and belong to PR 30. Split the OIDC runtime files: keep their codegen hunks and leave E3a/E3b's (`forAuth`, `OIDCClient` / `oidc_client` changes) for PR 30. Port the e2e call-site changes to `main`'s suites by hand. |
| 10 | Cut `native/codegen-fixtures/{27..35}-*`, `regenerate-all.sh`, the Kotlin round trips for 34–35, and the README's fixture table. |
| 11, 12 | Replay (`PATHS=(.)`). 11 is clean. 12 hand-merges `index.aws.ts` with #678. |
| 13 | Split, mostly by replaying C1 and D7 with `PATHS=(packages/auth-common packages/blocks docs .changeset)`. Use the tip's files as the reference for every conflict. |
| 14–27 | `PATHS=(packages/bb-auth tsconfig.json package.json scripts packages/core)` and `replay` in map order. Leave F1a's `"private": false` and E4's README hunk out. Don't replay any `.changeset/auth-*.md` (held for 31); write core-only changesets for 16, 25 and 26. Then `git checkout $TIP --` the merge's `bb-auth` fixes at the PR named in §2: `package.json` ranges (14), `relay.ts` / `federation-direct.test.ts` / `fake-idp.ts` (20), `brand-coverage.test.ts` allowlist and `migrate-e2e` fixture (22), `__fixtures__/authcognito-templates.json` / `legacy-fixtures.ts` (24), FX59's files (27). End check after 27: `git diff $TIP -- packages/bb-auth` shows only 31–33's hunks. |
| 24 | Cut the tip's `packages/bb-auth/src/__fixtures__/` and the proof test. Don't re-run the freeze unless the proof fails. |
| 28 | Cut `upgrade-in-place*` and `.github/workflows/upgrade-in-place.yml` (the tip pins 0.1.11). Split `.gitignore`, root `package.json` and `comprehensive/package.json` with 14, 29 and 33. |
| 29–30 | Cut what they own; split the files shared with 1, 2, 3, 6 and 7–10 as listed. |
| 31–33 | Cut. By PR 33, every remaining difference from the tip outside the plan docs should belong to it: check with `git diff $TIP -- . ':!docs/design/auth-unification'`. |

**Rebuild a missing branch:** every integration merge is `--no-ff`, so `git branch auth/<TASK> <merge>^2` restores any task branch. With the cut approach, branches are only needed for Track 4, 11 and 12.

---

## 4. Ordering and parallelism

```
now ─┬─ Track 1: 1 2 3 4 5 6 ........................ all in parallel
     ├─ Track 2: 7 8 9 (parallel) ──► 10
     └─ Track 3: 11 ──► 12        13 (parallel with 11)
                  │      │
                  │      └──────────────► R1: Version Packages (last old-block patch) ──► needed by 29
                  ▼
 Track 4 (merge in order): 14 ► 15 ► 16 ► 17 ► 18 ► 19 ► 20 ► 21 ► 22 ► 23 ► 24 ► 25 ► 26 ► 27 ─┬─► 28 (upgrade harness) ─┐
                                                                     (24 needs 11, 12)             ├─► 29 (needs 6, R1, SSM) ─┤
 Track 5:                                                                                          └─► 30 (needs 10) ─────────┤
 Track 6 (freeze window):                                                                              31 ► 32 ► 33 ◄─────────┘
```

- **Open at once:** all 13 PRs in Tracks 1–3. Open Track 4 as a stack of drafts, each based on the one below. Review two or three ahead of the merge point. Reviews can overlap; merges can't.
- **Hard prerequisites:**
  - 14 needs 5 (parity), 11 (D3a's test reads B1's fixture from `bb-auth-cognito/src/__fixtures__`) and 13 (`AuthErrors` from `auth-common`);
  - 15 needs 1;
  - 21 and 23 need 3;
  - 24 needs 11 and 12 (the frozen side must match `main`'s old packages);
  - 29 needs 6, R1 and the CI SSM grant;
  - 30 needs 10;
  - 31 needs 28, 29 and 30.
- **Critical path:** 13 → 14 → … → 27 → (28, 29 and 30 side by side) → 31 → 32 → 33. That's 19 sequential merges, about four weeks at one merge per working day.
- **Changes from the first plan:**
  - **R1 is off the critical path.** The freeze no longer has to be redone after R1, and the pin is already current, so R1 only has to happen before 29.
  - Building the PRs is faster: most are cuts, and none re-resolves the 38 conflicts.
  - Tracks 1 and 2 and PR 11 still run alongside everything.
- **Why R1 sits before PR 29:** PR 29 moves the test apps off the old blocks. After it, the old blocks have no e2e coverage on `main`. Release their last patch while they still do.

---

## 5. Release plan

| When | Release | What it ships | Notes |
|---|---|---|---|
| As Tracks 1–3 merge | normal Version Packages releases | core, data, `bb-file-bucket`, `bb-agent`, `bb-app-setting`, `auth-common`, umbrella. Native SDKs through their own changesets (Kotlin, Swift) and `## Unreleased` (Dart) | Release notes: L9 and **L37** (PR 1), R88 and R89 (PR 2), L54 (PR 4). **Dart: release `blocks_runtime` and `blocks_codegen` together, and raise codegen's runtime constraint** (PR 9; L57, L65). Swift changes ship as minor (L55, L60, L63). |
| **R1**, after PRs 11–13 | normal Version Packages | **Last patch of `bb-auth-cognito` (0.1.12) and `bb-auth-oidc` (0.2.2):** B6's three security fixes, A2's corrected docs, B1/B5 tests | This is L7 option (a). Then re-pin the upgrade harness to `0.1.12` (one line in PR 28, or a follow-up). |
| During Tracks 4–5 | normal releases | core changes from PRs 16, 25, 26 (core-only changesets); `auth-common` patch from 23 | No `bb-auth` changesets. `bb-auth` gets no version and nothing on npm. |
| **R2 (the cutover)**, after PR 33 | one Version Packages release | `bb-auth` first publish; `auth-common` (`requireRole` required), umbrella, core, `create-blocks-app` minors; old packages gone | One minor (`changeset-guard block-major` forbids majors; at 0.x a minor is already a hard wall). |

### Release-day checklist for R2

**Before the freeze**
1. Decide the open items that change PR 31–33 content: L41 (`AuthState.user` wire shape), L51 (codemod and `unsafeAllowDeployed`), L64 (by-name params), L66 (`forceAliasCreation`), L71 (wire-safe message detail). The rest are release-note text.
2. Merge the pending Version Packages PR, so R2 holds only the cutover.
3. Check for leftover old-package changesets: `grep -lE "bb-auth-(basic|cognito|oidc)" .changeset/*.md` must be empty. If not, fold them the way `a188cdef` does. Otherwise `changeset-guard validate-structure` and `changeset version` both fail.
4. Run the upgrade-in-place workflow (PR 28) from `main` against the R1 tag: `UPDATE_COMPLETE`, no replacement, pre-upgrade cookie still valid.

**The freeze**

5. Tell maintainers: no Version Packages merge until step 9. Other merges should wait too, or rebase onto 31–33.
6. Merge **31 → 32 → 33**, each one green, the same day.

**Verify, then release**

7. From `main` HEAD, run:
   - `test:e2e:sandbox`, the production preset e2e and `e2e-hosting` (Next.js, SPA, Nuxt);
   - native sandbox (Swift, Dart, Kotlin with `RUN_OIDC=1`);
   - templates e2e;
   - codemod `migrate` and `migrate-e2e`.

   Destroy every stack.
8. Check: `publish:local` lists `bb-auth` and none of the three old packages; offline `--conditions=cdk` synth of `comprehensive` in both presets.
9. Merge the Version Packages PR, so publishing runs.
10. Check:
    - `npm view @aws-blocks/bb-auth version` returns a version;
    - `npm create @aws-blocks/blocks-app@latest` (default, react, demo, auth) installs and builds;
    - `npx @aws-blocks/bb-auth migrate --help` runs.
11. `npm deprecate` `@aws-blocks/bb-auth-basic`, `@aws-blocks/bb-auth-cognito` and `@aws-blocks/bb-auth-oidc`, pointing to `@aws-blocks/bb-auth` and `MIGRATION.md` (R35).
12. Release notes:
    - L43: deployed email+password coverage is narrower than `AuthBasic`'s was;
    - L45: account-existence signals masking can't remove;
    - L71: clients now get fixed messages, matching `AuthCognito` 0.1.11;
    - L11: B6 already shipped in R1;
    - L37: resolved by `main`'s #725 (R98).

**Done before PR 29, not on release day:** grant the CI role `ssm:GetParameter` and `kms:Decrypt` on the test-support secret (L35). PR 29 needs it for `e2e-hosting`, and also for `comprehensive`'s sandbox and production jobs: `test/read-test-support-secret.ts` reads the same kind of SSM secret (FX14, FX52; L70).

---

## 6. Risks of splitting

### Resolved on the integration branch (the cut PRs inherit the fix)

| # | Risk (first plan) | Now |
|---|---|---|
| 1 | `main` moved 16 commits; 35 conflicting files | **Resolved for `12c0ace9`:** the merge `049a49dd` resolved 38 conflicts (R94), and cut PRs apply with none. *Still open:* `main` will move again. If it does before a PR merges, merge `main` into the integration branch again and re-cut, rather than rebasing each PR by hand. |
| 2 | Lockfile churn | **Mostly resolved:** the tip's lockfile is `main`'s, resynced, and FX4a's fix is dropped. *Still open:* each PR adds only its own workspaces, so run `npm install --package-lock-only` per PR, and check that a plain `npm install` then changes nothing. |
| 3 | Changesets #571 released; `a188cdef` re-announcing shipped fixes | **Resolved:** the two released changesets are gone, and `a188cdef`'s folded text no longer repeats 0.1.11 / 0.1.10 (R94). *Still open:* the 26 held `bb-auth` changesets (principle 3), and old-package changesets must ship in R1 or be folded at PR 33. |
| 4 | Fixture 26 taken twice | **Resolved:** the branch's fixtures are 27–35, and every golden was regenerated (R94). *Still open:* fixtures 18 and 23 still need goldens against `main`'s spec in PRs 7–9 (§3), and only PR 10 may touch `spec.json`. |
| 9 | Layers built against an older core (#231, #685) | **Resolved at the tip:** `bb-auth` is 1461 pass / 0 fail on the merged branch. *Still open:* intermediate layers (14–26) were never run against `main`'s core, so run the full suite on each. |
| 11 | Stale upgrade pin (0.1.10) | **Resolved:** the pin is `0.1.11`, the newest tag. *Still open:* R1 makes `0.1.12`, so re-pin then. |
| 12 | Frozen fixtures stale | **Resolved:** `authcognito-templates.json` was re-frozen in `69231a25`. The only change was #635's two table properties, and the proof passes 17/17. It goes in PR 24 with the original freeze. |
| 13 | #678 missing from `bb-auth` | **Resolved:** FX59 (`5a02dd11`, R93) is in PR 27. The #231 port (relay branding, IdP wire-safety test) is in PR 20. *New trade-off:* L71, clients lose detail such as which password rule failed. Sign it off in PR 27. |

### Still open

5. **Native e2e call sites.** FX35, FX38, FX45 and FX48 change generated APIs. On the tip, the e2e suites that use them are already on `Auth` (PR 30). PRs 7–9 must port the call-site changes to `main`'s pre-`Auth` suites by hand.
6. **Docs that reference unmerged work.** These hold their lines until PR 32 (or 31):
   - D7's `auth-common` README/DESIGN (2 lines naming `bb-auth`);
   - FX5's `db0ecc9f`;
   - E3a/E3b's native READMEs.

   If a native SDK release happens between 30 and R2, its README must not tell users to install `@aws-blocks/bb-auth`.
7. **Behaviour changes ship before the cutover:**
   - A4's remainder (two extra cases on `main`'s #725) in PR 1;
   - R88 and R89 in PR 2;
   - FX11 (L54) in PR 4;
   - FX7's one-handler rule in PR 26.

   Each changeset must say so plainly.
8. **E2e coverage gap.** `bb-auth` lands in 14–28 with unit, parity and offline AWS-layer tests, but CI's sandbox jobs don't exercise it until PR 29. Run the sandbox and production e2e at PR 29 and again before R2.
10. **Rename detection.** Always build patches with renames off (`-c diff.renames=false`; `-X no-renames` for `merge-tree`). R94 found the same artefact in the merge: git paired `bb-auth/package.json` with `bb-auth-oidc`'s.
14. **A long stack goes stale.** Fifteen sequential `bb-auth` PRs. Keep each review fix in the PR that owns the code. Rebase with `git rebase --update-refs`. Don't start reviewing PR *n+3* until *n* is approved. If a review fix lands in a layer, also apply it to the integration branch, so the "stack ends at the tip" check stays meaningful.
15. **Size.** Eight PRs are over 5,000 added lines: 7, 8, 9, 14, 15, 18, 20 and 21. That doesn't count 10 and 24, which are mostly generated fixtures. The source in the eight is 1,800–3,800 lines, and the rest is tests. Split further where §2 suggests if that's still too much.

### New since the merge

16. **`main`'s `brand-coverage` test checks every layer.** `main` added `packages/blocks/src/brand-coverage.test.ts`, which fails on an unbranded error producer anywhere in `packages/`. On the integration branch it only arrived with the merge, so the `bb-auth` layers were never checked against it. Two known gaps, both fixed at the tip and moved down in this plan:
    - `relay.ts`'s `RelayConfigError` first lands unbranded in PR 20;
    - the codemod's CLI errors first land in PR 22 and need the allowlist entry.

    Run the test on every Track 4 PR. Another layer may need a fix pulled down from a later PR.
17. **Cutting from the tip assumes the tip is right.** A cut PR takes the tip's final version of each file, including later fixes to that file, but not code it depends on in other files. Ownership here is by file, not by dependency. Build and test each PR on its own. If one needs a symbol from a later PR, move that hunk down too, or reorder.
