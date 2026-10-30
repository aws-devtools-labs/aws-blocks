# Auth unification: the stack of reviewable PRs

PR #711 held the whole change as one reference commit; it is closed, and this stack replaces it. It started as **14 PRs** that land one after another; PR 01 (#850) is merged, and **13 remain**: #851–#863. Each PR is one commit, based on the PR below it, and keeps `main` green on its own.

| | |
|---|---|
| Merged | PR 01, #850 (core and shared fixes), squash-merged into `main` as `48c35f64`. |
| Base | `main` @ `dea4ca20`. PR 02 (#851) targets `main`. |
| Reference tree | `refactor/auth-blocks` re-merged with `main` up to `dea4ca20`, with the #856 review fixes: `1bd18536`. Stack PR 12 has exactly this tree, apart from this file. Earlier rounds: the tree tested end to end on AWS at `0d14f7b1` (R118–R120), merged with `main` at each later round (R121–R129) and re-gated locally. |
| Follow-ups | PRs 13 and 14 are the browser sign-in helper (L69) and the SES option (L75): PR 12's tree plus their own changes. |
| Branches | `auth/stack-NN-<slug>` in this repo. Each branch's parent commit is the branch below it, and PR 02's parent is `main`. |

---

## 1. The stack

| # | PR | Branch | What it adds |
|---|---|---|---|
| 01 | #850 (merged) | `auth/stack-01-core-and-shared-fixes` | Core: cookies on RPC error responses, multiple `Set-Cookie` values, keep-alive retry in the Node client, production `deploy()` that exits, PGlite exits, `deployTimeLambdaCode()`, `removeSecret({ force })`, RPC-dispatch additions, packed-asset check; `FileBucket` long-name shortening, `bb-agent` session bucket, conditional-export parity fixes |
| 02 | #851 | `auth/stack-02-native-kotlin` | Kotlin codegen and runtime: transferables, unions, name collisions, RPC wire fixes, `unknown` as `JsonElement`, `Uuid` opt-in; goldens and round trips |
| 03 | #852 | `auth/stack-03-native-swift` | Swift codegen and runtime: the same set, plus `RawRouteError` for non-2xx raw routes; transferables decode at any depth, including an `OIDCClient<String>` below the top level; goldens |
| 04 | #853 | `auth/stack-04-native-dart` | Dart codegen and runtime: the same set, value equality, `BlocksClient.call(Object)`, the `analyzer` cap; goldens |
| 05 | #854 | `auth/stack-05-native-fixtures` | Codegen fixtures 29–36 and 38, the auth spec fixtures 18 and 23, `regenerate-all.sh` and the fixture README |
| 06 | #855 | `auth/stack-06-old-auth-blocks-final-patch` | The final patch of `bb-auth-cognito` and `bb-auth-oidc` (L7 option a): B6's three security fixes, A2's corrected docs, B1/B5 tests; `auth-common`'s `AuthErrors` contract and the UI store (`requireRole` stays optional) |
| 07 | #856 | `auth/stack-07-bb-auth-foundation` | The `Auth` block, still `"private": true`: all of its source (options, sessions and cookies, `AuthBase`, the native and federation engines, the CDK layer and its identity guards), its test harnesses, the foundation tests; core's spec-generator changes that `Auth`'s native shape needs, and the dev server's guard against an unhandled rejection from a request (an un-awaited `requireRole`); `bb-app-setting`'s CDK `parameterName` and `secret` |
| 08 | #857 | `auth/stack-08-bb-auth-email-password` | Tests: email and password, MFA, passkeys, devices, admin, PreSignUp, enumeration masking, mock↔AWS parity |
| 09 | #858 | `auth/stack-09-bb-auth-federation` | Tests: direct OIDC, stub IdP, hosted UI, the native relay, bearer tokens (`clientIds`, `fromExisting`), the shared gateway, provider log groups |
| 10 | #859 | `auth/stack-10-bb-auth-ui-and-migration` | The `migrate` codemod (`npx @aws-blocks/bb-auth migrate`) and its tests, `MIGRATION.md`, the UI guide, the UI tests (the end-to-end migrate test lands in 12, since it type-checks against the umbrella) |
| 11 | #860 | `auth/stack-11-consumers-on-auth` | Test apps, native e2e suites and examples on `Auth`; the upgrade-in-place harness and workflow; the live-spec fixture check |
| 12 | #861 | `auth/stack-12-cutover` | `bb-auth` public and in the umbrella; templates and `create-blocks-app`; customer docs; delete `bb-auth-basic`, `bb-auth-cognito` and `bb-auth-oidc`; `requireRole` required; D-020; the `bb-auth` changesets; CI type-checks `comprehensive`; these design docs |
| 13 | #862 | `auth/stack-13-browser-sign-in-helper` | `createAuthClient()` for a frontend on another origin (L69) |
| 14 | #863 | `auth/stack-14-ses-email` | `email: { fromAddress, … }`, an SES sender for the user pool (L75) |

### Reading PR 07

The `Auth` source arrives whole in PR 07. Every entry file (`index.mock.ts`, `index.aws.ts`, `index.cdk.ts`, `index.browser.ts`) pulls in nearly all of the package's source files, federation included, through the injected engines, so splitting the source further would mean writing intermediate wiring that never existed and was never tested. Read it in this order, all under `packages/bb-auth/src/`:

1. `types.ts`: the options and the typed client surface.
2. `option-validation.ts`: what construction accepts and rejects.
3. `sessions.ts` and `cookies.ts`.
4. `auth-base.ts`: the methods every entry shares.
5. `engines/`: the native (Cognito) and federation engines.
6. `index.cdk.ts`, then `cdk/`: the CDK layer and its identity guards.

Then core's spec-generator changes in `packages/core/src/scripts/`, which give `Auth`'s types one native shape each.

### Codegen fixtures

`main`'s fixtures keep their numbers: 01–28, and 37 (`37-oidc-provider-enum`, #902). This stack's are 29–36 and **38** (`38-generated-name-collisions`, numbered 37 until #902 took that number). The auth spec fixtures 18 (`18-hybrid-arm`) and 23 (`23-cognito-nested-unions`) take `Auth`'s spec in PR 05, and `native/codegen-fixtures/check-live-auth-fixtures.mjs` (PR 11) checks them against the live spec.

### Why the layers are cut this way

- **The old blocks get their last patch before anything moves off them.** PR 06 is the release (R1) that ships B6's fixes to people who stay on `AuthCognito` and `AuthOIDC`.
- **Nothing published imports `bb-auth` before PR 12.** Test apps are private, so PR 11 moves them early, importing `@aws-blocks/bb-auth` straight from the workspace. The templates, umbrella and customer docs all move in PR 12, the same release that makes `bb-auth` public.
- **Things that only become true at the cutover wait for it:**
  - `requireRole` turns required in PR 12. Until then `AuthBasic` and `AuthOIDC` still implement `BlocksAuth`.
  - The user-agent tests that expect `bb/Auth` move in PR 12 too. Official block names come from the umbrella's `vendorize` map, which gains `Auth` there.
  - So does `bb-auth`'s own `user-agent.aws-runtime.test.ts`. PRs 07–11 drop it from the package's `test` script.

### Changesets

- `bb-auth` is private until PR 12, and `changeset-guard` skips private packages. So every changeset that names `@aws-blocks/bb-auth` lands in PR 12.
- PR 01's changesets are pending on `main`. No PR in this stack changes or deletes them, and our changesets don't repeat them: each change appears once in the changelog.
- PR 12 deletes `bb-auth-basic`, `bb-auth-cognito` and `bb-auth-oidc`, and a changeset that names a package no longer in the workspace fails `changeset version`. So PR 12 edits or removes the changesets on `main` that name those three packages (15 at `dea4ca20`), and nothing else of `main`'s; what they announce for those packages is in `auth-replaced-blocks-pending-changes.md`. **Release order:** for those fixes to ship in the old packages' own changelogs, release them from `main` (a Version Packages release) before PR 12 merges; after it, they appear only as `Auth` notes.
- PR 06 carries the six old-package changesets (L7). PRs 02–04 carry their language's own changesets under `native/*/.changeset`.

---

## 2. How each PR was built and checked

- **Built from the reference tree.** Every path that differs between `main` and the reference tree is routed to exactly one PR, and that PR takes the tree's version of the file. Shared files are edited per PR:
  - the root `package.json` gains the `bb-auth` workspace in 07 and the upgrade scripts in 11;
  - the root `tsconfig.json` gains the old blocks' references in 06 and `bb-auth` in 07;
  - `.gitignore`;
  - `auth-common/src/index.ts`;
  - `bb-auth/package.json`, which has no `bin` until PR 10.
- **Regenerated per PR, not copied:** the lockfile, API reports, `official-bb-names.generated.ts` and the native goldens. The reference tree regenerates byte-identically: PR 12 has zero drift.
- **Each branch passed on its own,** from a fresh `npm ci`: build, `comprehensive`'s `tsc --noEmit`, and every test app's `tsc --noEmit` against `main`'s own results. The reference tree also passed the unit tests, the native suites (Swift, Kotlin, Dart, golden compiles, round trips) and the fixture checks.
- **AWS:** the full tree passed end to end on AWS. That covers upgrade-in-place, `comprehensive` sandbox and production, hosting, native, and the CloudFront front door (R118–R120 in `LATER-DISCUSSION.md`, and PR #711).

---

## 3. Merging

```
main (#850 merged) ◄─ 02 ◄─ 03 ◄─ 04 ◄─ 05 ◄─ 06 ◄─ 07 ◄─ 08 ◄─ 09 ◄─ 10 ◄─ 11 ◄─ 12 ◄─ 13 ◄─ 14
```

- **Merge bottom to top.** When a PR merges, GitHub retargets the one above it to `main`.
- **Review in parallel:** 02–04 go to the Kotlin, Swift and Dart reviewers at the same time. PRs 08–10 can be reviewed together with 07.
- **R1, the last old-block patch, goes between 06 and 07.** Merge the Version Packages PR after 06, so `bb-auth-cognito` 0.1.13 and `bb-auth-oidc` 0.2.3 ship B6's fixes. Then re-pin the upgrade harness to the new tag; that's one line in PR 11.
- **If `main` moves,** merge it into the reference tree once, then re-cut the stack from the new tree with the same routing. Don't rebase each PR by hand.

---

## 4. Release plan

| When | Release | What it ships |
|---|---|---|
| After 01 (merged; its changesets are pending on `main`) | normal Version Packages | core, data, `bb-file-bucket`, `bb-agent`, umbrella |
| As 02–05 merge | normal Version Packages | native SDKs through their own changesets (Kotlin, Swift) and `## Unreleased` (Dart). **Release Dart's `blocks_runtime` and `blocks_codegen` together** (L57, L65). |
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
