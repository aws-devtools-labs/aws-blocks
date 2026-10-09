# Auth unification — final status (2026-10-06)

**Branch:** `refactor/auth-blocks`, published for reference as one squashed draft PR (#711). It includes `origin/main` @ `da6d4c7d` (second merge, R98; the first was `12c0ace9`, R94). **Gates last ran after that merge** (below); the AWS runs predate both merges.

## Verdict

Every task in `06-implementation-plan.md` (A–F2) has landed, plus 58 follow-up fixes (FX1–FX58) from seven review rounds, the later-discussion list, and real AWS runs.
- **Reviewer A** (correctness and security) says **COMPLETE** at `85ce3e21`.
- **Reviewer B** (completeness and consumers) has no open code finding. It last confirmed the code at `85ce3e21`, and its remaining items were documentation in this file, L2 and the core README, all addressed here.
- **Every local gate is green**, and **every AWS run passes**.

## Gates after merging `main` @ `da6d4c7d` (R98; Node 22)

Rows marked *carried* were not re-run: nothing they cover changed in the merge (no native source, codemod or template changed on `main`'s side).

| Gate | Result |
|---|---|
| Lockfile | resynced with `npm install`; no `bb-auth-*` entries |
| Build, lint (0 errors), lint:deps, check:api, exports, client user-agent | pass |
| `check:packed-assets` (`main`'s #739, extended for `deployTimeLambdaCode`) | 3/3 bundles packed; guard tests 9/9 |
| Unit | **6,528 pass / 0 fail** / 5 skipped (6,275 before; the rest are `main`'s new tests) |
| e2e:local | **451 pass / 0 fail** / 2 skipped (deployed-only); vendorize 12/12 |
| Templates e2e | *carried* 9/9 (now driven by `main`'s `scripts/ci/templates-e2e.mjs`; runs in CI) |
| Codemod | fixtures 16/16, `migrate` 34/34, `migrate-e2e` 4/4 (in the unit run) |
| changeset-guard ×4 | 103 changesets valid, 21/21 covered, no majors, umbrella bumped |
| Offline `--conditions=cdk` synth of `comprehensive` | *carried*: sandbox and production modes pass; no bucket name over 63 characters |
| Codegen fixtures | **35/35** regenerated, zero drift |
| Golden checks (CI and local) | *carried*: Kotlin compile 35/35 · Swift compile 35/35, 0 warnings · Dart analyze 35/35 · Kotlin round trips 24 · live auth ✓ |
| Swift | *carried*: unit **375** (after `main`'s #656 tests); iOS sim pass; SwiftLint 0; e2e 46/46 |
| Dart | *carried*: unit 102 / **281** (after `main`'s #691 tests), web 92, analyze 0 errors, e2e 149 checks |
| Kotlin | *carried*: unit 240 / 22 / 127, e2e (JVM) 51/51 |

## Real AWS runs (a personal sandbox AWS account, 2026-10-05/06)

Every run used its own stack name, checked unused first, and touched nothing that already existed. **Every stack was destroyed, and no user pool, bucket or table is left behind** (checked at the end).

| Run | Final result |
|---|---|
| **Upgrade-in-place** (`AuthCognito` 0.1.10 → `Auth`) | **PASS.** Template continuity holds and `cdk diff` shows no replacement. The update reaches `UPDATE_COMPLETE`. Pool id, client, sessions table, secret and `userSub` are unchanged, the seeded user still signs in, and **the pre-upgrade session cookie is still valid.** |
| `comprehensive` **sandbox** e2e at `85ce3e21` | **35/35** |
| `comprehensive` **production-preset** e2e at `85ce3e21` | **35/35** |
| Hosting e2e (`Auth` apps, at `7de03acf`. Later commits change only the shared sandbox deploy path (FX57), which the final `comprehensive` sandbox run at `85ce3e21` exercises) | **Next.js 25/25 · SPA 11/11 · Nuxt 21/21**. Astro and SvelteKit don't use `Auth` and weren't run. |
| Native sandbox (Swift / Dart / Kotlin, `RUN_OIDC=1`) | **Final at `11188501`: Dart every suite 0 failed · Swift 46 run, 0 failures · Kotlin JVM 51 run, 0 failures** (5 per SDK skipped: they need an emailed code). OIDC passes in all three (L50). It covers FX46/48/50's wire changes against a real API Gateway. An earlier run at `dac7ccd1` lost 2 sign-up tests per SDK to an account-level security control (seen in CloudTrail) that disabled self-sign-up on new pools minutes after deploy. This run finished before it applied. |

**All AWS runs above predate the `main` merge** (they ran at `85ce3e21`, before the 0.1.11 upgrade pin and the fixture renumbering). The post-merge tree passes every local gate; re-running the sandbox, production and upgrade-in-place suites at `a3e1bfb9` is listed in `STACKED-PRS.md` as a pre-release step.

**What the AWS runs found, all fixed and re-verified:**
- FX52 (R85): the e2e harness read the SSM secret with the SDK's browser build.
- FX54 (R88): Node clients failed on stale keep-alive sockets.
- FX55 (R89): a production `deploy()` never exited (also on `main`).
- FX56 (R90): the hosting e2e deploy timed out inside a Playwright hook; the cause was on this branch (E1c).
- FX57 (R91): PGlite mocks held the process open, and sandbox telemetry was empty.
- FX58 (R92): the deployed Agent wrote to the unshortened bucket name, a regression from FX11.

`test:e2e:sandbox:vpc` is a no-op on `main` ("No VPC-dependent BBs on main yet").

## Decisions waiting for you

| # | Question | My lean |
|---|---|---|
| 🔴 L7 | Ship a final old-package patch before the cutover? Option (b) is applied in `a188cdef`; revert it for (a) | (b) |
| 🔴 L69 | Cross-origin web apps lost `AuthOIDC`'s browser sign-in helper; there's no documented replacement | document the pattern; build a helper only if asked |
| 🟡 L70 | `main` was merged (`049a49dd`, R94): #678 ported (R93), #231 ported, fixtures renumbered 27–35, the lockfile taken from `main`, the upgrade pin moved to 0.1.11, the `AuthCognito` fixture re-frozen. What's left: re-pin to 0.1.12 after R1, and repeat these per stacked PR | see `STACKED-PRS.md` |
| 🟡 L71 | Wire-safe error messages (R93, R96) hide which password rule failed or which attribute was rejected. FX60 fixed the two callback paths; the native relay still forwards `error_description` by design | block-authored messages for `InvalidPassword` only |
| 🟡 L51 | The codemod opts every migrated `stubIdp()` into deployment | refuse `unsafeAllowDeployed` under the production preset |
| 🟡 L64 | The RPC server reads by-name params by position | reject object params with `-32602` |
| 🟡 L44 | No framework signal for "stub IdP locally, real IdP deployed" | `{ local, deployed }` provider entry |
| 🟡 L41 | `AuthState.user` wire shape is wider than its type | strip it to the declared shape |
| 🟡 L66 | Expose `forceAliasCreation`? | no, not until asked |
| 🟡 L54 | FX11 overturns `bb-file-bucket`'s D-FB-8 by shortening long bucket names (FX58 fixed the one consumer it broke) | confirm |
| 🟡 L55, L60, L63 | Swift generated-API changes (nested types, names, `format: date` → `String`) | ship as minor; add a calendar-date type later |
| 🟡 L56, L57, L65 | Dart generated-API and runtime changes; `blocks_runtime` and `blocks_codegen` must release together | ship together |
| 🟡 L59, L61 | Kotlin `Uuid` opt-in; Dart `const` discriminant | keep the opt-in; match Kotlin/Swift at the next Dart minor |
| 🟡 L72 | `main`'s #739 changeset (names the deleted `bb-auth-oidc`) was folded into `Auth`'s; if `main` releases `bb-auth-oidc` 0.2.2 first, update the pending-changes text | check the published version at release |
| 🟡 L18, L21, L38(2), L53, L62 | Smaller design calls | see entries |
| 🟡 L45 | Account-existence signals masking can't remove, including (d) the authenticated alias check | note in release notes |
| 🟡 L9 | Cookies on API error responses: only *clearing* cookies are forwarded on an error | review at release |
| 🟡 L11 | B6's six `bb-auth-cognito` defects, three of them security issues, fixed and ported into `Auth` | security review at release |
| 🟡 L43 | Accepted reviewer notes. Deployed email+password e2e coverage is narrower than `AuthBasic`'s was | say so in the PR and release notes |
| 🟡 L67 | `bb-file-bucket`'s client middleware can hit the stale keep-alive socket FX54 fixed in core | reuse FX54's helper there |
| 🟡 R88 (FX54) | **The Node client now resends once** on a stale keep-alive socket. If a server crashes after reading a request, a method can run twice | note in release notes; keep state-changing methods idempotent |
| 🟡 R89 (FX55) | A production `deploy()` no longer imports the backend in-process, so it no longer writes or migrates the local `.bb-data/` | note in release notes |
| 🟡 L35 | The CI role needs SSM read for the hosting test secret | grant it |

## Release actions

1. **One release, with no Version Packages merge in between (L27).** Templates (E2), customer docs (E4) and the cutover (F1) ship together, because `bb-auth` must be on npm before anything that imports it.
2. **After publishing**, run `npm deprecate` on `@aws-blocks/bb-auth-basic`, `@aws-blocks/bb-auth-cognito` and `@aws-blocks/bb-auth-oidc`, pointing to `@aws-blocks/bb-auth` (R35).
3. **Release Dart's `blocks_runtime` and `blocks_codegen` together**, and raise codegen's runtime constraint (L57, L65).
4. **Grant the CI role SSM read** for the hosting test secret (L35).

`LATER-DISCUSSION.md` holds the full record: each open item with its assumption, and R1–R96 for what was resolved.

## Review log

| Round | SHA | Reviewer A | Reviewer B | Verifier |
|---|---|---|---|---|
| 1 | `c443319e` | NOT COMPLETE → FX1–6 | NOT COMPLETE → FX1–6 | green |
| 2 | `b1c25ddc` | COMPLETE | NOT COMPLETE (B4) → FX8 | Kotlin e2e break → FX9 |
| 3 | `f2e206e2` | COMPLETE (S1 → FX10) | COMPLETE | green |
| 4 | `a5938c9d` | COMPLETE | NOT COMPLETE (D1: this file) | — |
| 5 | `2ba3ef04` | COMPLETE | NOT COMPLETE (B1 flaky Swift test → FX50) | one flaky Swift test |
| 6 | `17b9cf69` | COMPLETE | docs only (D1a/D1b) | all green |
| 7 | `85ce3e21` | **COMPLETE** | docs only (F1 README, F2 this file) → fixed here | **all green** |
