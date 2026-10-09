# Auth unification — migration, phasing, and delivery plan

Status: **proposal / planning only.** No source file has been changed to produce this document.
Scope: how we merge `bb-auth-basic`, `bb-auth-cognito`, `bb-auth-oidc` (+ the shared `auth-common`) into one
Cognito-backed auth Building Block **without wrecking existing users**, and in what order we ship it.

Companion documents in this folder: `01-inventory.md`, `02-better-auth-prior-art.md`, `03-cognito-capabilities.md` exist;
`04` is not yet written. Findings from `01` and `03` are incorporated below and attributed inline. This document
deliberately avoids links to `04` so it stays link-clean at HEAD.

Baseline as read: branch `refactor/auth-blocks` at `bbd2c13d` (zero commits ahead of `main`; the refactor has not
started). Versions on disk: `@aws-blocks/auth-common@0.1.8`, `@aws-blocks/bb-auth-basic@0.1.9`,
`@aws-blocks/bb-auth-cognito@0.1.10`, `@aws-blocks/bb-auth-oidc@0.2.0`, `@aws-blocks/blocks@0.6.0`,
`@aws-blocks/core@0.5.0`.

> **Maintainer sign-off required before any of this is implemented.** Per the root `AGENTS.md` ("Stop and ask before
> any breaking change"), this refactor implies changed return types, narrowed unions, removed exports, changed export
> maps, and a changed on-disk mock format. Section 1.10 is the explicit sign-off checklist. Nothing in Phases 3+ should
> be merged until that list is signed off.

---

## 0. TL;DR

1. **Does an existing app's Cognito user pool get replaced (all users destroyed) on the next deploy?**
   **No — and the property-level answer is stronger than expected: no `AWS::Cognito::UserPool` property triggers
   CloudFormation `Replacement` at all** (`03-cognito-capabilities.md` §5.3.2). A pool is effectively permanent; even
   changing `userPoolName` does not recreate it. Neither the CDK logical ID nor `fullId` contains the class name, so
   renaming `AuthCognito` to a unified `Auth` is resource-identity-neutral.
   **Two real failure modes remain, and they are different from "replacement":**
   - **Catastrophic, and outside CFN's property machinery: a changed logical ID.** If the block's **child construct ids**
     (`pool`, `client`, `sessions`, `session-secret`, `group-<name>`) change, or an internal nesting level is added, or
     the customer's block `id` changes, CloudFormation sees a *different resource* — it creates a new pool and
     **deletes the old one**, because the default `removalPolicy` is `DESTROY`. This is the one that destroys users, and
     nothing in CI catches it today.
   - **The likely everyday failure: rollback-on-update, not replacement.** Four user-pool properties are immutable at the
     *service* level while CloudFormation documents them as "No interruption" — sign-in/alias attributes,
     `UsernameConfiguration.CaseSensitive`, required attributes, and existing custom attributes. CDK synths happily, then
     `UpdateUserPool` rejects the call → **failed stack update and rollback.** Recoverable, but it bricks the deploy, and
     a unified block that changes a `signInWith` default or adds a required attribute walks straight into it.
   Genuine replacement *does* occur for `UserPoolClient.GenerateSecret`, `UserPoolClient.UserPoolId`,
   **`UserPoolDomain.Domain`**, and `UserPoolDomain.UserPoolId` — which matters because federation *requires* a user-pool
   domain. See §1.1. **And this good news only covers `bb-auth-cognito` users:** `AuthBasic` users have **no pool at all**
   (their credentials are bcrypt hashes in DynamoDB) and `AuthOIDC`'s federation pool is named `<fullId>-federation`, a
   different name. For those two, unification is a **data migration**, not a rename.

2. **Recommended deprecation strategy: a hybrid, not one of (a)/(b)/(c).**
   - `bb-auth-cognito` → **(a) thin deprecated re-export shim** of the new block. Safe because synth output is
     byte-identical.
   - `bb-auth-basic` and `bb-auth-oidc` → **(c) frozen but functional.** They *cannot* be re-export shims: aliasing
     `AuthBasic` onto a Cognito-backed block would silently re-provision every existing deployment.
   - `auth-common` → **keep as-is** (shared contract + `Authenticator`; not a Building Block).
   - **(b) hard cutover with a codemod is rejected** — a codemod cannot migrate bcrypt password hashes into Cognito.
   Because all four packages are `0.x`, a **minor** bump is already a hard wall for `^` consumers, so we do not need a
   long shim window. Details and justification in §2.

3. **Phase list** (each row is one or more independently-mergeable PRs; see §5):

   | Phase | What it lands | Breaks anything? |
   |---|---|---|
   | **P1** | **Test net** — P1a resource-identity golden tripwire, P1b close the CI blind spots | No — test-only |
   | **P2** | Reconcile the 3 live PRs (#583, #208, #297) + resolve the DESIGN.md conflict | No |
   | **P3** | Canonical error-name table + `requireAuth` contract fix in `auth-common` | No — additive |
   | **P4** | New `packages/bb-auth` (a–d: cdk / mock / aws / browser+ui), additive | No — old blocks untouched |
   | **P5** | Migration affordances: AuthBasic user-migration trigger; federated providers (**contingent**) | No — additive |
   | **P6** | Deprecate: `bb-auth-cognito` → shim; `bb-auth-basic`/`bb-auth-oidc` → frozen | Yes (announced) |
   | **P7** | Repo-wide consumer migration (a–d: test apps / templates / native / docs) | No |
   | **P8** | Removal — **out of scope here**, gated on adoption |

   **P1 must land first and is non-negotiable**: CI currently cannot detect the regressions P4–P6 risk (§6.0). P1a/P1b,
   P2's sub-PRs, P4b/P4c/P4d, and P7's four sub-PRs each run in parallel. **P5b (federation) is contingent** on the
   open "does OIDC route through Cognito?" decision — P1–P4 are deliberately structured to stay valid either way (§5).

---

## 1. Breaking-change surface

### 1.1 Deployed AWS resource identity — the gating analysis

**Mechanism (verified in the repo, not assumed).**

1. **CDK logical ID.** `packages/core/src/cdk/index.ts:231-237` — the CDK `Scope` constructor is:

   ```ts
   constructor(id: string, options?: ScopeOptions) {
       const parent = options?.parent || (globalThis as any).CURRENT_BLOCKS_STACK;
       super(parent, id);   // ← Construct id is the block's `id` string
   ```

   The construct path is therefore `<StackId>/<parent ids…>/<blockId>/<childId>/Resource`. CDK derives the logical ID
   from that path plus a hash of it. **The class name never appears in the path.**

2. **`fullId`.** `packages/core/src/common/index.ts:314-324`:

   ```ts
   export function computeScopeFullId(scope: { id: string; parent?: any }) {
     if (scope.parent) {
       if ('fullId' in scope.parent && scope.parent.fullId) return `${scope.parent.fullId}-${scope.id}`;
       if ('id' in scope.parent && scope.parent.id) return `${scope.parent.id}-${scope.id}`;
     }
     return scope.id;
   }
   ```

   Again: a `-`-joined chain of **ids only**. **The class name never appears.**

3. **Every physical name `AuthCognito` derives** (`packages/bb-auth-cognito/src/index.cdk.ts`):

   | Resource | Child construct id | Physical name | Source |
   |---|---|---|---|
   | `AWS::Cognito::UserPool` | `pool` | `this.fullId` (synth-guarded at >128 chars) | `index.cdk.ts:170`, guard at `:129` |
   | `AWS::Cognito::UserPoolClient` | `client` | (CFN-generated) | `index.cdk.ts:239` |
   | `AWS::Cognito::UserPoolGroup` | `group-<name>` | `<name>` | `index.cdk.ts:270` |
   | `AWS::DynamoDB::Table` (sessions) | `sessions` | `<authFullId>-sessions` | `bb-kv-store/src/index.cdk.ts:49` |
   | `AWS::SSM::Parameter` (HMAC) | `session-secret` | `/<authFullId>-session-secret` | `bb-app-setting/src/index.cdk.ts:137` |
   | Config keys | — | `BLOCKS_AUTH_COGNITO_<UPPER_FULLID>_{USER_POOL_ID,CLIENT_ID,REGION}` | `bb-auth-cognito/src/types.ts:1241` |
   | Session cookie | — | `auth_<fullId>` | `bb-auth-cognito/src/cookies.ts:28` |

**Verdict.** Renaming the class `AuthCognito` → `Auth` (or moving it to a new package `@aws-blocks/bb-auth`) is, **by
itself, resource-identity-neutral**: zero logical-ID change, zero physical-name change, zero config-key change, zero
cookie-name change. This is what makes a non-destructive cutover possible at all.

**What *does* go wrong** — five vectors, in descending severity. Note that **only V1–V3 destroy users**, and they do so
*outside* CloudFormation's property-update machinery; V4–V5 are failed deploys and collateral loss.

| # | Change | Consequence |
|---|---|---|
| **V1** | Rename a child construct id (`'pool'` → `'userPool'`, `'sessions'` → `'session-store'`, …) | Logical ID changes → CFN creates a new pool and **deletes the old one**. Default `removalPolicy` is `DESTROY` (`index.cdk.ts:229-231`) → **every user destroyed.** Nothing in the current test suite catches this. |
| **V2** | Add an internal nesting level (e.g. `new CognitoProvider(this, 'cognito')` owning the pool) | Construct path **and** `fullId` both change → new logical ID (V1's wipe) *plus* renamed `userPoolName`, sessions table, and SSM parameter. |
| **V3** | Migration guide tells users to change the block `id` (e.g. `'authC'` → `'auth'`) | Same as V2, and it is the customer who pulls the trigger. **The codemod must refuse to rewrite the `id` argument.** |
| **V4** | Change a property that is **immutable at the service level** but documented "No interruption": sign-in/alias attributes (`signInWith`), `UsernameConfiguration.CaseSensitive`, required attributes, or an existing custom attribute | CDK synths fine; `UpdateUserPool` then **rejects** → **failed stack update and rollback.** This is the *likely* everyday failure mode of a unified block that normalizes defaults. Users survive; the deploy does not. Needs a **synth-time guard**, extending the existing `signInWith` guard pattern. (`03-cognito-capabilities.md` §5.3.1) |
| **V5** | Change `UserPoolClient.GenerateSecret`, or `UserPoolDomain.Domain` | **Genuine CFN `Replacement`.** New client ID ⇒ every session invalid; a recreated domain kills all hosted-UI sessions and can change the passkey relying-party ID. Relevant because **federation requires a user-pool domain** (`03` H2). |

Two corrections to assumptions worth recording, because they change the plan:

- **`userPoolName` is NOT replacement-causing.** No `AWS::Cognito::UserPool` property is (`03` §5.3.2). A `fullId`
  change therefore does not destroy the pool — but it *does* rename the sessions DynamoDB table and the SSM parameter,
  both of which **are** definitively replacement-on-change, so a `fullId` change still means a lost session store and a
  rotated HMAC secret (**mass logout**). Preserve `fullId` regardless.
- **`WebAuthnRelyingPartyID` is technically mutable but semantically destructive** — changing it invalidates every
  registered passkey. The unified block should treat it as immutable in its own API.

**Therefore the plan is gated on a frozen construct-id contract plus synth-time immutability guards**, enforced by tests
(P1a) rather than by reviewer vigilance:

> The unified block **MUST** keep the customer-supplied `id` semantics unchanged, keep the child construct ids `pool`,
> `client`, `sessions`, `session-secret`, `group-<name>`, and keep `userPoolName: this.fullId`. Any change to those five
> strings is a user-data-destroying change and requires explicit maintainer sign-off plus a documented CFN import path.

**Amplifier worth fixing separately:** the default `removalPolicy` is `DESTROY` for sandbox ergonomics, which is what
turns a V1 logical-ID change from "an orphaned pool" into "every user destroyed". Recommended, in priority order:
(i) P4a adds a synth-time warning when a pool-owning block is constructed without an explicit `removalPolicy`;
(ii) the migration guide leads with `removalPolicy: 'retain'`; (iii) expose Cognito's own
`DeletionProtection: ACTIVE` as an option and recommend it for production (`03` §5.3.2 argues it should be the
production default). Changing the *default* of either is itself a synth-output change for every existing user and needs
its own sign-off — propose it, do not fold it into this refactor.

**The other two blocks are a different, harder problem.**

- **`AuthBasic` owns no Cognito pool.** `packages/bb-auth-basic/src/index.ts:166-168` provisions
  `KVStore(this,'users')`, `AppSetting(this,'jwt-secret',{secret:true})`, `KVStore(this,'codes')`. User records live in
  DynamoDB `<fullId>-users` as `{ hash: string; createdAt: string; unconfirmed?: boolean }` where `hash` is
  **bcrypt, cost 12** (`index.ts:256`). Moving to Cognito means a brand-new user pool appears, the `users`/`codes`
  tables are orphaned (and deleted if the child ids disappear), and **Cognito cannot import bcrypt hashes.** There is no
  rename that makes this safe. The only non-destructive path is a Cognito **`UserMigration` Lambda trigger** that
  bcrypt-compares against the old table on first sign-in and creates the user just-in-time (viable because the block
  uses `USER_PASSWORD_AUTH`, for which the trigger fires with the plaintext password). That is P5.
  Note `bb-auth-basic` also has **no `cdk` or `aws-runtime` export condition** — its single `index.ts` serves as both
  mock and CDK path, relying on its child blocks to resolve per-condition.
- **`AuthOIDC`'s Cognito pool is named `<fullId>-federation`** (`bb-auth-oidc/src/index.cdk.ts:157`) — a *different*
  name from `AuthCognito`'s `<fullId>`. It also owns an IdP-registration Lambda, a `Provider` custom resource, a log
  group, `KVStore('sessions')`, and `AppSetting('cookie-secret-<id>')` at parameter `/<fullId>-cookie-secret-<id>`.
  Unifying onto `AuthCognito`'s naming replaces the federation pool. No *user credentials* are lost (identities live at
  the external IdP), but see the next item, which is worse.
- **`OIDCUser.userId` is `` `${iss}:${sub}` ``; `CognitoUser.userId`/`userSub` is a Cognito UUID.** Any customer who
  persisted `user.userId` as a row key has **dangling application data** after unification, with no automated fix. Our
  own `test-apps/comprehensive/aws-blocks/index.ts:242` does exactly this (`oidcProfiles.put(\`profile:${user.userId}\`)`).
  This, not resource replacement, is the single hardest break in the refactor.

### 1.2 Removed / renamed packages

| Package | Fate | Break |
|---|---|---|
| `@aws-blocks/bb-auth-cognito@0.1.10` | becomes a deprecated re-export shim of `@aws-blocks/bb-auth` | none at the source level; the published tarball's content changes |
| `@aws-blocks/bb-auth-basic@0.1.9` | frozen, functional, deprecated | none until removal |
| `@aws-blocks/bb-auth-oidc@0.2.0` | frozen, functional, deprecated | none until removal |
| `@aws-blocks/auth-common@0.1.8` | kept (shared contract + `Authenticator`) | none |
| `@aws-blocks/bb-auth` | **new** | none (additive) |

Naming note: the root `AGENTS.md:209` rule is "Auth BBs lead with `Auth`". A single unified block named `Auth` in a
package named `bb-auth` satisfies it, but `docs/DECISIONS.md:113-133` (decision "D — naming") explicitly documents the
*multi-package* auth family and must be amended, not silently contradicted.

### 1.3 Removed / changed exports

The union of exports across the three blocks is large and overlapping. Concretely:

- **`bb-auth-basic` loses:** `AuthBasicUser`, `AuthBasicOptions`, `AuthBasicErrors`, `CodeDeliveryFn`, and
  `AuthBasic.buildApi()` (already `@deprecated`, and a *second* `ApiNamespace(this,'auth')` — only one can be mounted).
- **`bb-auth-oidc` loses:** `AuthOIDCErrors`, `AuthOIDCErrorName`, `RelayOrigin`/`relayOrigin`, `OIDCUser`,
  `MappedClaims`, `OIDCClient`, `google`, `github`, `customOidc`, `customOauth2`, `stubIdp`, `cognitoFederated`,
  `AuthOIDCClient`, `resolveApiBaseOrigin`, `handle401`, plus the `./middleware` and `./client` subpaths.
  `AuthOIDC.getClient()` on the API namespace and `AuthOIDC.handleCallbackDispatch()`/`handleExchange()`/
  `refreshBearerTokens()`/`getSignInUrl()` have no counterpart on `AuthCognito`.
- **`bb-auth-cognito` gains** everything, and **`extractUserAttributes`** (currently an AWS-entry-only export) has to be
  reconciled across entries.
- **Asymmetries that will surface as parity failures:** `packages/blocks/src/index.browser.ts` exports **no** auth
  symbols today while `index.ts` and `index.cdk.ts` both do; `bb-auth-cognito`'s `files[]` omits `src` while the other
  three include it; `bb-auth-oidc` has no `src/index.ts` at all (its default entry is `index.mock.ts`).

### 1.4 Changed method signatures

| Concern | Today | After |
|---|---|---|
| `requireAuth` return type | three incompatible shapes: `AuthBasicUser` (`+createdAt`), `CognitoUser<O>` (`+userSub,groups,attributes`), `OIDCUser` (`+provider,sub,iss,email,name,claims`) | one shape → **narrowed union / changed return type for two of three blocks** |
| constructor `options` | `AuthBasic`/`AuthCognito`: `options?`; `AuthOIDC`: **required** (`providers`) | must be optional → OIDC callers keep compiling, but a `providers`-less unified block must reject federated calls at runtime |
| `signIn`/`signUp` | present on Basic + Cognito, **absent** on OIDC | present; OIDC-shaped apps gain methods that throw unless configured |
| `signOut` | `AuthBasic(ctx)`, `AuthCognito(ctx, {global?})`, `AuthOIDC(ctx)` | one signature |
| `confirmSignUp` | `AuthBasic` **requires** `password` in the `setAuthState` payload (throws `ApiError(…,400)` without it) — diverges from the shared `AuthActionPayloadMap` where it is optional | unified; AuthBasic-shaped clients that omitted it still break |
| `createApi()` return type | annotated `AuthStateApi` on Cognito; **un-annotated** on Basic and OIDC; OIDC adds a third method `getClient()` | one annotated type → OIDC's `getClient` disappears from the namespace |
| `requireRole`, admin surface (13 methods), MFA, passkeys, devices, `fetchAuthSession` | Cognito only | available everywhere (additive) |

### 1.5 Changed error names

Errors cross the wire by `name` (root `AGENTS.md` core rule 6), and `core`'s `hasAuthError(state, name)` takes a
**`string`** — so every renamed name is a **silent** break with no compile error.

| Concept | `AuthBasic` | `AuthCognito` | `AuthOIDC` |
|---|---|---|---|
| not signed in | `SessionExpiredException` | `NotAuthenticatedException` | `NotAuthenticatedException` + `TokenExpiredException` |
| bad credentials | `InvalidCredentialsException` | `NotAuthorizedException` | — |
| duplicate user | `UserAlreadyExistsException` | `UsernameExistsException` | — |
| bad code | `InvalidCodeException` (one name for wrong *and* expired) | `CodeMismatchException` / `ExpiredCodeException` / `EnableSoftwareTokenMFAException` | — |
| password policy | `InvalidPasswordException` | `InvalidPasswordException` | — |

Only **two** strings are shared across any pair (`NotAuthenticatedException` between Cognito and OIDC;
`InvalidPasswordException` between Basic and Cognito). Everything else is a rename.

**The `requireAuth` 401 divergence, with exact throw sites** (all verified):

| Block | Site | Name thrown |
|---|---|---|
| `AuthBasic` | `bb-auth-basic/src/index.ts:395` | `AuthBasicErrors.SessionExpired` → `SessionExpiredException` |
| `AuthCognito` | `bb-auth-cognito/src/index.ts:1167` | `AuthCognitoErrors.NotAuthenticated` → `NotAuthenticatedException` |
| `AuthOIDC` | `bb-auth-oidc/src/auth-oidc.ts:648` | literal `'NotAuthenticatedException'` |

`auth-common/src/index.ts:47` documents **only** the first: `@throws {ApiError} 401 with name SessionExpiredException`.
So the shared interface's own contract is already wrong for two of three implementations — P3 must pick one name and fix
the JSDoc, and that choice is itself a breaking change for whichever side loses.

**Two option-level renames inside identically-named types** (silent, because both blocks export `PasswordPolicy` and
`CodeDeliveryFn`):

| Symbol | `bb-auth-basic` | `bb-auth-cognito` |
|---|---|---|
| `PasswordPolicy` special-character flag | `requireSpecialChars?` (`index.ts:44`, enforced at `:220`) | `requireSymbols?` (`types.ts:95`) |
| `CodeDeliveryFn` arity | `(username, code) => Promise<void>` (`index.ts:57`) — **2 args** | `(username, code, purpose) => …` (`types.ts:144`) — **3 args** |

A user migrating from Basic silently loses special-character enforcement (the flag is dropped, not rejected), and their
2-arg `codeDelivery` callback keeps compiling while ignoring `purpose`.

Also coupled: `packages/core/src/errors.ts:119` uses `AuthBasicErrors.InvalidCredentials` in a doc example, and
`packages/core/src/redact.test.ts:105,118` asserts on the literal UI label `'Set Up Authenticator'`.

### 1.6 Changed export maps

Three different shapes today:

```jsonc
// bb-auth-basic — NO cdk, NO aws-runtime, NO ./ui
".": { "browser": …, "types": "./dist/index.d.ts", "default": "./dist/index.js" }

// bb-auth-cognito — full 4-way + ./ui   (note: "aws-runtime" has no "types")
".": { "browser": …, "cdk": {…}, "aws-runtime": …, "types": "./dist/index.d.ts", "default": "./dist/index.js" },
"./ui": {…}

// bb-auth-oidc — full 4-way, default is index.mock, plus ./middleware and ./client
".": { …, "types": "./dist/index.mock.d.ts", "default": "./dist/index.mock.js" },
"./middleware": {…}, "./client": {…}
```

Any unified map necessarily drops conditions from one package and adds them to another — a changed export map, which
`AGENTS.md` classifies as a breaking change requiring sign-off. Two mechanical consequences:
`packages/blocks/src/conditional-exports.test.ts` **auto-discovers** BB packages (any `packages/bb-*` with an
`aws-runtime` condition) and asserts `bbPackages.length >= 8` at line 77 — collapsing three into one lowers the count
by two (note `bb-auth-basic` is not currently discovered, having no `aws-runtime` condition); and
`scripts/check-aws-blocks-exports-consistency.ts` gates the `aws-blocks/package.json` condition set in every template
and test app.

### 1.7 Changed `.bb-data` on-disk mock format

`getMockDataDir` resolves to `.bb-data/<fullId>/` (`packages/core/src/common/mock-data.ts:46`), so preserving `fullId`
preserves the *directory*; the **record schemas** are what break.

| Block | Files | Shape |
|---|---|---|
| `bb-auth-basic` | `.bb-data/<id>-users/store.json`, `.bb-data/<id>-codes/store.json`, root `.bb-data/settings.json` | user = `{ hash, createdAt, unconfirmed? }` (bcrypt); code = `{ hmac, expires }` |
| `bb-auth-cognito` | `.bb-data/<id>/state.json` (+ `state.json.corrupt-<ISO>` on parse failure), `.bb-data/<id>/last-code.json`, `.bb-data/<id>-sessions/store.json` | `state.json` = `{ users, groups, codes, challenges, sessionSecret }`; user = `{ userSub, password (plaintext, mock-only), confirmed, disabled, attributes, mfaPreference, totpSharedSecret?, totpVerified, devices, passkeys?, forcePasswordChange? }` |
| `bb-auth-oidc` | **reads** `.bb-data/<id>/users.json` (stub IdP fixture); sessions in `store.json` | `StubUser[]`; session row `{ userId, refreshToken, expiresAt, claims, state, refreshingSince? }` |

There is **no field overlap beyond the username key**, and the confirmation flag has inverted polarity
(`unconfirmed?: true` vs `confirmed: boolean`). Verdict: zero forward-read compatibility. Severity is low (local dev
scratch) but it must be *declared*, and the unified mock must **tolerate** an unreadable/foreign file by starting fresh
plus logging, never by throwing. Migration note for the guide: "delete `.bb-data/` after upgrading."

One subtle trap: `bb-auth-oidc`'s runtime creates `KVStore(scope, \`${id}-sessions\`)` (parent = the *outer* scope)
while its CDK entry creates `KVStore(this, 'sessions')` (parent = the block). Both produce the same `fullId` string only
because of the `-` join. "Tidying" either one silently orphans data on both sides.

### 1.8 Sessions, cookies, and secrets

- **Cookie-name collision — an unresolved cutover design question, not just a type change.** Basic and Cognito use the
  **same** cookie name `auth_<fullId>` with **incompatible payloads**: Basic stores a self-contained HS256 JWT
  (`bb-auth-basic/src/index.ts:354-355`), Cognito an HMAC-signed opaque session id resolved against a server-side
  KVStore row (`bb-auth-cognito/src/cookies.ts:28`). OIDC uses `oidc_<fullId>`. So the moment an app switches from
  `AuthBasic` to the unified block, **every already-signed-in user presents a cookie that is structurally valid,
  correctly named, and semantically garbage.**
  This needs a decision, and both options have real costs:
  - **(i) Reject and clear** — treat an unparseable/unresolvable cookie as signed-out, `Set-Cookie` with `Max-Age=0`, and
    let the user sign in again. Simple, safe, but a **forced logout of the entire user base at cutover**, on top of the
    forced credential migration (§1.1). Recommended default.
  - **(ii) Recognize and upgrade** — detect the legacy JWT shape, verify it against the old `jwt-secret`, and mint a new
    Cognito-backed session. Seamless, but it means the unified block accepts a second, weaker credential format, keeps
    reading the legacy `AppSetting`, and only works for users who exist in Cognito already — i.e. it must be sequenced
    *after* P5a's user-migration trigger. It also widens the attack surface and should be time-boxed behind an explicit
    opt-in option with a documented sunset.
  **Non-negotiable either way:** an unparseable cookie must never produce a 500, and it must never be treated as
  authenticated. P1b should add a test that plants each legacy cookie shape against each block.
- Session secret sources differ three ways: `AppSetting('jwt-secret')` (Basic), `state.sessionSecret` in mock /
  `AppSetting('session-secret')` in AWS (Cognito), SSM via `cookieSecretEnvVar(fullId)` / a hard-coded mock constant
  (OIDC). Any `fullId` change rotates the SSM parameter name → new secret → **mass logout**.

### 1.9 Repo-internal contracts that break

- `packages/blocks/src/sdk-identifiers.ts:21-22,57-58` — typed overloads
  `getSdkIdentifiers(bb: AuthCognito<any>): { userPoolId; clientId }` and `(bb: AuthOIDC<any>): { sessionTableName }`.
- `packages/bb-data/src/db-pull.test.ts:282-285` — asserts the generated auth example uses `AuthOIDC` and **not**
  `AuthCognito`. **This assertion inverts** under a Cognito-only merge.
- `packages/core/src/common/official-bb-names.generated.ts:13-15` (`'AuthBasic','AuthCognito','AuthOidc'`) is generated
  from `packages/blocks/package.json` → `aws-blocks.vendorize` by `scripts/generate-bb-names.mjs`, which also carries a
  hardcoded alias `'AuthOIDC' → 'AuthOidc'` at lines 29-33. Removing names changes telemetry continuity.
- `packages/core/src/redact.ts:22,38,53` — the redaction vocabulary is keyed off `auth-common`'s `AuthField` /
  `confirmSignIn` payload names.
- **`AuthOIDC.createApi()` exposes a third method, `getClient()`, which returns a Transferable** — so OIDC's namespace is
  structurally a *superset* of `AuthStateApi`, not an instance of it. Any unified RPC surface either drops it (breaking
  the browser/native clients that hydrate it) or forces `AuthStateApi` to grow a method the other blocks cannot serve.

**Blast radius outside TypeScript — changes the compiler cannot see:**

- **Three native SDKs hand-implement OIDC's HTTP protocol** with no typecheck against the TS source:
  `native/kotlin/runtime/.../oidc/` (14 files), `native/swift/Sources/BlocksRuntime/OIDC/`,
  `native/dart/packages/blocks_runtime/lib/src/oidc_*.dart`. If the unified block changes a route path, a state-envelope
  encoding, or an error name, these break **silently at runtime** — only the native e2e suites catch it.
- **`packages/bb-data/src/db-pull/templates.ts:181-215` emits `AuthOIDC` import statements as *strings*** inside a
  markdown code fence in generated output. Invisible to `tsc`, invisible to Biome, and asserted by
  `db-pull.test.ts:282-285` — which asserts the generated guide uses `AuthOIDC` and **not** `AuthCognito`, and therefore
  **inverts** under a Cognito-only merge.
- **A shadow `requireAuth` that never imports the interface:** `test-apps/amplify-gen2/aws-blocks/cognito-verifier.ts:91`
  and the equivalent in `templates/amplify`. It satisfies the contract structurally, so a change to `BlocksAuth`
  produces no error here — it just drifts out of compatibility.

### 1.10 CI cannot currently catch these regressions — three blind spots

This is why P1 exists as a prerequisite rather than a nice-to-have. **Today, the safety net under the auth layer has
holes exactly where the refactor will cut.**

1. **`conditional-exports.test.ts` proves far less than it appears to.** `assertSuperset` (L49-65) only checks
   `default ⊆ condition`, in **one direction**, and only for two pairs: `aws-runtime` on auto-discovered `packages/bb-*`
   packages, and `cdk` on the umbrella. Consequently it never checks the `cdk` condition on an individual BB, never
   checks `browser` at all, never discovers `auth-common` (no `bb-` prefix, no `aws-runtime` condition), and never
   catches an **extra** export in one entry — which is why `extractUserAttributes` living only in
   `bb-auth-cognito/src/index.aws.ts` passes green today. Real parity gaps are passing right now.
2. **Root `tsconfig.json:3-19` omits `bb-auth-cognito` and `bb-auth-oidc`.** They reach the build graph only
   *transitively*, via `packages/blocks/tsconfig.json:10-13`. Their `include` is `src/**/*`, so the four Cognito
   type-contract files (`admin.types-test.ts`, `confirmSignIn.types-test.ts`, `fetchAuthSession.types-test.ts`,
   `types.types-test.ts`) *are* typechecked today — but only for as long as the umbrella keeps referencing them. Any
   phase that reworks the umbrella's project references can silently delete that type coverage with no failing test.
   (Related gap: `bb-auth-cognito/tsconfig.json` references `core`, `auth-common`, `bb-kv-store`, `bb-logger` but **not**
   `bb-app-setting`, which its `index.cdk.ts` imports.)
3. **The AWS layer is almost untested by default.** `bb-auth-cognito/src/index.aws.ts` is 2465 lines; its companion
   `index.aws.test.ts` has **6 tests, all covering the single pure function `extractUserAttributes`**. Every substantive
   AWS-path suite — `user-auth-integration.test.ts`, `scenarios.sandbox.test.ts`,
   `scenarios.passwordless-demo.sandbox.test.ts` — is gated on `BLOCKS_INTEGRATION=1` and therefore **skipped by
   `npm test`**. Restructuring that file without first adding default-run coverage is the highest-variance move in the
   whole plan.

### 1.11 Maintainer sign-off checklist (`AGENTS.md` "stop and ask")

Do not merge Phase 3 or later until each of these is explicitly approved:

1. Changed return type of `requireAuth`/`getCurrentUser` for `AuthBasic` and `AuthOIDC` consumers (§1.4).
2. Removed exports: the `bb-auth-oidc` provider/client surface and `bb-auth-basic`'s `buildApi()` (§1.3).
3. Renamed error names — 4 of 5 `AuthBasicErrors` values and all 8 `AuthOIDCErrors` values (§1.5).
4. Changed export maps, including dropping `./middleware` / `./client` / `./ui` subpaths (§1.6).
5. Changed `.bb-data` on-disk format, with no forward-read path (§1.7).
6. The `OIDCUser.userId` → Cognito `sub` identity change, which dangles customer foreign keys (§1.1).
7. That `AuthBasic` credentials require a Cognito `UserMigration` trigger (P5) or a forced password reset (§1.1).
8. Amending `docs/DECISIONS.md` decision "D — naming" (multi-package auth family) and root `AGENTS.md:103,110,209`.
9. **The cookie-cutover behavior** for already-signed-in AuthBasic users: reject-and-clear (forced logout) vs
   recognize-and-upgrade (§1.8). This is a security decision, not a detail.
10. **`bb-auth-cognito/DESIGN.md` Key Design Decision #3** — "group membership from the `cognito:groups` claim, not a
    runtime `AdminListGroupsForUser` call" — is **directly contradicted** by open PR #583, which makes `requireRole` read
    live membership. One of the two is wrong. Resolving this decides whether the unified block pays a Cognito API call
    per authorization check (correctness/revocation latency) or caches group membership in the token (cost/latency). It
    must be settled **before** P4 bakes one semantics in. See §7.
11. **Whether federated/OIDC sign-in routes through Cognito at all** (cost cliff, no PKCE toward the upstream IdP,
    federation unmockable locally, and it forces a `UserPoolDomain` whose `Domain` change is replacement-causing). P5b is
    contingent on this.

---

## 2. Deprecation strategy

### 2.1 What `0.x` buys us

All four packages are `0.x`, and under semver `^0.1.10` does **not** match `0.2.0`. A **minor** bump is therefore
already a hard wall: no existing install auto-upgrades, and `npm install` in an existing app will not pull the new
shape. CI reinforces this — `scripts/changeset-guard.ts` has a `block-major` subcommand that hard-fails any `major`
bump, because `0.x → 1.0.0` means leaving pre-release and needs separate sign-off. Precedent exists:
`bb-auth-oidc` is already at `0.2.0`, i.e. this project has shipped a `0.x` breaking minor before.

**Consequence: we can move faster than a `1.x` project could.** We do not need a long shim window to protect users from
an accidental upgrade — semver already does that. What the shim window buys is *migration ergonomics*, not safety.
Recommend a **two-minor window** (deprecate in minor N, remove no earlier than N+2) and a hard precondition that
**removal cannot happen until the AuthBasic user-migration path (P5) has shipped and been validated on real AWS.**

### 2.2 The three candidate strategies, assessed

**(a) New block + three thin deprecated re-export shims for N releases.**
Works *only* for `bb-auth-cognito`, where synth output is byte-identical. It is **actively dangerous** for the other
two: making `AuthBasic` a re-export of a Cognito-backed block means the next `cdk deploy` of an unchanged app
provisions a new user pool, orphans (or deletes) the `<fullId>-users` table holding every bcrypt hash, and locks out
every user — a silent, catastrophic change triggered by a patch-level dependency update. Same for `AuthOIDC`
(federation pool renamed, `userId` format changed).

**(b) Hard cutover with a codemod.** Rejected. A codemod rewrites *call sites*; it cannot move bcrypt hashes into
Cognito, cannot re-key customer data from `${iss}:${sub}` to a Cognito `sub`, and cannot re-issue sessions. A codemod
is a *useful component* of the migration guide (§3) but cannot be the strategy.

**(c) New block + old blocks frozen but functional.** Safe for all three, but leaves `bb-auth-cognito` users doing a
pointless package rename for a block whose infrastructure is literally identical — wasted migration cost on the
largest and most sophisticated user base.

### 2.3 Recommendation

**A hybrid, chosen per package by whether the infrastructure is identical:**

| Package | Strategy | Why |
|---|---|---|
| `@aws-blocks/bb-auth-cognito` | **(a) thin deprecated re-export shim** | Synth output is byte-identical (§1.1). Zero-risk, zero-effort upgrade for the block with the most surface. Shim keeps its full export map (including `./ui`) and adds `@deprecated` JSDoc + a dev-only one-time console warning. |
| `@aws-blocks/bb-auth-basic` | **(c) frozen but functional**, deprecated | Re-export would re-provision infrastructure and destroy credentials. Users migrate deliberately, via P5's `UserMigration` trigger. |
| `@aws-blocks/bb-auth-oidc` | **(c) frozen but functional**, deprecated | Different pool name, different `userId` format, and ~40 native-client OIDC files (Kotlin/Swift/Dart) depend on its protocol. |
| `@aws-blocks/auth-common` | **keep, unchanged role** | Not a Building Block. It owns `BlocksAuth`, `Authenticator`, and the `@aws-blocks/auth-common/cookies` D-007 parity helper; `packages/blocks/src/ui.ts` re-exports from it. Folding it in would break direct `@aws-blocks/auth-common/ui` importers for no gain. |

Mechanics: one **minor** bump per package, `@deprecated` JSDoc on every old export (so deprecation surfaces on hover —
the primary agent/IDE channel), `npm deprecate` on the published versions at P6, and a `MIGRATION.md` in each old
package. Per `AGENTS.md` core rule 10 **and** `changeset-guard verify-umbrella`, every phase's changeset must include
`@aws-blocks/blocks` alongside the changed packages, or `changeset publish` fails the whole release run.

---

## 3. Codemod / migration guide sketch

The codemod handles the mechanical 80%; the residue is flagged with `// TODO(auth-migration):` comments so it cannot be
missed. Ship it as `npx @aws-blocks/blocks migrate-auth` (or `scripts/codemod/auth-unify.ts`).

### 3.1 `AuthCognito` → `Auth` (fully mechanical, zero infra change)

```ts
// BEFORE
import { AuthCognito, AuthCognitoErrors } from '@aws-blocks/blocks';
const auth = new AuthCognito(scope, 'auth', {
  passwordPolicy: { minLength: 8, requireDigits: true },
  groups: ['admins', 'readers'],
  admin: {},
  mfa: 'optional', mfaTypes: ['TOTP'],
});
export const authApi = auth.createApi();

// AFTER  — same id, same child ids, same userPoolName ⇒ byte-identical synth
import { Auth, AuthErrors } from '@aws-blocks/blocks';
const auth = new Auth(scope, 'auth', {
  passwordPolicy: { minLength: 8, requireDigits: true },
  groups: ['admins', 'readers'],
  admin: {},
  mfa: 'optional', mfaTypes: ['TOTP'],
  removalPolicy: 'retain',            // ← guide leads with this
});
export const authApi = auth.createApi();
```

Codemod rules: `AuthCognito`→`Auth`, `AuthCognitoErrors`→`AuthErrors`, `AuthCognitoOptions`→`AuthOptions`,
`CognitoUser`→`AuthUser` (or the new user type), `AuthCognito.fromExisting`→`Auth.fromExisting`, and the
`@aws-blocks/bb-auth-cognito/ui` specifier → `@aws-blocks/bb-auth/ui`. **The codemod must never touch the `id`
argument** — add a hard assertion in the codemod itself, because rewriting it is vector V3 (§1.1).

### 3.2 `AuthBasic` → `Auth` (mechanical code change, **non-mechanical data migration**)

```ts
// BEFORE
import { AuthBasic, AuthBasicErrors } from '@aws-blocks/blocks';
const auth = new AuthBasic(scope, 'auth', {
  sessionDuration: 86400,
  passwordPolicy: { minLength: 6 },
  codeDelivery: async (username, code) => { await sendEmail(username, `Your code: ${code}`); },
});

// AFTER
import { Auth, AuthErrors } from '@aws-blocks/blocks';
const auth = new Auth(scope, 'auth', {
  sessionTtlSeconds: 86400,           // sessionDuration → sessionTtlSeconds
  passwordPolicy: { minLength: 6 },
  signInWith: ['username', 'email'],
  selfSignUp: true,
  removalPolicy: 'retain',
  // TODO(auth-migration): a NEW Cognito user pool is created here. Your existing
  // users live in DynamoDB table `<fullId>-users` as bcrypt hashes, which Cognito
  // cannot import. Choose ONE:
  //   migrateFrom: AuthBasic.fromExisting('<fullId>-users'),  // just-in-time UserMigration trigger (P5)
  // or run a one-off forced-password-reset campaign before cutover.
});
```

Call-site rewrites: `signIn(u,p,ctx)` unchanged; `confirmSignUp(u,code)` unchanged **but** the client `setAuthState`
payload no longer requires `password`; `AuthBasicUser.createdAt` has no Cognito equivalent (map to the
`UserCreateDate` admin read, which requires `admin: { actions: ['lifecycle'] }`); `buildApi()` has no replacement —
use `createApi()`. Error renames: `InvalidCredentialsException`→`NotAuthorizedException`,
`UserAlreadyExistsException`→`UsernameExistsException`, `InvalidCodeException`→`CodeMismatchException` **or**
`ExpiredCodeException` (one name becomes two — every `hasAuthError` call site must be reviewed by hand),
`SessionExpiredException`→`NotAuthenticatedException`.

### 3.3 `AuthOIDC` → `Auth` with federated providers (the hardest)

```ts
// BEFORE
import { AuthOIDC, google, relayOrigin } from '@aws-blocks/blocks';
const auth = new AuthOIDC(scope, 'oidc-auth', {
  providers: [google({ clientId: …, clientSecret: … })],
  callbackPath: '/aws-blocks/auth/callback',
  allowBearerAuth: true,
  allowedRelayOrigins: [relayOrigin('myapp://auth')],
  onSignIn: async (user) => { await profiles.put(`profile:${user.userId}`, …); },
});

// AFTER
import { Auth, google, relayOrigin } from '@aws-blocks/blocks';
const auth = new Auth(scope, 'oidc-auth', {
  federatedProviders: [google({ clientId: …, clientSecret: … })],
  callbackPath: '/aws-blocks/auth/callback',
  allowBearerAuth: true,
  allowedRelayOrigins: [relayOrigin('myapp://auth')],
  removalPolicy: 'retain',
  onSignIn: async (user) => { await profiles.put(`profile:${user.userId}`, …); },
  // TODO(auth-migration): BREAKING — the Cognito pool is renamed from
  // `<fullId>-federation` to `<fullId>`, which REPLACES it, and `user.userId`
  // changes from `${iss}:${sub}` to the Cognito `sub`. Any data you keyed on
  // `user.userId` must be re-keyed. See the OIDC re-keying recipe in the guide.
});
```

Residue the codemod must flag, never silently rewrite: `getClient()` removal (native/browser clients use it),
`handleCallbackDispatch`/`handleExchange`/`refreshBearerTokens`/`getAuthorizeParams` (relay + bearer flows),
`OIDCUser.claims`/`iss`/`sub`/`provider` → Cognito `identities` custom attribute, and the 8 `AuthOIDCErrors` renames.
**Recommendation: do not push AuthOIDC users to migrate in this cycle.** Keep the block frozen and functional; treat
federated support on the unified block as a forward-looking feature, not a migration mandate.

---

## 4. Artifacts that must move in lockstep

Derived from the repo, not guessed. Paths are repo-relative.

**Umbrella `packages/blocks` (every one of these is a PR-blocking gate):**
- `packages/blocks/src/index.ts` — L34 `auth-common` type re-export; L111-116 `bb-auth-basic`; L128-148 + L164
  `bb-auth-cognito`; L166-170 + L188-197 `bb-auth-oidc`; plus TSDoc catalog prose at L25-31, L99-108, L150-162, L182-185.
- `packages/blocks/src/index.cdk.ts` — L57, L84-89, L91-108, L109-120.
- `packages/blocks/src/ui.ts` — the whole 5-line file (`./ui` subpath).
- `packages/blocks/src/index.browser.ts` — currently exports **no** auth symbols; decide whether to fix that asymmetry.
- `packages/blocks/src/sdk-identifiers.ts` — L21-22 imports, L57-58 typed overloads.
- `packages/blocks/package.json` — deps L80-83; **`aws-blocks.vendorize` map L134-141**.
- `packages/blocks/tsconfig.json` — project refs L10-13.
- `packages/blocks/README.md` — decision rows L120-123; **catalog table rows L160/L164/L165/L166** (regenerate via
  `npm run sync-docs`; gated by `sync-docs:check` and `.github/workflows/block-catalog-check.yml`); samples L10, L67-105;
  guidance L230/237/243/257/258.
- `packages/blocks/API.md` — 36 `Auth*` lines (regenerate via `npm run update:api`).
- `packages/blocks/VPC-DESIGN.md` — L108-109 table rows, L115, L125, L176.
- `packages/blocks/src/conditional-exports.test.ts` — no auth literals (auto-discovers `packages/bb-*` with an
  `aws-runtime` condition), but the `bbPackages.length >= 8` floor at L77 drops by 2.
- `packages/blocks/src/vendorize-map.test.ts` — L55 special-cases `dep.endsWith('/auth-common')`.

**Root and build config:** `package.json` workspaces L12, L17-19 (and L57-58 for `test-apps/auth-cognito-passkeys`);
`tsconfig.json` refs L11-12 (note: `bb-auth-cognito`/`bb-auth-oidc` arrive only transitively — fix in P1b, see §1.10);
`packages/bb-auth-cognito/tsconfig.json` (missing `bb-app-setting` reference); `package-lock.json`.

**Compiler-invisible artifacts — these will not fail a build, so they need explicit checklist items:**
- `packages/bb-data/src/db-pull/templates.ts:181-215` — emits `import { AuthOIDC, google } from '@aws-blocks/bb-auth-oidc'`
  **as a string** inside a markdown fence; `packages/bb-data/src/db-pull/pull.ts:327` likewise; and
  `packages/bb-data/src/db-pull.test.ts:282-285` asserts `AuthOIDC` is used and `AuthCognito` is not — **this assertion
  inverts** under a Cognito-only merge.
- `test-apps/amplify-gen2/aws-blocks/cognito-verifier.ts:91` and `templates/amplify` — a structural `requireAuth` shim
  that never imports `BlocksAuth`.
- The three native OIDC protocol implementations (§1.9) — only their e2e suites can detect drift.
- `packages/auth-common/src/ui.ts`'s `data-testid` contract (landed as public API in PR #272) — every e2e selector in
  `test-apps/*`, `templates/*`, and the native demos depends on those exact strings.

**`packages/create-blocks-app`** — all 8 templates reference auth. There is **one shared** `resources/AGENTS.md`, not
per-template files:
- `packages/create-blocks-app/resources/AGENTS.md` — L33 `requireAuth`, L36-37 `Authenticator`, L41 AuthBasic behavior.
- `packages/create-blocks-app/src/index.ts:219` template display order; `src/cli.test.ts:36,53,400-402`.
- `templates/auth-cognito/aws-blocks/index.ts` (L1, L51, L114 + ~20 gates), `templates/auth-cognito/src/index.ts`,
  `templates/auth-cognito/aws-blocks/client.js`, `templates/auth-cognito/package.json`.
- `templates/default/{aws-blocks/index.ts,src/index.ts,aws-blocks/client.js,README.md,test/e2e.test.ts,package.json}`;
  same set for `templates/react` (`src/App.tsx`) and `templates/demo`.
- `templates/bare/aws-blocks/index.ts` (commented sample), `templates/nextjs/aws-blocks/index.ts:10-12`,
  `templates/backend/aws-blocks/index.ts:10-12`.
- `templates/amplify/aws-blocks/index.ts:23,29` and `templates/amplify/aws-blocks/cognito-verifier.ts:91` — a
  hand-rolled `requireAuth` shim that must stay contract-compatible.
- `packages/create-blocks-app/README.md:72-80`.

**`packages/hosting`** — **no auth references.** Nothing to change.
**`packages/foundations`** — private, unpublished stub; `README.md:13-45` documents an aspirational unified API with
`AuthBasic`/`AuthOIDC`/`AuthCognito` sections. Closest existing statement of a "unified" API; needs rewriting.

**`native/*`:**
- `native/codegen-fixtures/18-hybrid-arm/{spec.json,kotlin/AuthApi.kt,kotlin/Types.kt,swift/Api.swift,swift/Models.swift,dart/client.dart}`
  (the auth-common state machine **is** the hybrid-arm fixture);
  `native/codegen-fixtures/23-cognito-nested-unions/*`; `native/codegen-fixtures/20-multiple-namespaces/*`.
  Regenerate with `native/codegen-fixtures/regenerate-all.sh`.
- `native/swift/Tests/BlocksCodegenTests/{HybridArmTests.swift,SwiftCodeGeneratorTests.swift}`.
- `native/kotlin/example/typescript/{aws-blocks/index.ts,src/index.ts}`;
  `native/kotlin/e2e/src/commonTest/kotlin/com/aws/blocks/kotlin/e2e/AuthBasicE2ETest.kt` (+ `BlocksE2ETestCase.kt`);
  `native/kotlin/example/kmp/.../screens/AuthScreen.kt`; `native/kotlin/{AGENTS.md,README.md}`;
  **14-file OIDC runtime** under `native/kotlin/runtime/src/*/kotlin/com/aws/blocks/kotlin/oidc/`.
- `native/swift/Demo/typescript-demo/{aws-blocks/index.ts,src/index.ts}`;
  `native/swift/Tests/BlocksE2ETests/{AuthBasicE2ETests.swift,OIDCE2ETests.swift}` (+ `project.yml`, `project.pbxproj`,
  the xcscheme); `native/swift/Sources/BlocksRuntime/OIDC/{OIDCAuthState,OIDCClient,TokenStore}.swift`.
  **Pre-existing defect to fix while here:** `native/swift/Demo/typescript-demo/package.json:30` depends on
  `@aws-blocks/bb-auth-supabase@^0.3.34`, a package that does not exist in this repo (also referenced in a comment at
  `packages/auth-common/src/ui.ts:345`).
- `native/dart/example/bin/e2e/{auth_basic_test.dart,auth_cognito_test.dart,oidc_test.dart,harness.dart,todos_test.dart}`;
  `native/dart/run-e2e.sh:95`; `native/dart/packages/blocks_runtime/lib/src/{oidc_auth_state,oidc_client,oidc_exception,oidc_types,token_store}.dart`.

**`test-apps/*`:**
- `test-apps/comprehensive/aws-blocks/index.ts` — **8 auth instances**: `AuthBasic` at L121 (`'auth'`), L133
  (`'auth-same-origin'`), L136 (`'auth-cross-domain'`); `AuthCognito` at L145 (`'authC'`), L169 (`'authCMfa'`);
  `AuthOIDC` at L219 (`'oidc-auth'`), L229 (`'oidc-auth-extras'`), L255 (`'oidc-auth-relay'`). Plus
  `test-apps/comprehensive/package.json:26,30-32` (the only workspace with direct deps on all four),
  `src/index.ts:104-134`, `index.html:63-74`, and tests `basic-auth.test.ts`, `auth-cookie-attrs.test.ts`,
  `auth-cognito.test.ts`, `auth-cognito-sandbox.test.ts`, `auth-cognito-admin-sandbox.test.ts`, `oidc-auth.test.ts`,
  `poll-for-signin.ts`, `sandbox-admin-e2e.ts`, `e2e.test.ts:210-216`.
- `test-apps/auth-cognito-passkeys/` — `aws-blocks/index.ts:26`, `src/index.ts`, `index.html`, `aws-blocks/client.js`.
  **Note: no CI workflow runs it** and its `test` script is typecheck-only.
- `test-apps/native-bindings/aws-blocks/index.ts:12-14,36,40,60` (one of each block) + `src/index.ts`, `src/styles.css`,
  `aws-blocks/scripts/seed-cognito-user.ts`, `README.md:9-11,62`.
- `test-apps/vpc-smoke/aws-blocks/index.ts:17,58` — **the only app importing `@aws-blocks/bb-auth-cognito` directly**
  rather than via the umbrella.
- `test-apps/hosting-spa`, `hosting-ssr`, `hosting-ssr-nuxt`, `hosting-ssr-sveltekit` (`AuthBasic` / `authApi`);
  `test-apps/amplify-gen2/aws-blocks/{index.ts,cognito-verifier.ts}`; `test-apps/db-pull-typecheck/generated/index.ts:102,107`.

**`docs/`:** `docs/DECISIONS.md` — decision D naming L113-133 (**L133 already points at two non-existent files**),
form model L153-164, D-007 cookies L201-232, D-011 three-file docs L243-271; `docs/design/API-DESIGN.md:39,397,592,600`;
`docs/design/scaffold-new-bb.md:47` (Composite-BB archetype exemplar is `bb-auth-basic`);
`docs/guides/extending-with-existing-aws-resources.md:43,234`;
`docs/native-clients/schema-generation-guide-for-devs.md:187`;
`docs/tech-design/BB-auth-cognito-admin.md` and `BB-auth-cognito-admin-implementation-plan.md` (whole docs).
`docs/SUPABASE-E2E.md` has **no** Blocks-auth references — leave alone.

**Other coupled files:** `packages/core/src/api.ts:115-182`; `packages/core/src/hosting.ts:827,901`;
`packages/core/src/errors.ts:119`; `packages/core/src/common/index.ts:56,64,128` and `index.test.ts:57-150`;
`packages/core/src/lambda-handler.test.ts:1246`; `packages/core/src/scripts/extract-ts-types.ts` (+ test);
`packages/core/README.md:50-58,220,347-348`; `packages/core/src/redact.ts:22,38,53` + `redact.test.ts:105,118`;
`packages/bb-data/src/db-pull/templates.ts:161-197,324` and `db-pull/pull.ts:327` and `db-pull.test.ts:128-129,282-285`;
`packages/bb-app-setting/src/secrets-bulk.ts:10`; `packages/bb-kv-store/DESIGN.md:32` and
`packages/bb-kv-store/src/user-agent.test.ts:26-98`; `packages/bb-realtime/src/ws-server.test.ts:9`;
`scripts/generate-bb-names.mjs:29-33`; `packages/core/src/common/official-bb-names.generated.ts:13-15`;
`scripts/publish/test-local-registry.sh:33,55-65`; `scripts/agent-bench/README.md:88,92,95,337` and
`steps/lib/{analysis,overview}.test.mjs`; `.github/workflows/agent-bench.yml:86,90,93`;
`.github/ISSUE_TEMPLATE/bug-report.yaml:31-32`; `.gitignore:78`;
`tasks/{auth-notes,cognito-profile,oidc-dsql-notes}/{PROMPT.md,test.spec.ts}`; root `README.md:22,44`;
root `AGENTS.md:26,62,75-79,103,110,209`; each old package's `api-extractor.json` + `API.md`.
`test-infra/` has **no** auth references.

---

## 5. Phased delivery plan

Principles: every PR is independently reviewable and independently mergeable; `main` is green at every step; nothing
before P6 changes behavior for an existing user. Every phase's changeset must include `@aws-blocks/blocks` (see §2.3).

> **Contingency note.** P1, P2, P3, and P4a–P4d are deliberately independent of the open "does federated sign-in route
> through Cognito?" question (§1.11 item 11): they cover the test net, the shared contract, and the
> username/password + MFA + groups + passkeys surface, all of which are Cognito-native either way. **Only P5b is
> contingent.** If the answer turns out to be "federation does not route through Cognito", P5b is replaced by keeping
> `bb-auth-oidc` indefinitely, and nothing earlier needs rework.

### P1a — Resource-identity lock (the tripwire). **Do this first.**

- **Scope.** Add golden synth tests that pin the deployed identity of all three auth blocks, against *current* code.
  No source change.
- **Files.** New: `packages/bb-auth-cognito/src/resource-identity.cdk.test.ts` +
  `packages/bb-auth-cognito/src/__fixtures__/resource-identity.json`; equivalents in `packages/bb-auth-basic/src/` and
  `packages/bb-auth-oidc/src/`. Reuse the existing child-process probe pattern at
  `packages/bb-auth-cognito/src/index.cdk.test.ts:60-118` (`synthUnderCdkConditions`) so nested `KVStore`/`AppSetting`
  resolve under `--conditions=cdk`.
- **Tests it adds.** For `new AuthCognito(stack,'auth')`, assert the exact `{ logicalId, Type, physicalName }` tuple set
  for the pool, client, sessions table, SSM parameter, and each group; for `AuthBasic`, the `users`/`codes` tables and
  `jwt-secret`; for `AuthOIDC`, `<fullId>-federation`, sessions, and the cookie secret. Also assert the derived config
  keys and the cookie name.
- **Acceptance.** Passes at HEAD. A deliberate local mutation of any child construct id makes it fail with a diff that
  names the resource. Reviewer can verify the failure mode from the PR description.
- **Changeset.** `patch` for the three packages + `@aws-blocks/blocks` ("internal test coverage for deployed resource
  identity"). Needed because `changeset-guard verify-coverage` fires on any file change in a publishable package.
- **Defers.** Everything. No behavior, no API, no docs beyond the test's own comments.
- **Parallel.** Yes — independent of everything else.

### P1b — Close the CI blind spots. **Prerequisite, not cleanup.**

- **Scope.** Make CI capable of detecting what P4–P6 risk. Three independent fixes (§1.10), shippable as one PR or three.
- **Files.**
  - `packages/blocks/src/conditional-exports.test.ts` — make `assertSuperset` **bidirectional** (flag extra exports as
    well as missing ones), extend discovery to non-`bb-` auth packages (`auth-common`), and add the `cdk` and `browser`
    conditions per BB, not just `aws-runtime`. Expect it to **fail on landing** — `extractUserAttributes` and the
    umbrella's empty `index.browser.ts` are real gaps; fix or explicitly allowlist each with a comment.
  - Root `tsconfig.json` — add `packages/bb-auth-cognito` and `packages/bb-auth-oidc` explicitly;
    `packages/bb-auth-cognito/tsconfig.json` — add the missing `bb-app-setting` reference.
  - `packages/bb-auth-cognito/src/index.aws.test.ts` — add default-run (ungated) unit coverage for the pure//near-pure
    logic in `index.aws.ts`: session-record shaping, error mapping, attribute filtering, cookie parse/verify. Leave the
    `BLOCKS_INTEGRATION=1` suites as they are.
  - New: a legacy-cookie test per block that plants each of the three cookie shapes and asserts signed-out, not 500
    (§1.8).
- **Acceptance.** Every newly-added assertion is green *and* at least one previously-invisible gap is documented in the
  PR description. Reviewer can see what the old test could not catch.
- **Changeset.** `patch` for the touched packages + `@aws-blocks/blocks`.
- **Defers.** Any change to shipped behavior. If closing a parity gap requires a real export change, split that out.
- **Parallel.** Yes, with P1a.

### P2 — Reconcile the live PRs (three PRs + one decision)

Verified state (`gh pr view`, plus symbol checks against `main`): **five of the eight named refs need no work.**
`fix/authenticator-test-ids` merged as **#272**; `fix/cognito-prevent-user-enumeration` is patch-identical on `main`;
`fix/oidc-signin-shared-state`'s files are byte-identical on `main`; `fix/bb-auth-oidc-stub-idp-reserved-params` **has
landed** (`redirectUriRejectionReason` is on `main` in `bb-auth-oidc/src/engines/stub-idp.ts`); `supabase-auth-poc` has
no PR. Only three PRs are live, all OPEN: **#583**, **#208**, **#297** (draft). See §7.

- **P2a — decide the group-membership semantics, then land #583.** `bb-auth-cognito/DESIGN.md` Key Design Decision #3
  states group membership comes from the `cognito:groups` claim *by design* ("no extra Cognito API call per request;
  group changes take effect at the next sign-in"). #583 does the opposite via a paginated `AdminListGroupsForUser`.
  **These cannot both stand.** Resolve first — revocation latency vs a Cognito API call on every authorization check —
  then land #583 *with* the DESIGN.md decision rewritten, or close it with the rationale recorded. Touches
  `bb-auth-cognito/src/{index.aws.ts,index.ts,index.cdk.ts,index.cdk.test.ts,admin.test.ts}`, `DESIGN.md`, `README.md`,
  `test-apps/comprehensive/{aws-blocks/index.ts,test/auth-cognito-admin-sandbox.test.ts}`.
  **Needs sandbox e2e** (IAM + live revocation). Changeset already on the branch. 1 commit behind `main`.
- **P2b — land #208** (`submitAuthAction` in `auth-common/src/ui.ts`). 144 commits behind with 7 merge-main commits in
  its history; one ugly rebase now versus re-deriving it by hand later. **Land it or explicitly convert it into a written
  requirement on the unified block** — do not plan to rebase it after P4.
- **P2c — decide #297** (`feat/bb-auth-jwt`, draft, `AuthBearerJwt`). Either land it before P4 and unify four blocks, or
  hold it and implement it once against the unified contract. Do not leave it open across P4–P6.
- **Also in flight, auth-adjacent, not in the original list — triage both:** **#575** `fix/db-pull-oidc-client-id`
  (touches `bb-data`'s string-emitted `AuthOIDC` guide — the exact compiler-invisible surface in §1.9; land before P7d so
  P7d rewrites the corrected version) and **#588** `mattcreaser/kotlin-oidc-ios-jvm` (draft; extends the native Kotlin
  OIDC runtime to iOS/JVM — **directly contingent** on §1.11 item 11; do not merge it until that decision is made, or it
  becomes sunk cost).
- **Closures (no PR).** Close/delete the five stale refs above.
- **Acceptance.** Full CI green on each. **Defers.** Any unification work.
- **Parallel.** P2a/P2b/P2c are mutually independent and independent of P1.

### P3 — Canonical contract in `auth-common` (additive, no block changes)

- **Scope.** Publish the canonical error-name table and fix the contract that is already violated. Add
  `AuthErrors` (canonical names) + a documented old→new alias map + `isAuthError()` guard helpers. Correct the
  `BlocksAuth.requireAuth` JSDoc, which promises `SessionExpiredException` but only `AuthBasic` throws it.
- **Files.** `packages/auth-common/src/index.ts`, new `packages/auth-common/src/errors.ts`, `packages/auth-common/API.md`,
  `packages/auth-common/{README,DESIGN}.md`, `packages/blocks/src/{index.ts,index.cdk.ts}`, `packages/blocks/API.md`.
- **Tests.** A table-driven unit test enumerating **every** current error name across all three blocks and asserting its
  canonical mapping — this is the artifact that makes §1.5's silent break reviewable.
- **Acceptance.** `check:api` clean; no existing name removed; nothing renamed yet.
- **Changeset.** `minor` for `auth-common` + `@aws-blocks/blocks`. **Defers.** Any block adopting the new names.
- **Parallel.** After P2b (both touch `auth-common`).

### P4 — New `packages/bb-auth`, additive (four PRs)

Old blocks are untouched and still shipped. **This is where the §1.11 sign-off must already be in hand, and P1a/P1b must
already have landed.**

- **P4a — package + CDK layer.** New package skeleton (`package.json` with the full conditional-export map,
  `tsconfig.json`, `api-extractor.json`, `README.md`, `DESIGN.md`, `src/version.ts` prebuild, `src/types.ts` types-only,
  `src/errors.ts`, `src/index.cdk.ts`). The CDK layer is a re-implementation of `AuthCognito`'s that synthesizes
  **byte-identically**: same child ids (`pool`, `client`, `sessions`, `session-secret`, `group-<name>`), same
  `userPoolName: this.fullId`, same `registerConfig` keys, `synthGuard` stubs for every runtime method. Adds the
  unset-`removalPolicy` synth warning **and synth-time guards for the four service-immutable properties** (sign-in/alias
  attributes, `CaseSensitive`, required attributes, existing custom attributes) so a config change fails at synth instead
  of as a CloudFormation rollback (V4, §1.1) — extend the existing `signInWith` guard pattern. Treats
  `webAuthnRelyingParty.id` as immutable. Registration: root `package.json` workspaces, root `tsconfig.json`,
  `packages/blocks/{package.json (deps + vendorize),tsconfig.json,src/index.ts,src/index.cdk.ts}`,
  `packages/core/src/common/official-bb-names.generated.ts` (regenerated).
  **Acceptance: the P1a golden fixture for `AuthCognito` also passes for `new Auth(stack,'auth')`, unchanged**, and the
  Layer 2 immutability-guard tests (§6.3) are green. Those two assertions are the whole non-destructiveness proof at
  synth level.
- **P4b — mock layer** (`src/index.mock.ts`): `registerSdkIdentifiers`, `.bb-data` persistence, tolerant loading of an
  unreadable/foreign state file (start fresh + log, never throw).
- **P4c — AWS runtime** (`src/index.aws.ts`): real SDK client, `getSdkIdentifiers(this)` **at call time**.
  **Needs a real sandbox e2e** — this is the serialization-bearing layer.
- **P4d — browser + UI** (`src/index.browser.ts`, `src/ui.ts`, `packages/blocks/src/ui.ts`, `packages/blocks/src/index.browser.ts`).
- **Tests across P4.** `conditional-exports.test.ts` parity (auto-discovered, plus check the `>= 8` floor at L77);
  `parity.test.ts` (mock↔aws); `index.cdk.test.ts` ported; the resource-identity golden; a new instance in
  `test-apps/comprehensive` with **zero type casts**.
- **Changeset.** `minor` for `@aws-blocks/bb-auth` (initial) + `@aws-blocks/blocks`.
- **Defers.** Deprecating anything; migrating any consumer; federated/OIDC capability (P5).
- **Parallel.** P4b/P4c/P4d can proceed in parallel once P4a's types land.

### P5 — Migration affordances (two independent PRs)

- **P5a — AuthBasic credential migration.** A Cognito `UserMigration` Lambda trigger plus a `migrateFrom` option that
  points at the legacy `<fullId>-users` KVStore, bcrypt-compares on first `USER_PASSWORD_AUTH` sign-in, and creates the
  Cognito user just-in-time. **This is the precondition for ever removing `bb-auth-basic`.**
  **Needs a real sandbox e2e** — a mock cannot prove a Cognito trigger fires.
- **P5b — federated providers on the unified block. CONTINGENT — do not start until §1.11 item 11 is decided.**
  Absorb `bb-auth-oidc`'s `cognitoFederated` engine as a `federatedProviders` option. Forward-looking capability,
  **not** a migration mandate for existing OIDC users. Open costs that make this a genuine decision rather than a task:
  federation **requires a `UserPoolDomain`** (a new public endpoint whose `Domain` change is replacement-causing, V5);
  there is no PKCE toward the upstream IdP; federation is **not mockable locally**, so it can only be tested against real
  AWS; and there is a per-MAU cost cliff. It must also document that the pool name differs from `<fullId>-federation` and
  that `userId` changes (§1.1). **If the decision is "federation does not route through Cognito", P5b is replaced by
  keeping `bb-auth-oidc` indefinitely** and nothing in P1–P4 needs rework.
- **Parallel.** P5a is unconditional and can start immediately after P4c. P5b is gated on the decision.

### P6 — Deprecation (three PRs; **the first announced break**)

- **P6a** — `bb-auth-cognito` becomes a thin re-export shim of `@aws-blocks/bb-auth`, keeping its full export map
  (including `./ui`), with `@deprecated` JSDoc and a dev-only one-time console warning.
  **Acceptance: the P1a golden fixture is byte-identical before and after.** Plus the upgrade-in-place job (§6.3).
- **P6b** — `bb-auth-basic` and `bb-auth-oidc`: `@deprecated` JSDoc + `MIGRATION.md` per package. **No code change, no
  re-export.** Their CI must stay green, proving "frozen but functional".
- **P6c** — the codemod (`scripts/codemod/auth-unify.ts` + a `migrate-auth` entry point) with fixture tests, including
  an assertion that it **never** rewrites the `id` argument.
- **Changeset.** `minor` for all three + `@aws-blocks/blocks`; changelog text is the public deprecation notice.
- **Defers.** Removal (P8) and `npm deprecate` timing.

### P7 — Repo-wide consumer migration (four parallel PRs)

- **P7a** — `test-apps/comprehensive` (8 instances, 7 test files, `index.html`, `src/index.ts`, `package.json`) plus
  `test-apps/{vpc-smoke,native-bindings,auth-cognito-passkeys,hosting-*}`. Keep old-block instances alongside new ones
  until P8 so both paths stay covered.
- **P7b** — `packages/create-blocks-app`: `templates/auth-cognito` first (pure rename), then
  `default`/`react`/`demo`/`bare`, plus `resources/AGENTS.md`, `src/index.ts:219`, `src/cli.test.ts`.
  **Flag for maintainers:** `templates/default` uses `AuthBasic` specifically because it needs no AWS account; moving
  the default scaffold to Cognito is a product decision, not a refactor detail.
- **P7c** — `native/*`: `codegen-fixtures` (regenerate), Kotlin/Swift/Dart examples and e2e suites. Also fix the phantom
  `@aws-blocks/bb-auth-supabase` dependency. The native OIDC runtimes stay, since `bb-auth-oidc` stays.
- **P7d** — docs: `docs/DECISIONS.md` (amend decision D; fix its two dangling links),
  `docs/design/{API-DESIGN.md,scaffold-new-bb.md}`, `docs/guides/extending-with-existing-aws-resources.md`,
  `docs/native-clients/schema-generation-guide-for-devs.md`, `packages/blocks/README.md` (+ `npm run sync-docs`),
  `packages/foundations/README.md`, root `README.md` and `AGENTS.md`, `packages/core/README.md`, and this folder's
  `01`–`04`. Also `packages/bb-data/src/db-pull/templates.ts` + the inverted assertion at `db-pull.test.ts:282-285`,
  `.github/ISSUE_TEMPLATE/bug-report.yaml`, `scripts/agent-bench` + `tasks/*`.
  **Acceptance: every snippet, command, package name, and relative link verified at HEAD** (`AGENTS.md` rule 11).
- **Parallel.** All four, after P4 lands.

### P8 — Removal. Out of scope for this plan.

Gated on: two minors elapsed, P5a validated on real AWS, and adoption evidence. Requires its own sign-off.

---

## 6. Test strategy

### 6.0 Prerequisite: the net has holes where we are about to cut

Before any phase restructures auth code, P1b must close the three gaps in §1.10 — a one-directional
`conditional-exports` check that cannot see extra exports or the `cdk`/`browser` conditions or `auth-common`; a root
`tsconfig.json` that reaches the two largest auth packages only transitively; and a 2465-line `index.aws.ts` whose
default-run test coverage is six tests of one pure function. **Treat "CI is green" as meaningless for the AWS layer until
P1b lands.** Everything in §6.1 assumes P1a/P1b are in place.

### 6.1 What must be proven, per phase

| Phase | Unit | Parity (mock↔aws) | CDK synth (`--conditions=cdk`) | e2e local | **Sandbox e2e** |
|---|---|---|---|---|---|
| P1a | — | — | **required** (the golden itself) | — | no |
| P1b | **required** (new AWS-layer + legacy-cookie tests) | — | — | yes | no |
| P2a | yes | yes (mock mirrors live groups) | yes (IAM grant) | yes | **required** (live group revocation + IAM) |
| P2b | yes (`ui.test.ts`) | — | — | yes | no |
| P2c | yes | — | — | yes | no |
| P3 | yes (name-mapping table) | — | — | — | no |
| P4a | yes | — | **required** (golden must match `AuthCognito` byte-for-byte) | — | no |
| P4b | yes | — | — | yes | no |
| P4c | yes | **required** | yes | yes | **required** (every serialization path) |
| P4d | yes | — | — | yes | no |
| P5a | yes | n/a (trigger cannot be mocked) | yes | partial | **required** (the trigger must actually fire) |
| P5b | yes | n/a (**federation is not mockable locally**) | yes | no | **required, and it is the only signal** |
| P6a | yes | yes | **required** (golden identical pre/post) | yes | **required** + upgrade-in-place (§6.3) |
| P6b | yes (unchanged suites stay green) | — | — | yes | no |
| P6c | yes (codemod fixtures) | — | — | — | no |
| P7a | — | — | yes | **required** | **required** (comprehensive already runs sandbox in CI) |
| P7b | yes (`cli.test.ts`) | — | — | `npm run test:templates` | no |
| P7c | yes | — | — | native e2e suites | no |
| P7d | — | — | — | — | no (but `sync-docs:check` + link verification) |

Per `AGENTS.md` ("serialization/behavior changes need a real sandbox e2e"), the phases that **must** have a real
sandbox e2e are: **P2a, P4c, P5a, P5b, P6a, P7a.** Everything else is mock/doc-level. Helpfully,
`.github/workflows/pr-checks.yml` already runs `e2e-sandbox`, `e2e-production`, and `e2e-templates` on every
source-changing PR, so the work is adding the right assertions, not building infrastructure.

### 6.2 Existing gates each PR must clear

`npm run lint`, `npm run lint:deps`, `npm run build`, `npm run check:exports-consistency`, `npm run check:api`,
`npm run test:unit`, `npm run test:e2e:local` (which also runs `test:vendorize`), `npm run publish:local`, plus the
`e2e-templates` / `e2e-sandbox` / `e2e-sandbox-vpc` / `e2e-production` / `e2e-hosting` / `e2e-telemetry` jobs, the
`changeset-check` guards (`verify-coverage`, `block-major`, `validate-structure`, **`verify-umbrella`**), and
`block-catalog-check`.

### 6.3 Proving the existing deployment survives

The failure modes are **not** the same shape, so the verification has to test for two different things:
a **logical-ID change** (which destroys users, and which CloudFormation will happily execute) and a
**service-level rejection** on an otherwise-valid update (which fails the deploy and rolls back). `cdk diff` catches the
first and is **blind to the second** — it reports "No interruption" for exactly the four properties Cognito will refuse.

**Layer 1 — synth-level golden (every PR, zero AWS cost). The primary gate.** The P1a fixture pins
`{ logicalId, Type, physicalName }` for every resource each block owns, under `--conditions=cdk`. A renamed child id, an
added nesting level, or a changed `userPoolName` fails CI with a named diff. Catches V1, V2, V3 deterministically.
Reviewer contract: **"the golden fixture is unchanged" is the sign-off for non-destructiveness**; any PR that *does*
change it must justify it and carry the Layer 4 runbook.

**Layer 2 — synth-level immutability guard tests (every PR, zero AWS cost). The one `cdk diff` cannot give us.**
Because CloudFormation mislabels them, the only place to catch V4 is our own synth. Add tests asserting the unified block
**throws at synth** when a construct would change `signInWith`/alias attributes, `UsernameConfiguration.CaseSensitive`,
the required-attribute set, or an existing custom attribute on a pool it did not create fresh. Pair each with a test that
the *permitted* changes (password policy, MFA config, token validities, callback URLs, `SupportedIdentityProviders`) do
**not** throw — otherwise the guard becomes a false-positive generator. This is a P4a deliverable.

**Layer 3 — real upgrade-in-place e2e (label-gated; run on P4a and P6a, and before release).** New script
`test-apps/comprehensive/test/upgrade-in-place.ts` driving `deploy`/`destroy` from `@aws-blocks/blocks/scripts` (the same
primitives `test/production-deploy.ts` uses), pinned to one stack via `BLOCKS_STACK_SUFFIX`:

1. `BLOCKS_STACK_SUFFIX=upgrade-<run-id>`; check out the **pre-refactor** revision in a `git worktree`, build, `deploy()`.
2. Seed and record: create a user via the admin surface, set a password, sign in, capture `userPoolId`, `userSub`, the
   sessions table name, and the SSM parameter name.
3. Switch the worktree to the **PR revision**, rebuild, and run `cdk diff` against the *live* stack.
   Assert no replacement marker for `AWS::Cognito::UserPool` **and** none for `AWS::Cognito::UserPoolClient` or
   `AWS::Cognito::UserPoolDomain` (the resources that genuinely do replace — V5). Cheap, one deploy, high signal for V1–V3.
4. `deploy()` again with the **same** `BLOCKS_STACK_SUFFIX` and no intervening `destroy()`.
   **This is the step that catches V4, and the assertion is about the deploy itself:** the second `deploy()` must
   **succeed**, and the stack must end in `UPDATE_COMPLETE` — not `UPDATE_ROLLBACK_COMPLETE`. Treat any rollback as a
   hard failure and surface the `UpdateUserPool` error message, because that is the signal `cdk diff` withheld.
5. Assert: `userPoolId` byte-identical; the seeded user still exists and can still sign in; sessions table name and SSM
   parameter name unchanged; and a pre-upgrade session cookie is either still valid or cleanly rejected as signed-out —
   **never a 500** (§1.8).
6. `destroy()` in a `finally`. Per the repo's sandbox rule, never leave a stack running.

Run it via tmux + polling (each deploy is 2–3 minutes), never as a blocking foreground command. Note the CI production
job uses an ephemeral per-PR `BLOCKS_STACK_SUFFIX` (`pr-<num>-<attempt>`), so there is **no long-lived stack to upgrade
into** — this two-deploy script is the only way to exercise the upgrade path, and it has to be written.

**Layer 4 — a written CFN-import runbook** for the case where a future change genuinely must move a pool
(`removalPolicy: 'retain'` + `DeletionProtection: ACTIVE`, `cdk import`, verify, re-point). Write it once in `bb-auth`'s
`DESIGN.md`, so the answer to "we need to rename a child construct id" is a procedure rather than an outage.

---

## 7. Reconciliation with in-flight branches

All eight named refs exist **only** as `origin/` refs; there are no local copies. `refactor/auth-blocks` (the current
branch) has **zero commits ahead of `main`**, so the refactor has not started and every "painful to rebase" call below is
prospective. `main` tip: `bbd2c13d`.

**The original branch list was partly stale. Verified state — five of the eight need no work:**

| Ref | Verified state | Evidence |
|---|---|---|
| `fix/authenticator-test-ids` | **MERGED as PR #272** | `gh pr view 272` → `MERGED`; `auth-common/src/{ui.ts,ui.test.ts}` + `CUSTOMIZING-AUTH-UI.md` byte-identical to `main` |
| `fix/cognito-prevent-user-enumeration` | **Merged** | `git cherry main <ref>` → 0 `+` commits (patch-identical); `preventUserExistenceErrors: true` at `bb-auth-cognito/src/index.cdk.ts:247`, test at `index.cdk.test.ts:208` |
| `fix/oidc-signin-shared-state` | **Merged** | `test-apps/comprehensive/test/{poll-for-signin.ts,oidc-auth.test.ts}` byte-identical on `main`; touched no `packages/` source |
| `fix/bb-auth-oidc-stub-idp-reserved-params` | **Merged** (corrects an earlier read) | `git grep redirectUriRejectionReason main` → 3 hits in `bb-auth-oidc/src/engines/stub-idp.ts`. The stale 3-dot diff also carried an unrelated `bb-async-job` commit; both are moot. |
| `supabase-auth-poc` | **No PR — a spike** | 149 commits behind, unplumbed (no umbrella export, no vendorize entry, no API report, no changeset, no test app), stale pinned deps, and functionally redundant with #297. **Abandon**; keep only as a design reference. Landing it would add a *fifth* auth block to unify for zero coverage gain. |

**Three live PRs, all OPEN:**

| PR | Ref | Behind `main` | Verdict | Why |
|---|---|---|---|---|
| **#583** | `fix/auth-cognito-requirerole-live-groups` | **1 commit** | **Resolve the design conflict, then land before (P2a)** | `requireRole` today trusts the token's `cognito:groups` claim, so an admin `removeUserFromGroup` does not revoke until the token refreshes; the PR adds a paginated `AdminListGroupsForUser`. **But `bb-auth-cognito/DESIGN.md` Key Design Decision #3 states the claim-based read is deliberate** — "no extra Cognito API call per request; group changes take effect at the next sign-in… the same behavior Cognito exhibits for any client reading the token." **One of the two is wrong.** This is not a rebase question, it is a semantics question the unified block must answer once: revocation latency versus a Cognito API call on every authorization check. Cheapest to settle now (1 commit behind, `AdminListGroupsForUserCommand` is already imported at `index.aws.ts:25`); deferred, it becomes a ~40-line hand-port *plus* the same unresolved decision. Sits in the Cognito hot zone (`index.aws.ts`, `index.ts`, `index.cdk.ts`) but is small and self-contained. |
| **#208** | `fix/auth-reactivity-185` | **144 commits** | **Land before (P2b), or abandon-as-spec** | **The most painful rebase of the set.** Inserts `submitAuthAction` into the middle of `auth-common/src/ui.ts` **and** changes control flow inside `Authenticator`, `renderState`, and `renderInternalAction` (including removing `return`s after the retriable branch), plus touches `packages/blocks/src/ui.ts`. Confirmed not on `main` (`git grep submitAuthAction main -- packages/` is empty). `ui.ts` is exactly the file unification rewrites; every hunk would conflict and none auto-resolve. Its own history is noisy (7 merge-main commits + 1 no-op) and `main`'s `ui.ts` has moved three times since. **Never plan to rebase this after P4** — land it, or convert it into a written requirement and close it. |
| **#297** | `feat/bb-auth-jwt` (**draft**) | 19 commits | **Decide explicitly before P4a** | Review-complete (API report, changeset, telemetry, comprehensive e2e), 1541 insertions, pure addition. Confirmed not on `main`. **Low file-level conflict, high scope conflict:** it adds a *fourth* auth block (`AuthBearerJwt`), so landing it after unification means writing it twice. Its only conflict surface is the three shared registration points (`packages/blocks/src/index.ts`, the `vendorize` map, `official-bb-names.generated.ts`) plus `packages/blocks/API.md` — textually guaranteed to conflict, trivially re-appliable. **Maintainer call:** land before P4 and unify four blocks, or hold and implement once against the unified contract. Do not leave it open across P4–P6. |

**Two further in-flight PRs, auth-adjacent, not in the original list — both need triage:**

| PR | Ref | Why it matters here |
|---|---|---|
| **#575** | `fix/db-pull-oidc-client-id` | Touches `bb-data`'s db-pull OIDC guide — the **string-emitted `AuthOIDC` imports** at `db-pull/templates.ts:181-215` that no compiler checks (§1.9), and the assertion at `db-pull.test.ts:282-285` that inverts under a Cognito-only merge. **Land before P7d** so P7d rewrites the corrected version rather than conflicting with it. |
| **#588** | `mattcreaser/kotlin-oidc-ios-jvm` (**draft**) | Extends the native **Kotlin OIDC runtime** to iOS and JVM targets. **Directly contingent on §1.11 item 11** (does federation route through Cognito, and does `bb-auth-oidc` survive). Do not merge until that decision is made, or it becomes sunk cost in a protocol we may be replacing. Conversely, if `bb-auth-oidc` stays frozen-but-functional as recommended, this is safe to land. |

**Immediate actions worth taking regardless:** close the five stale refs (taking the decision set from eight to three),
settle the DESIGN.md #3 versus #583 conflict, and get a decision on #297 before P4a starts.

---

## 8. Risk register

Ranked by expected cost.

| # | Risk | Mitigation | Early warning signal |
|---|---|---|---|
| **R1** | **A changed logical ID orphans the pool and CFN deletes it — every user destroyed** (V1–V3, §1.1), amplified by the `removalPolicy: DESTROY` default. Note this is *not* CFN "replacement": no user-pool property causes that. | Frozen construct-id contract; P1a golden fixture as a CI gate; upgrade-in-place job on P4a/P6a; guide leads with `removalPolicy: 'retain'`; propose `DeletionProtection: ACTIVE`; synth warning when `removalPolicy` is unset; written CFN-import runbook | The P1a golden fixture changes in a diff; `cdk diff` shows the pool being created *and* destroyed; **any PR that edits a string literal passed as a child construct id** — make this an explicit review checklist item |
| **R1b** | **Rollback-on-update** (V4): the block changes a property Cognito refuses (`signInWith`/alias attributes, `CaseSensitive`, required attributes, an existing custom attribute) while CFN documents it "No interruption" → failed stack update. **The likely everyday failure**, and `cdk diff` is blind to it | Synth-time immutability guards in P4a (Layer 2, §6.3), paired with tests that permitted changes still pass; upgrade-in-place asserts the second deploy reaches `UPDATE_COMPLETE`, not `UPDATE_ROLLBACK_COMPLETE` | A sandbox stack in `UPDATE_ROLLBACK_COMPLETE`; an `UpdateUserPool` `InvalidParameterException` in deploy logs; a green `cdk diff` followed by a failed `deploy` |
| **R1c** | **Genuine replacement of the client or domain** (V5): `UserPoolClient.GenerateSecret` or `UserPoolDomain.Domain` change ⇒ new client ID / recreated domain ⇒ all sessions dead, passkey RP ID may shift. Reachable as soon as federation adds a domain | Never expose `generateSecret` as an option; treat the domain prefix as immutable in the BB API; upgrade-in-place step 3 asserts no replacement on `UserPoolClient` or `UserPoolDomain` too | `cdk diff` flags replacement on either resource type; passkey prompts failing after a deploy |
| **R2** | **AuthBasic bcrypt credentials cannot move to Cognito** — users locked out | P5a `UserMigration` trigger shipped and sandbox-validated *before* any removal; otherwise a documented forced-reset campaign; `bb-auth-basic` stays functional (never a re-export shim) | P5a's sandbox e2e cannot sign in a migrated user; any proposal to alias `AuthBasic` onto the unified block |
| **R3** | **Silent error-name breakage** — `hasAuthError` takes a `string`, so renames produce no compile error | P3's canonical table + alias map + exhaustive mapping test; codemod flags every `hasAuthError`/`isBlocksError` call site as manual review | e2e assertions on `AuthState.errorName` failing; client code branching on a name that no longer occurs |
| **R4** | **`OIDCUser.userId` (`${iss}:${sub}`) → Cognito `sub`** dangles customer foreign keys, with no automated fix | Keep `bb-auth-oidc` frozen; do not mandate OIDC migration this cycle; if absorbed, preserve the old `userId` via an attribute mapping and document the re-keying recipe | `test-apps/comprehensive`'s `profile:${user.userId}` reads returning `null` after a switch |
| **R5** | **Mass logout** from a rotated session HMAC or renamed sessions table | Preserve `fullId` ⇒ preserve the SSM parameter and table names; require the unparseable-cookie path to return signed-out, never 500; test with a planted stale cookie | Upgrade-in-place step 5 failing; a 500 on a request carrying an old cookie |
| **R6** | **Scope creep / a long-lived refactor branch** that can never be merged | Phase gating; every PR independently mergeable; old blocks untouched through P5; `refactor/auth-blocks` currently at zero commits — keep it that way and work in per-phase branches | A phase branch older than two weeks or larger than ~1500 changed lines; `main` red for more than a day |
| **R7** | **Publish integrity failure** (`EINTEGRITY`) from an umbrella/changeset mismatch | Every changeset includes `@aws-blocks/blocks`; rely on `changeset-guard verify-umbrella`; run `npm run publish:local` per PR (CI already does) | `verify-umbrella` or `verify-coverage` failing; `changeset version` leaving the umbrella un-bumped |
| **R8** | **Native clients stranded** — ~40 Kotlin/Swift/Dart OIDC runtime files plus 3 codegen fixture sets | `bb-auth-oidc` frozen, not removed, so the native OIDC runtimes keep working; regenerate fixtures via `native/codegen-fixtures/regenerate-all.sh` in P7c | `native-sdk-e2e` / `native-sdk-swift` / `native-dart-analysis` workflows failing; a fixture diff nobody can explain |
| **R9** | **Mechanical gate surprises** — `conditional-exports.test.ts`'s `>= 8` floor, auto-discovery, `check:exports-consistency`, `sync-docs:check`, `block-catalog-check`, `official-bb-names.generated.ts` | Address each explicitly in P4a rather than reactively; regenerate all generated artifacts in the same PR that changes their source | Any of those jobs failing on a PR that "only" added a package |
| **R10** | **Doc drift and dead links** (`AGENTS.md` rule 11 — a dead link in a published README is a defect) | P7d verifies every snippet, command, package name, and relative link at HEAD; fix the two pre-existing dangling links at `docs/DECISIONS.md:133` and the phantom `bb-auth-supabase` dependency while we are here | `block-catalog-check` failing; a README snippet referencing a removed export |
| **R11** | **Default-template product change** — moving `templates/default` off `AuthBasic` makes the zero-AWS-account scaffold require Cognito | Raise as an explicit maintainer decision in P7b; consider keeping a Cognito-free default | Reviewers surprised by a template change in what looked like a refactor PR |
| **R12** | **We restructure the AWS layer with no safety net** — `index.aws.ts` is 2465 lines with 6 default-run tests, and `conditional-exports.test.ts` cannot see extra exports, the `cdk`/`browser` conditions, or `auth-common` (§1.10). A parity regression ships green. | **P1b is a hard prerequisite**, not cleanup: bidirectional export-parity checks, explicit root `tsconfig.json` references, and default-run coverage for the AWS layer *before* P4c touches it | A P4c PR that changes `index.aws.ts` substantially and turns CI green on the first try; any parity gap discovered manually rather than by a test |
| **R13** | **Forced logout of the entire user base at cutover** — Basic and the unified block share the cookie name `auth_<fullId>` with incompatible payloads (§1.8), on top of the forced credential migration | Decide reject-and-clear vs recognize-and-upgrade explicitly (§1.11 item 9); if upgrading, sequence it after P5a and time-box it behind an opt-in with a documented sunset; P1b adds legacy-cookie tests | A 500 (not a 401) on a request carrying a legacy cookie; support reports of "signed out after upgrading" |
| **R14** | **Sunk cost in a protocol we may replace** — #588 extends the native Kotlin OIDC runtime while "does federation route through Cognito?" is still open | Settle §1.11 item 11 before merging #588; keep `bb-auth-oidc` frozen-but-functional so the native runtimes stay valid either way | #588 approved before the federation decision is recorded; new native OIDC work starting in P7c |
