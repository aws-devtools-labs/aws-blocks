# Auth unification: the stack of reviewable PRs

PR #711 held the whole change as one reference commit; it is closed, and this stack replaces it: **14 PRs** that land one after another. Each PR is one commit, based on the PR below it, and keeps `main` green on its own.

| | |
|---|---|
| Base | `main` @ `3535c2ab` |
| Reference tree | `refactor/auth-blocks` @ `8c5d8e07`: the tree tested end to end on AWS at `0d14f7b1` (R118–R120), merged with `main` up to `3535c2ab` (R121–R128, including the per-run test-support secret, R124, #208 / #807, R126, and #736 / #910 / #704, R128) and re-gated locally. Stack PR 12 has exactly this tree, apart from this file. |
| Follow-ups | PRs 13 and 14 are the browser sign-in helper (L69) and the SES option (L75), rebased onto the tip (R121, R122; re-merged at each later tip). |
| Branches | `auth/stack-NN-<slug>` in this repo. Each branch's parent commit is the branch below it, and PR 01's parent is `main`. |

---

## 1. The stack

| # | Branch | What it adds | Files | Lines (+/−) | Source to read |
|---|---|---|---|---|---|
| 01 | `auth/stack-01-core-and-shared-fixes` | Core: cookies on RPC error responses (only clearing cookies pass), multiple `Set-Cookie` values, keep-alive retry in the Node client, production `deploy()` that exits, PGlite exits, `deployTimeLambdaCode()`, `removeSecret({ force })`, RPC-dispatch additions on top of #725, packed-asset check. Other blocks: `FileBucket` long-name shortening (L54), `bb-agent` session bucket, `bb-app-setting` `parameterName`, conditional-export parity fixes | 98 | +4,753 / −180 | ~1.8k |
| 02 | `auth/stack-02-native-kotlin` | Kotlin codegen and runtime: transferables, unions, name collisions, RPC wire fixes, `unknown` as `JsonElement`, `Uuid` opt-in; goldens and round trips | 66 | +6,460 / −469 | ~3.5k |
| 03 | `auth/stack-03-native-swift` | Swift codegen and runtime: the same set, plus `RawRouteError` for non-2xx raw routes (R110); goldens | 102 | +8,660 / −1,148 | ~2.7k |
| 04 | `auth/stack-04-native-dart` | Dart codegen and runtime: the same set, value equality, `BlocksClient.call(Object)`, the `analyzer` cap; goldens | 74 | +8,000 / −1,394 | ~2.4k |
| 05 | `auth/stack-05-native-fixtures` | Fixtures 29–37, the auth spec fixtures 18 and 23, `regenerate-all.sh` and the fixture README | 88 | +11,500 / −234 | ~0.3k |
| 06 | `auth/stack-06-old-auth-blocks-final-patch` | The final patch of `bb-auth-cognito` and `bb-auth-oidc` (L7 option a): B6's three security fixes, merged with `main`'s #678 wire-safe messages, A2's corrected docs, B1/B5 tests; `auth-common`'s `AuthErrors` contract and the UI store (`requireRole` stays optional) | 47 | +6,550 / −284 | ~1.2k |
| 07 | `auth/stack-07-bb-auth-foundation` | The `Auth` block, still `"private": true`: all of its source (options, sessions and cookies, `AuthBase`, the native and federation engines, the CDK layer and its identity guards), its test harnesses, and the foundation tests | 109 | +48,603 / −1 | ~24k |
| 08 | `auth/stack-08-bb-auth-email-password` | Tests: email and password, MFA, passkeys, devices, admin, PreSignUp, enumeration masking, mock↔AWS parity | 24 | +10,704 / −0 | tests only |
| 09 | `auth/stack-09-bb-auth-federation` | Tests: direct OIDC, stub IdP, hosted UI, the native relay, bearer tokens (`clientIds`, `fromExisting`), the shared gateway, provider log groups | 14 | +6,393 / −0 | tests only |
| 10 | `auth/stack-10-bb-auth-ui-and-migration` | The `migrate` codemod (`npx @aws-blocks/bb-auth migrate`) and its tests, `MIGRATION.md`, the UI guide, the UI tests (the end-to-end migrate test lands in 12, since it type-checks against the umbrella) | 72 | +5,965 / −0 | ~4.2k |
| 11 | `auth/stack-11-consumers-on-auth` | Test apps, native e2e suites and examples on `Auth`; the upgrade-in-place harness and workflow; the live-spec fixture check | 170 | +10,477 / −1,830 | ~3.4k |
| 12 | `auth/stack-12-cutover` | `bb-auth` public and in the umbrella; templates and `create-blocks-app`; customer docs; delete `bb-auth-basic`, `bb-auth-cognito` and `bb-auth-oidc`; `requireRole` required; D-020; the `bb-auth` changesets; these design docs | 301 | +12,018 / −40,184 | ~1.8k |
| 13 | `auth/stack-13-browser-sign-in-helper` | `createAuthClient()` for a frontend on another origin (L69) | 20 | +1,281 / −8 | ~0.7k |
| 14 | `auth/stack-14-ses-email` | `email: { fromAddress, … }`, an SES sender for the user pool (L75) | 19 | +500 / −32 | ~0.3k |

"Source to read" leaves out tests, fixtures, goldens, API reports and the lockfile.

### Why the layers are cut this way

- **The `Auth` source arrives whole, in PR 07.** Every entry file (`index.mock.ts`, `index.aws.ts`, `index.cdk.ts`, `index.browser.ts`) pulls in about 36 of the package's 40 source files, federation included, through the injected `AuthLayer` engines. Splitting that source further would mean writing intermediate wiring that never existed and was never tested. Instead, PR 07 has all the source and the foundation tests, and PRs 08–10 add the feature tests and the codemod. Read PR 07 in this order: `types.ts`, `option-validation.ts`, `sessions.ts` and `cookies.ts`, `auth-base.ts`, `engines/`, then `index.cdk.ts` and `cdk/`.
- **The old blocks get their last patch before anything moves off them.** PR 06 is the release (R1) that ships B6's fixes to people who stay on `AuthCognito` and `AuthOIDC`.
- **Nothing published imports `bb-auth` before PR 12.** Test apps are private, so PR 11 moves them early, importing `@aws-blocks/bb-auth` straight from the workspace. The templates, umbrella and customer docs all move in PR 12, the same release that makes `bb-auth` public.
- **Things that only become true at the cutover wait for it:**
  - `requireRole` turns required in PR 12. Until then `AuthBasic` and `AuthOIDC` still implement `BlocksAuth`.
  - The user-agent tests that expect `bb/Auth` move in PR 12 too. Official block names come from the umbrella's `vendorize` map, which gains `Auth` there.
  - So does `bb-auth`'s own `user-agent.aws-runtime.test.ts`. PRs 07–11 drop it from the package's `test` script.

### Changesets

- `bb-auth` is private until PR 12, and `changeset-guard` skips private packages. So every changeset that names `@aws-blocks/bb-auth` lands in PR 12.
- Four changesets name `bb-auth` and other packages too. PR 01 carries core-only copies of those, so the core changes it makes are covered:
  - `core-error-response-cookie-max-age`
  - `core-one-lambda-event-handler-per-source`
  - `core-cognito-user-pool-trigger-events`
  - `vendorize-deploy-time-lambdas-blocks`

  PR 12 deletes the copies and adds the combined originals. If a Version Packages release runs between 01 and 12, those core lines appear in two changelogs.
- PR 06 carries the six old-package changesets (L7). PRs 02–04 carry their language's own changesets under `native/*/.changeset`.

---

## 2. How each PR was built and checked

- **Built from the reference tree.** Every changed path was routed to exactly one PR, and that PR takes the tip's version of the file. Shared files are edited per PR:
  - the root `package.json` gains the `bb-auth` workspace in 07 and the upgrade scripts in 11;
  - the root `tsconfig.json` gains the old blocks' references in 06 and `bb-auth` in 07;
  - `.gitignore`;
  - `auth-common/src/index.ts`;
  - `bb-auth/package.json`, which has no `bin` until PR 10.
- **Regenerated per PR, not copied:** the lockfile, API reports, `official-bb-names.generated.ts` and the native goldens. The tip regenerates byte-identically: PR 12 has zero drift.
- **Each branch passed on its own:**
  - `npm ci`, with the lockfile stable under `npm install`;
  - build, lint, `lint:deps`, the exports, client user-agent and packed-asset checks, `check:api`;
  - the action-pin guard, the catalog check, all four `changeset-guard` checks;
  - `test:unit`, `publish:local`, `test:e2e:local`;
  - native goldens with zero drift (02–05, 11, 12) and each language's compile and tests;
  - templates e2e (12).
- **AWS:** the full tree passed end to end on AWS. That covers upgrade-in-place, `comprehensive` sandbox and production, hosting, native, and the CloudFront front door (R118–R120 in `LATER-DISCUSSION.md`, and PR #711).

---

## 3. Merging

```
main ◄─ 01 ◄─ 02 ◄─ 03 ◄─ 04 ◄─ 05 ◄─ 06 ◄─ 07 ◄─ 08 ◄─ 09 ◄─ 10 ◄─ 11 ◄─ 12 ◄─ 13 ◄─ 14
```

- **Merge bottom to top.** When a PR merges, GitHub retargets the one above it to `main`.
- **Review in parallel:** 02–04 go to the Kotlin, Swift and Dart reviewers at the same time as 01. PRs 08–10 can be reviewed together with 07.
- **R1, the last old-block patch, goes between 06 and 07.** Merge the Version Packages PR after 06, so `bb-auth-cognito` 0.1.13 and `bb-auth-oidc` 0.2.3 ship B6's fixes. Then re-pin the upgrade harness to the new tag; that's one line in PR 11.
- **If `main` moves,** merge it into `refactor/auth-blocks` once, then re-cut the stack from the new tip with the same routing. Don't rebase each PR by hand.

---

## 4. Release plan

| When | Release | What it ships |
|---|---|---|
| As 01–05 merge | normal Version Packages | core, data, `bb-file-bucket`, `bb-agent`, `bb-app-setting`, umbrella; native SDKs through their own changesets (Kotlin, Swift) and `## Unreleased` (Dart). **Release Dart's `blocks_runtime` and `blocks_codegen` together** (L57, L65). |
| **R1**, after 06 | normal Version Packages | Last patch of `bb-auth-cognito` (0.1.13) and `bb-auth-oidc` (0.2.3), and `auth-common` with `AuthErrors`. |
| During 07–11 | normal releases | Nothing from `bb-auth`: it's private and has no changesets yet. |
| **R2, the cutover**, after 12 | one Version Packages release | `bb-auth`'s first publish; `auth-common` with `requireRole` required; umbrella, core and `create-blocks-app` minors; the old packages gone. Then 13 and 14, in the same release or the next. |

### Release-day checklist for R2

1. Decide the open items that change PR 12's content: L41, L51, L64, L66, L76.
2. Merge any pending Version Packages PR, so R2 holds only the cutover.
3. `grep -lE "bb-auth-(basic|cognito|oidc)" .changeset/*.md` is empty after 12, apart from `auth-replaced-blocks-pending-changes.md`, which names `bb-auth`.
4. Run the upgrade-in-place workflow from `main` against the R1 tag.
5. From `main` HEAD after 12, run:
   - the sandbox, production, hosting and native sandbox jobs;
   - templates e2e;
   - `migrate` and `migrate-e2e`.

   Destroy every stack.
6. Merge the Version Packages PR, then check:
   - `npm view @aws-blocks/bb-auth version` returns a version;
   - `npm create @aws-blocks/blocks-app@latest` (default, react, demo, auth) installs and builds;
   - `npx @aws-blocks/bb-auth migrate --help` runs.
7. Run `npm deprecate` on the three old packages, pointing to `@aws-blocks/bb-auth` and `MIGRATION.md` (R35).
8. Release notes: L43, L45, L71, L11 (B6 shipped in R1), and the client-driven options (R105, R106).

**No CI permission is needed** for the test-support secret (L35, R124): each e2e run makes its own, the workflow masks it, and the deploy and the tests read it from the environment, so nothing reads it from SSM.
