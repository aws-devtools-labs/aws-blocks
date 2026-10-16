# Auth unification — final status (2026-10-06)

**Branch:** `refactor/auth-blocks`, published for reference as one squashed draft PR (#711). It includes `origin/main` @ `c20cbfd2` (sixth merge, R111; the earlier ones were `12c0ace9` R94, `da6d4c7d` R98, `440ecce7` R99, `60616b1e` and `30fc4c2b` R107). **Gates last ran after that merge** (below). The AWS table predates the merges except R106 (the client-driven options, 24/24 at `18731478`).

## Verdict

Every task in `06-implementation-plan.md` (A–F2) has landed, plus 58 follow-up fixes (FX1–FX58) from seven review rounds, the later-discussion list, and real AWS runs.
- **Reviewer A** (correctness and security) says **COMPLETE** at `85ce3e21`.
- **Reviewer B** (completeness and consumers) has no open code finding. It last confirmed the code at `85ce3e21`, and its remaining items were documentation in this file, L2 and the core README, all addressed here.
- **Every local gate is green**, and **every AWS run passes**.

## Gates after merging `main` @ `5adfba73` (R117; Node 22, JDK 17 for Kotlin)

Every row was re-run on `438d6782` except those marked *carried* and the native rows, which are from R116 (`d87777af`): `main`'s #826 and #829 change no native code.

| Gate | Result |
|---|---|
| Lockfile | `npm ci --dry-run` clean; no `bb-auth-*` entries |
| Build, lint (0 errors), lint:deps, check:api, exports, client user-agent | pass |
| GitHub Actions pinned (#783 guard + its tests) | pass (6/6 tests) |
| `check:packed-assets` | 3/3 bundles packed |
| Unit (`env -u AWS_PROFILE`, as CI) | **7,050 pass / 0 fail** / 6 skipped (incl. the identity fixture and property snapshot, unchanged; 5 `shared-gateway` cases incl. both `apiFrontDoor` tiers) |
| e2e:local | **493 pass / 0 fail** / 2 skipped; vendorize 12/12 (adds `main`'s Secret suite, run through the gated `testSupport`) |
| `create-blocks-app` | 170 pass / 0 fail |
| Templates e2e | **9/9** (`scripts/ci/templates-e2e.mjs`; includes #829's FileBucket, AppSetting, AsyncJob and EmailClient canaries) |
| changeset-guard ×4 (+ its own tests) | 98 valid, 16/16 covered, no majors, umbrella bumped; 42/42 |
| Codegen fixtures | **36/36** regenerated; the only drift in fixture 27 (`main`'s) is this branch's positional params |
| Golden checks | Kotlin compile 36/36 (fixture 27 against compile-only stubs of its declared packages) · Dart analyze 36/36, 0 errors (same) · Kotlin round trips pass |
| Kotlin | `:codegen:test` (incl. `main`'s `DeclaredTransferableBindingTest`), `:runtime:jvmTest`, `:plugin:check`, both script tests: pass |
| Swift | `swift test` **238 / 0**; *carried*: iOS sim pass; SwiftLint 0; e2e 46/46 |
| Dart | `blocks_codegen` **369 / 0**, `blocks_runtime` **106 / 0**; *carried*: web 92, e2e 149 checks |


## Real AWS runs (a personal sandbox AWS account, 2026-10-05/06)

Every run used its own stack name, checked unused first, and touched nothing that already existed. **Every stack was destroyed, and no user pool, bucket or table is left behind** (checked at the end).

| Run | Final result |
|---|---|
| **Upgrade-in-place** (`AuthCognito` 0.1.10 → `Auth`) | **PASS.** Template continuity holds and `cdk diff` shows no replacement. The update reaches `UPDATE_COMPLETE`. Pool id, client, sessions table, secret and `userSub` are unchanged, the seeded user still signs in, and **the pre-upgrade session cookie is still valid.** |
| `comprehensive` **sandbox** e2e at `85ce3e21` | **35/35** |
| `comprehensive` **production-preset** e2e at `85ce3e21` | **35/35** |
| Hosting e2e (`Auth` apps, at `7de03acf`. Later commits change only the shared sandbox deploy path (FX57), which the final `comprehensive` sandbox run at `85ce3e21` exercises) | **Next.js 25/25 · SPA 11/11 · Nuxt 21/21**. Astro and SvelteKit don't use `Auth` and weren't run. |
| Native sandbox (Swift / Dart / Kotlin, `RUN_OIDC=1`) | **Final at `11188501`: Dart every suite 0 failed · Swift 46 run, 0 failures · Kotlin JVM 51 run, 0 failures** (5 per SDK skipped: they need an emailed code). OIDC passes in all three (L50). It covers FX46/48/50's wire changes against a real API Gateway. An earlier run at `dac7ccd1` lost 2 sign-up tests per SDK to an account-level security control (seen in CloudTrail) that disabled self-sign-up on new pools minutes after deploy. This run finished before it applied. |
| **After `main`'s #734 shared gateway** (R113, 2026-10-14, at `5a02ff5e`): upgrade-in-place, `AuthCognito` **0.1.11** → `Auth` | **PASS (14/14).** `cdk diff` shows no replacement, removal or addition of the pool, client, sessions table or secret; the only API-side change is the handler's code asset (the `RestApi` keeps logical id `DefaultComputeAPI5E5CE44A`, so moving onto the shared gateway changes nothing deployed). `UPDATE_COMPLETE`; pool id, client, sessions table (name + id), secret and `userSub` unchanged; the seeded user signs in; **the pre-upgrade cookie is still valid**. |
| **Hosted-UI URLs through the shared gateway** (R113, 2026-10-14; `socialProviders.google` with placeholder credentials) | **15/15.** One `RestApi` in the stack. The hosted-UI client registers exactly `<shared gateway URL>/aws-blocks/auth/callback` and `…/signout`, with no unresolved token. `GET /signin/google` → 302 to Cognito `/oauth2/authorize` with that `redirect_uri`, PKCE S256 and `identity_provider=Google`; **Cognito accepts it and forwards to accounts.google.com**; Cognito `/logout` accepts our `logout_uri` and redirects to it, and the landing 302s to `postSignOutPath`. The Google leg itself needs a real Google account (not run). |
| **`comprehensive` sandbox e2e** (R113, 2026-10-14, at `5a02ff5e`, after #734 and #771) | **400/400 tests, 36/36 suites.** Includes the deployed stub IdP (its issuer now comes from the shared gateway), the PreSignUp trigger (#771 port), bearer auth, the admin surface, realtime, databases, jobs and EmailClient (verified SES domain). Stack destroyed by the suite; sweep found nothing left. |
| **Provider log groups after `destroy()`** (R114, 2026-10-14; `Auth` + Google, guard and IdP-registration providers) | **5/5.** All four owned groups received logs under the new `logs:CreateLogGroup` deny; none reappeared within 12 minutes of `destroy()`; nothing left behind. |
| **Native SDK e2e, local + deployed** (R118, 2026-10-16, at `cd1753c7`, after the `7477b6e6`/`5adfba73` merges; `RUN_OIDC=1`) | **0 failures.** Local dev server: Dart 9 suites / 149 checks · Kotlin JVM 51/51 · Swift 46/46 (both OIDC relay tests). Deployed sandbox: Dart 9 suites / 107 checks · Kotlin JVM 51 run, 0 failed, 5 skipped · Swift 46 run, 0 failed, 5 skipped. Every skip needs an emailed code. OIDC signs in through the deployed stub, whose issuer is the shared gateway URL (#734 port). |
| **Client-driven options** (R105/R106, 2026-10-13, at `18731478`; three stacks: own pool · `fromExisting` · Gen 2-shaped token ids) | **24/24.** `caseSensitive: false` deployed (`UsernameConfiguration.CaseSensitive: false`, email username) and a sign-in with the email in another case works; flipping it is refused at synth (layer 1, stack untouched) and, with layer 1 bypassed, at deploy by the guard before `UpdateUserPool` (layer 2, pool unchanged, `UPDATE_ROLLBACK_COMPLETE`). Bearer: an extra client's access token → 200 with the user's `userSub`; an unlisted client, an ID token and no token → RPC 401. `Auth.fromExisting(pool, clientId)` on a second stack accepts that client. **CDK-token ids** (pool and two clients created in the same app before a `BlocksBackend`, handed over as tokens): both the `fromExisting` client and the `clientIds` entry → 200; a client in neither → 401. All stacks, pools, extra clients and the helper Lambdas' log groups deleted. |
| `comprehensive` production-preset e2e at `cd1753c7` (SB-B, R119) | **431/431** |
| Hosted UI + cookies behind `apiFrontDoor: 'cloudfront'` (SB-B, R119) | **24/24** |

**All AWS runs above predate the `main` merge** (they ran at `85ce3e21`, before the 0.1.11 upgrade pin and the fixture renumbering). The post-merge tree passes every local gate; re-running the sandbox, production and upgrade-in-place suites at `a3e1bfb9` is listed in `STACKED-PRS.md` as a pre-release step.

**What the AWS runs found, all fixed and re-verified:**
- FX52 (R85): the e2e harness read the SSM secret with the SDK's browser build.
- FX54 (R88): Node clients failed on stale keep-alive sockets.
- FX55 (R89): a production `deploy()` never exited (also on `main`).
- FX56 (R90): the hosting e2e deploy timed out inside a Playwright hook; the cause was on this branch (E1c).
- FX57 (R91): PGlite mocks held the process open, and sandbox telemetry was empty.
- FX58 (R92): the deployed Agent wrote to the unshortened bucket name, a regression from FX11.

`test:e2e:sandbox:vpc` is a no-op on `main` ("No VPC-dependent BBs on main yet").

## Decided by the maintainer (2026-10-12)

| # | Decision | Where |
|---|---|---|
| L7 | **(a):** release the six unreleased old-package changesets as a final `bb-auth-cognito` / `bb-auth-oidc` patch before the cutover, then re-pin the upgrade harness. *Since R116:* `main`'s #696 already published `bb-auth-cognito` 0.1.12 and `bb-auth-oidc` 0.2.2 from `main`'s own changesets, without B6's fixes, so the final patch is now **0.1.13 / 0.2.3**; the harness is pinned to 0.1.12 | R100; release action 1 below; `STACKED-PRS.md` principle 4 and §5 R1 |
| L71 | **(b), weak passwords only:** the message is built from the block's own `passwordPolicy`, never from Cognito's text; a wrapped pool keeps the fixed message | R101; built in IMPL3 |
| L44 | **(c):** keep `stubIdp()` as shipped and document the env-switch pattern; no `{ local, deployed }` option unless users ask | R102; `bb-auth/README.md` |
| L69 | **(b):** build a browser helper on the existing `/aws-blocks/auth/*` routes, in a separate PR | R103; follow-up F-L69 below |
| D1 | `AuthBasic` users must sign up again: **signed off** (no AWS Blocks app runs in production yet) | R104; backlog L74 |
| Q2 | Every deployed sign-up confirms with an emailed code: **signed off** | R104; follow-up L75 |
| L54 | Raise it in the #blocks Slack channel | open, below |

## Follow-ups (not in this PR)

- **F-L69 — browser sign-in helper** for a frontend on another origin than its API, on the existing `/aws-blocks/auth/*` routes, with its own tests (R103). `MIGRATION.md` and `DESIGN.md` → *Known gaps* say it's coming.
- **L75 — an SES option on `AuthOptions`** (CDK `UserPoolEmail.withSES()`), before GA, so the default path can reach production without `Auth.fromExisting`.
- **L74 — "import existing users on first sign-in"** through Cognito's User Migration trigger. Backlog.
- **Client-driven apps (R105, additive):** an `appClients` option, an `auth` section in the generated frontend config (or an Amplify-outputs-compatible file), an Identity Pool option, a Cognito-tokens → session route for SSR, a Kotlin `AuthProvider`, and `phase: 'signIn'` through Cognito triggers (L77).

## Decisions waiting for you

| # | Question | My lean |
|---|---|---|
| 🟡 L76 | `Auth`'s `userId` is the Cognito username; Amplify's `getCurrentUser().userId` is the `sub` (Blocks `userSub`) | keep the names, documented (FX-doors) |
| 🟡 L77 | `phase: 'signIn'`, `onSignIn`, `onSignOut` don't run for a frontend that signs in directly against Cognito | documented now; Pre/PostAuthentication triggers later |
| ✅ L78 | `test-apps/amplify-gen2` converted to `Auth.fromExisting` with token ids and access tokens; interop browser e2e still to run on AWS. `templates/amplify` not converted yet | run `e2e-amplify-interop`; convert the template in its own PR |
| 🟡 L70 | `main` was merged six times (R94, R98, R99, R107, R111, R116): #678 and #231 ported, fixtures now 28–36, the lockfile taken from `main`, the upgrade pin at 0.1.12, the `AuthCognito` fixture re-frozen. What's left: re-pin to 0.1.12 after R1 (R100), and repeat these per stacked PR | see `STACKED-PRS.md` |
| 🟡 L71 (residual) | The native relay still forwards `error_description` to the signed `relayTo` target by design (the weak-password part is decided, R101) | leave it |
| 🟡 L51 | The codemod opts every migrated `stubIdp()` into deployment | refuse `unsafeAllowDeployed` under the production preset |
| 🟡 L64 | The RPC server reads by-name params by position | reject object params with `-32602` |
| 🟡 L41 | `AuthState.user` wire shape is wider than its type | strip it to the declared shape |
| 🟡 L66 | Expose `forceAliasCreation`? | no, not until asked |
| 🟡 L54 | FX11 overturns `bb-file-bucket`'s D-FB-8 by shortening long bucket names (FX58 fixed the one consumer it broke). **Raised in the #blocks Slack channel (maintainer's request, 2026-10-12); awaiting an answer** | confirm |
| 🟡 L55, L60, L63 | Swift generated-API changes (nested types, names, `format: date` → `String`) | ship as minor; add a calendar-date type later |
| 🟡 L56, L57, L65 | Dart generated-API and runtime changes; `blocks_runtime` and `blocks_codegen` must release together | ship together |
| 🟡 L59, L61 | Kotlin `Uuid` opt-in; Dart `const` discriminant | keep the opt-in; match Kotlin/Swift at the next Dart minor |
| 🟡 L72 | `main`'s #739 changeset (names the deleted `bb-auth-oidc`) was folded into `Auth`'s; if `main` releases `bb-auth-oidc` 0.2.2 first, update the pending-changes text | check the published version at release |
| 🟡 L18, L21, L53, L62 | Smaller design calls | see entries |
| 🟡 L45 | Account-existence signals masking can't remove, including (d) the authenticated alias check | note in release notes |
| 🟡 L9 | Cookies on API error responses: only *clearing* cookies are forwarded on an error | review at release |
| 🟡 L11 | B6's six `bb-auth-cognito` defects, three of them security issues, fixed and ported into `Auth` | security review at release |
| 🟡 L43 | Accepted reviewer notes. Deployed email+password e2e coverage is narrower than `AuthBasic`'s was | say so in the PR and release notes |
| 🟡 L67 | `bb-file-bucket`'s client middleware can hit the stale keep-alive socket FX54 fixed in core | reuse FX54's helper there |
| 🟡 R88 (FX54) | **The Node client now resends once** on a stale keep-alive socket. If a server crashes after reading a request, a method can run twice | note in release notes; keep state-changing methods idempotent |
| 🟡 R89 (FX55) | A production `deploy()` no longer imports the backend in-process, so it no longer writes or migrates the local `.bb-data/` | note in release notes |
| 🟡 L35 | The CI role needs SSM read for the hosting test secret | grant it |

## Release actions

0. **Before the cutover (L7 → R100; versions per R116):** merge the old-package fix PRs (`STACKED-PRS.md` PRs 11–13) with their original changesets, let a *Version Packages* PR publish `bb-auth-cognito` 0.1.13 and `bb-auth-oidc` 0.2.2, then re-pin the upgrade-in-place harness to 0.1.12 and re-run it.
1. **One release, with no Version Packages merge in between (L27).** Templates (E2), customer docs (E4) and the cutover (F1) ship together, because `bb-auth` must be on npm before anything that imports it.
2. **After publishing**, run `npm deprecate` on `@aws-blocks/bb-auth-basic`, `@aws-blocks/bb-auth-cognito` and `@aws-blocks/bb-auth-oidc`, pointing to `@aws-blocks/bb-auth` (R35).
3. **Release Dart's `blocks_runtime` and `blocks_codegen` together**, and raise codegen's runtime constraint (L57, L65).
4. **Grant the CI role SSM read** for the hosting test secret (L35).

`LATER-DISCUSSION.md` holds the full record: each open item with its assumption, and R1–R105 for what was resolved.

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
