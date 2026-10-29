# Auth Unification — 01: Inventory of the Existing Auth Surface

> **Status:** planning artifact. Read-only survey of `refactor/auth-blocks` @ HEAD (identical to `main` at
> `bbd2c13d`). No source file was modified to produce this document.
>
> **Purpose:** establish the complete, citable baseline of the auth surface before any unification work.
> Every claim carries a `file:line`. Where a claim comes from a generated API report (`API.md`) it is
> marked as such — those are the authoritative public surfaces per `AGENTS.md`.

---

## 0. Executive shape of the problem

Four packages own "auth" today. They do **not** share a layering model, an error vocabulary, a session
model, a conditional-export shape, or a `createApi()` contract:

| Package | Version | Layers present | Own infra | Session model |
|---|---|---|---|---|
| `@aws-blocks/auth-common` | 0.1.8 | none (single `index.ts` + `ui.ts` + `cookies.ts`) | none | n/a (types + DOM UI + cookie policy) |
| `@aws-blocks/bb-auth-basic` | 0.1.9 | `index.ts` + `index.browser.ts` only — **no `cdk`, no `aws-runtime`** | composed (KVStore ×2 + AppSetting) | **stateless self-signed JWT** in cookie |
| `@aws-blocks/bb-auth-cognito` | 0.1.10 | `index.ts` (mock) / `index.aws.ts` / `index.cdk.ts` / `index.browser.ts` + `./ui` | Cognito User Pool + Client, nested KVStore | **server-side session record**, opaque HMAC-signed session id in cookie |
| `@aws-blocks/bb-auth-oidc` | 0.2.0 | `index.mock.ts` / `index.aws.ts` / `index.cdk.ts` / `index.browser.ts` + `./middleware` + `./client` | KVStore sessions + SSM secret + (optional) Cognito pool for federation | **server-side session row**, signed cookie envelope `{mode:'stateful', sessionId, provider, exp}` |

The only genuinely shared contract is the 3-method `BlocksAuth` interface
(`packages/auth-common/src/index.ts:40-66`) and the `AuthState`/`AuthAction`/`AuthField` state-machine
wire types. Everything above that line diverges.

---

## 1. Per-package inventory

### 1.1 `packages/auth-common` — `@aws-blocks/auth-common` v0.1.8

**`package.json`** (`packages/auth-common/package.json`)

- `"type": "module"`, license Apache-2.0.
- `files[]` (L21-28): `dist`, `README.md`, **`CUSTOMIZING-AUTH-UI.md`**, `DESIGN.md`, `src`, `LICENSE`.
  (Ships `src` — the only auth package besides `bb-auth-basic`/`bb-auth-oidc` that does; `bb-auth-cognito`
  does **not**, L23-28 of its package.json.)
- `exports` (L29-42) — **no conditional (`browser`/`cdk`/`aws-runtime`) keys at all**, three flat subpaths:
  - `.` → `dist/index.js` (+ `.d.ts`)
  - `./ui` → `dist/ui.js` (DOM-dependent; imports `document`, `BroadcastChannel`)
  - `./cookies` → `dist/cookies.js`
- `scripts` (L43-46): `build: tsc --build`, `test: node --test dist/**/*.test.js`. **No `prebuild`
  version script** — it is not a BB, so it has no `version.ts`/`BB_NAME`.
- `dependencies` (L47-49): only `@aws-blocks/core ^0.5.0`.
- `devDependencies` (L50-54): `@types/node`, **`happy-dom ^20.8.9`** (DOM harness for `ui.test.ts`), `typescript`.
- `peerDependencies` (L55-58): `aws-cdk-lib ^2.257.0`, `constructs ^10.6.0` — declared even though the
  package never imports CDK (inherited boilerplate; a cleanup candidate).

**`src/` layout**

| File | Lines | Role |
|---|---|---|
| `src/index.ts` | 191 | `AuthUser`, `BlocksAuth`, `AuthField`, `AuthAction`, `AuthState`; re-exports 3 types from `ui.ts` |
| `src/ui.ts` | 1114 | `AuthActionPayloadMap`, `AuthActionInput`, `AuthStateApi`, `broadcastAuthChange`, `onAuthChange`, `AuthenticatedContent`, `Authenticator`, `AccountMenuBar`, override types |
| `src/cookies.ts` | 134 | `resolveCookieSecurity`, `buildCookieSecurityAttrs`, `isLoopbackRequest`, `CookieSecurityInput`, `CookieSecurityAttributes` |
| `src/cookies.test.ts` | 134 | unit |
| `src/ui.test.ts` | 925 | unit (happy-dom) |
| `src/ui.types-test.ts` | 64 | types-only |

**No Scope subclass.** `auth-common` exports zero classes and zero `Scope` subclasses — it is a
pure types + browser-UI + cookie-policy library. This is why it has no conditional exports.

**Public API (authoritative: `packages/auth-common/API.md`)**

Interfaces/types (all `@public`):
- `AuthUser { userId: string; username: string }` — API.md:139-142
- `BlocksAuth { requireAuth(ctx): Promise<AuthUser>; checkAuth(ctx): Promise<boolean>; getCurrentUser(ctx): Promise<AuthUser | null> }` — API.md:145-149
- `AuthField { name; label; type: 'text'|'password'|'email'|'tel'|'number'|'hidden'; required; defaultValue? }` — API.md:112-118
- `AuthAction { name; label; fields: AuthField[]; url?; method?: 'GET'|'POST'; capability?: 'webauthn-get'|'webauthn-create' }` — API.md:10-17
- `AuthState { state: 'signedOut'|'signedIn'|'confirmingSignUp'|'confirmingSignIn'|'confirmingMfa'|'confirmingPasswordReset'; user?; actions; error?; errorName?; retriable? }` — API.md:121-128
- `AuthStateApi { getAuthState(): Promise<AuthState>; setAuthState(input: AuthActionInput): Promise<AuthState> }` — API.md:131-136
- `AuthActionPayloadMap` — API.md:27-109. **15 action keys**: `signIn`, `signUp`, `confirmSignUp`,
  `confirmSignIn` (8-arm union discriminated on `challenge`), `resendSignUpCode`, `autoSignIn`,
  `resetPassword`, `confirmResetPassword`, `signOut`, `signInWithPasskey`,
  `startPasskeyRegistration`, `completePasskeyRegistration`, `listPasskeys`, `deletePasskey`.
- `AuthActionInput` = discriminated union derived from the map — API.md:20-24

> ⚠️ **`API.md` is incomplete for this package.** The generated report covers only the root entry
> (`.`). The `./ui` subpath's *value* exports — `Authenticator` (`src/ui.ts:497`), `AccountMenuBar`
> (`src/ui.ts:1040`), `AuthenticatedContent` (`src/ui.ts:316`), `broadcastAuthChange` (`src/ui.ts:191`),
> `onAuthChange` (`src/ui.ts:232`) — and the `./cookies` subpath's exports
> (`resolveCookieSecurity` `src/cookies.ts:72`, `buildCookieSecurityAttrs` `src/cookies.ts:107`,
> `isLoopbackRequest` `src/cookies.ts:131`) and the override types (`AuthFieldOverride` `src/ui.ts:350`,
> `AuthActionOverride` `src/ui.ts:393`, `AuthenticatorOptions` `src/ui.ts:421`) are **not in any API
> report**. `api-extractor.json` only points at the root entry. Any API-surface gate on a refactor
> is currently blind to two of three public subpaths.

**The `AuthActionPayloadMap` is Cognito-shaped.** Of the 15 keys, 6 exist solely to serve
`bb-auth-cognito` (`signInWithPasskey`, `startPasskeyRegistration`, `completePasskeyRegistration`,
`listPasskeys`, `deletePasskey`, `autoSignIn`) and the 8-arm `confirmSignIn` union
(API.md:41-74) is a verbatim transcription of Cognito's challenge names. `bb-auth-oidc` uses exactly
**one** key (`signOut`, `packages/bb-auth-oidc/src/auth-oidc.ts:429`); `bb-auth-basic` uses **six**
(`signIn`, `signUp`, `confirmSignUp`, `signOut`, `resetPassword`, `confirmResetPassword`,
`packages/bb-auth-basic/src/index.ts:418-453`). The "common" type is 60 % Cognito-private.

**Documented contract that no longer matches reality:** `src/index.ts:47` documents
`BlocksAuth.requireAuth` as `@throws {ApiError} 401 with name SessionExpiredException`. Only
`AuthBasic` does that (`bb-auth-basic/src/index.ts:395`); `AuthCognito` throws
`NotAuthenticatedException` (`bb-auth-cognito/src/index.ts:1167`, `index.aws.ts:1533`) and `AuthOIDC`
throws `NotAuthenticatedException` (`bb-auth-oidc/src/auth-oidc.ts:648`). **This is the single most
user-visible inconsistency in the whole surface** — see §2.1.

**Dead doc link:** `src/index.ts:35` points at `../docs/tech-design/A0-API-DESIGN.md#g14-...`.
`docs/tech-design/` contains only `BB-auth-cognito-admin.md` and
`BB-auth-cognito-admin-implementation-plan.md`; the real file is `docs/design/API-DESIGN.md`.
Violates `AGENTS.md` core rule 11.

---

### 1.2 `packages/bb-auth-basic` — `@aws-blocks/bb-auth-basic` v0.1.9

**`package.json`**

- `files[]` (L22-28): `dist`, `README.md`, `DESIGN.md`, `src`, `LICENSE`.
- `exports` (L29-35) — **only `browser` + `types` + `default`. No `cdk`. No `aws-runtime`.**
  ```jsonc
  ".": { "browser": "./dist/index.browser.js", "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  ```
  Under `--conditions=cdk` this resolves to `default` → the single real implementation, which works
  only because its constituent BBs (`KVStore`, `AppSetting`) each have their own `cdk` entry.
- `scripts` (L36-40): `prebuild: node ../../scripts/generate-version.mjs AuthBasic`, `build`, `test`.
- `dependencies` (L41-51): `@aws-blocks/core`, `bb-app-setting`, `auth-common ^0.1.8`, `bb-kv-store`,
  `bb-logger`, plus **runtime deps `bcryptjs ^3.0.3` and `jsonwebtoken ^9.0.3`** (+ their `@types/*`
  as *dependencies*, not devDependencies — L47-48, a packaging smell).

**`src/` layout** — 6 files, 842 lines total.

| File | Lines | Role |
|---|---|---|
| `src/index.ts` | 565 | the whole BB: class, options, state machine, cookies, codes |
| `src/index.browser.ts` | 19 | browser stub |
| `src/errors.ts` | 27 | `AuthBasicErrors` |
| `src/index.test.ts` | 123 | unit |
| `src/cookies.test.ts` | 87 | unit |
| `src/index.browser.test.ts` | 21 | unit |

There is **no `types.ts`**, **no `index.cdk.ts`**, **no `index.aws.ts`**, **no `parity.test.ts`**.
`DESIGN.md:150` documents this as decision **D-AB-8 "Single-file implementation (no separate
CDK/AWS/mock entry points)"**.

**Scope subclass:** `export class AuthBasic extends Scope implements BlocksAuth`
(`src/index.ts:148`). Constructor `src/index.ts:163-173`:
```ts
super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });   // :164
this.users     = new KVStore(this, 'users');                             // :166
this.jwtSecret = new AppSetting(this, 'jwt-secret', { secret: true });   // :167
this.codes     = new KVStore(this, 'codes');                             // :168
```
No `registerSdkIdentifiers`, no `registerConfig` — it owns no resource name of its own.

**Public API (authoritative: `packages/bb-auth-basic/API.md`)**

Class `AuthBasic` (API.md:23-58) — 11 members:

| Member | Signature | Source |
|---|---|---|
| ctor | `(scope: ScopeParent, id: string, options?: AuthBasicOptions)` | `src/index.ts:163` |
| `signUp` | `(username, password) => Promise<void>` | `src/index.ts:254` |
| `confirmSignUp` | `(username, code) => Promise<void>` | `src/index.ts:281` |
| `signIn` | `(username, password, context) => Promise<AuthBasicUser>` | `src/index.ts:298` |
| `signOut` | `(context) => Promise<void>` | `src/index.ts:314` |
| `resetPassword` | `(username) => Promise<void>` | `src/index.ts:324` |
| `confirmResetPassword` | `(username, code, newPassword) => Promise<void>` | `src/index.ts:341` |
| `requireAuth` | `(context) => Promise<AuthBasicUser>` | `src/index.ts:393` |
| `checkAuth` | `(context) => Promise<boolean>` | `src/index.ts:399` |
| `getCurrentUser` | `(context) => Promise<AuthBasicUser \| null>` | `src/index.ts:403` |
| `createApi` | `() => { getAuthState; setAuthState }` | `src/index.ts:409` |
| `buildApi` | **`@deprecated`** `() => { signUp; signIn; signOut; getCurrentUser }` | `src/index.ts:470` |
| `log` | `@internal protected ChildLogger` | `src/index.ts:161` |
| `logger?` | public `ChildLogger` | `src/index.ts:158` |

Types: `AuthBasicUser extends AuthUser { createdAt: string }` (API.md:79-81, `src/index.ts:26`),
`AuthBasicOptions { sessionDuration?; passwordPolicy?; codeDelivery?; crossDomain?; logger? }`
(API.md:70-76, `src/index.ts:62`), `PasswordPolicy { minLength?; requireUppercase?;
requireLowercase?; requireDigits?; requireSpecialChars? }` (API.md:95-101, `src/index.ts:34`),
`CodeDeliveryFn = (username, code) => Promise<void>` (API.md:92, `src/index.ts:57`).

Re-exports from `auth-common`: `AuthAction`, `AuthActionInput`, `AuthField`, `AuthState`, `AuthUser`,
`BlocksAuth` (API.md:18-20, 83-89; `src/index.ts:18-19`).

Error constants — `src/errors.ts:21-27`, **5 entries**:
```
InvalidCredentials  → 'InvalidCredentialsException'
UserAlreadyExists   → 'UserAlreadyExistsException'
InvalidCode         → 'InvalidCodeException'
SessionExpired      → 'SessionExpiredException'
InvalidPassword     → 'InvalidPasswordException'
```

**Browser stub** (`src/index.browser.ts:11`) exports a class `AuthBasic` (not extending `Scope`) plus
type re-exports and `AuthBasicErrors`. It does **not** export `CodeDeliveryFn` (present in `index.ts`
via `AuthBasicOptions`) — a nominal parity gap (L8 re-exports only `AuthBasicUser`, `PasswordPolicy`,
`AuthBasicOptions`).

**Two `as any` / `: any` casts in shipped code**, against `AGENTS.md` rule 8:
`src/index.ts:455` `(input as any).action`, `src/index.ts:457` `catch (e: any)`.

---

### 1.3 `packages/bb-auth-cognito` — `@aws-blocks/bb-auth-cognito` v0.1.10

**`package.json`**

- `files[]` (L23-28): `dist`, `README.md`, `DESIGN.md`, `LICENSE` — **does not ship `src`**, unlike the
  other three.
- `exports` (L29-44) — full four-layer split **plus a `./ui` subpath**:
  ```jsonc
  ".":    { "browser": "./dist/index.browser.js",
            "cdk":     { "types": "./dist/index.cdk.d.ts", "default": "./dist/index.cdk.js" },
            "aws-runtime": "./dist/index.aws.js",
            "types":   "./dist/index.d.ts",      // ← types resolve to the MOCK
            "default": "./dist/index.js" },
  "./ui": { "types": "./dist/ui.d.ts", "default": "./dist/ui.js" }
  ```
  Note the mock entry is `index.ts` (not `index.mock.ts` as `bb-kv-store`/`bb-auth-oidc` use) — a
  third naming convention inside the same monorepo.
- `scripts` (L45-51): `prebuild: generate-version.mjs AuthCognito`, `build`,
  `test: node --test --test-concurrency=1 dist/**/*.test.js`, plus two sandbox-only scripts
  `deploy:manual-pools` / `teardown:manual-pools`.
- `dependencies` (L52-60): core, bb-app-setting, auth-common, bb-kv-store, bb-logger,
  `@aws-sdk/client-cognito-identity-provider`, **`aws-jwt-verify ^5.0.0`**.
- `devDependencies` (L61-75) — 13 entries including `@aws-crypto/client-node`, `@aws-sdk/client-kms`,
  `@aws-sdk/client-ses`, `@aws-sdk/client-lambda`, `asn1.js`, `bn.js`, `esbuild`: all sandbox/e2e
  test-support machinery (custom sender Lambda, TOTP, zip).

**`src/` layout** — 24 files, ~14 200 lines. The single largest BB in the repo.

| File | Lines | Role |
|---|---|---|
| `src/index.ts` | 2332 | **mock** runtime + `createApi()` |
| `src/index.aws.ts` | 2465 | AWS runtime (`@aws-sdk/client-cognito-identity-provider`) + own `createApi()` |
| `src/index.cdk.ts` | 530 | CDK construct (UserPool + Client + IAM) |
| `src/index.browser.ts` | 55 | browser stub |
| `src/types.ts` | 1248 | 55 exported symbols incl. `AuthCognitoErrors`, `envVarNames`, `isRetriableAuthError`, `makeExternalUserPoolRef` — **not types-only**, violates the `types.ts` convention |
| `src/state-machine.ts` | 615 | pure `AuthState` builders (`signedOut`, `confirmingSignUp`, `confirmingSignIn`, `signedIn`, `registeringPasskey`, `managingPasskeys`, `confirmingPasswordReset`) |
| `src/sessions.ts` | 289 | `SessionStore`, `SessionRecord`, JWT decode helpers |
| `src/cookies.ts` | 258 | session cookie + encrypted auto-sign-in cookie |
| `src/ui.ts` | 183 | `cognitoOverrides` + Cognito-narrowed override types |
| tests | 4 800+ | see §6 |
| `src/test-support/*` | 5 files | TOTP, zip, custom-sender harness, test-pool fixture |
| `scripts/*.mjs` | 2 | manual pool deploy/teardown |

**Scope subclasses (three separate classes, one name):**
- mock: `export class AuthCognito<const O extends AuthCognitoMockOptions = AuthCognitoMockOptions> extends Scope implements BlocksAuth` — `src/index.ts:207`
- aws: `export class AuthCognito<const O extends AuthCognitoOptions = AuthCognitoOptions>` — `src/index.aws.ts:610`
- cdk: `export class AuthCognito<const O extends AuthCognitoOptions = AuthCognitoOptions> extends BuildingBlockScope` — `src/index.cdk.ts:68`
- browser: `export class AuthCognito<const O extends AuthCognitoOptions = AuthCognitoOptions>` (no base) — `src/index.browser.ts:31`

> ⚠️ The **mock's generic default is `AuthCognitoMockOptions`** (which adds `codeDelivery`), and
> `types` resolves to the mock. So `new AuthCognito(scope, 'auth', { codeDelivery })` **typechecks
> and is silently ignored in AWS**. `DESIGN.md:103` asserts the opposite ("not re-exported from the
> umbrella `blocks` package, so … is a TypeScript error") — verify against `packages/blocks` (§4.1).

**Public API (authoritative: `packages/bb-auth-cognito/API.md`, 630 lines)**

`AuthCognito` class — **43 public members** (API.md:82-135). Grouped:

*BlocksAuth trio + authz:* `requireAuth` (:113), `checkAuth` (:86), `getCurrentUser` (:106),
`requireRole(context, role: GroupOf<O>)` (:115 — **not on `BlocksAuth`**).

*Sign-up:* `signUp` ×2 overloads (:126, :128), `confirmSignUp` ×2 overloads (:92, :94),
`resendSignUpCode` (:116), `autoSignIn` (:85).

*Sign-in:* `signIn(username, password, context, options?)` (:122), `confirmSignIn` ×2 overloads
(:89, :91), `signOut(context, {global?})` (:123).

*Session/tokens:* `fetchAuthSession(context, {forceRefresh?})` (:100) → `AuthSession { tokens?: { idToken: JWT; accessToken: JWT }; userSub? }`.

*Profile:* `fetchUserAttributes` (:103), `updateUserAttribute` (:132), `updateUserAttributes` (:133),
`confirmUserAttribute` (:95), `sendUserAttributeVerificationCode` (:118), `updatePassword` (:131),
`deleteUser` (:99).

*Password reset:* `resetPassword` (:117) → `ResetPasswordResult`, `confirmResetPassword` (:88).

*MFA:* `setUpTOTP` (:119), `verifyTOTPSetup` (:134), `fetchMFAPreference` (:102),
`updateMFAPreference` (:130).

*Devices:* `fetchDevices` (:101, `AsyncIterable<DeviceRecord>`), `rememberDevice` (:112),
`forgetDevice` (:104).

*Passkeys/WebAuthn:* `startPasskeyRegistration` (:129), `completePasskeyRegistration` (:87),
`listPasskeys` (:107), `deletePasskey` (:98).

*Admin:* `get admin(): AdminGetterOf<O>` (:84) → `GroupAdmin<O> & LifecycleAdmin<O>` —
`addUserToGroup`, `removeUserFromGroup`, `listGroupsForUser`, `listUsersInGroup` (API.md:335-344)
and `createUser`, `getUser`, `deleteUser`, `enableUser`, `disableUser`, `resetUserPassword`,
`setUserPassword`, `revokeUserSessions`, `scan` (API.md:369-388). Each admin method takes a
`...gate: AdminActionGate<O, A>` phantom parameter (API.md:19) so un-granted calls are compile errors.

*Other:* `static fromExisting = makeExternalUserPoolRef` (:105), `readonly options: O` (:111),
`createApi(): AuthStateApi` (:97), `@internal protected log` (:109).

Type-level machinery (unique to this BB): `AttrOf<O>` (:77), `ReadAttrOf<O>` (:444),
`GroupOf<O>` (:347), `MfaTypeOf<O>` (:414), `CustomAttrNames<O>` (**`@internal` but leaked into two
`@public` signatures** — two `ae-incompatible-release-tags` warnings at API.md:74 and :441),
`AdminGrants<O,A>` (:39), `AdminActionGate<O,A>` (:19), `AdminDisabled` (:29), `AdminGetterOf<O>` (:34).

Free functions: `envVarNames(fullId)` (:313) → `{ USER_POOL_ID, CLIENT_ID, REGION }` with the
`BLOCKS_AUTH_COGNITO_${string}_*` template-literal names; `isRetriableAuthError(name)` (:356);
`makeExternalUserPoolRef(userPoolId, clientId?)` (:391).

`@internal` but exported: `SessionStore` class (:471-479) and `SessionRecord` (:462-466) — two
`ae-internal-missing-underscore` warnings.

`AuthCognitoErrors` — `src/types.ts:1142`, **28 entries** (API.md:138-168). Values are Cognito's
wire-format exception names verbatim (`DESIGN.md:144`), which is why `UserAlreadyExists` is
`'UsernameExistsException'` and `GroupNotFound` is `'ResourceNotFoundException'` (`DESIGN.md:145`).

`AuthCognitoOptions` — API.md:176-204, 18 fields: `admin`, `authFlowType`, `crossDomain`,
`deviceTracking`, `enablePasskeys`, `featurePlan`, `groups`, `logger`, `mfa`, `mfaTypes`,
`passwordPolicy`, `preferredChallenge`, `removalPolicy`, `selfSignUp`, `sessionTtlSeconds`,
`signInWith`, `userAttributes`, `userPool`, `webAuthnRelyingParty`.

**CDK layer** (`src/index.cdk.ts`): provisions `cognito.IUserPool` + `IUserPoolClient` (L69-70),
a private nested `KVStore` for sessions (L71), and injects **three** config values via
`registerConfig` (L294-296) using `envVarNames(this.fullId)`. IAM grant
`grantCognitoPermissions` (L323) lists 24 client-facing `cognito-idp:*` actions unconditionally
(L327-357) plus an opt-in admin block gated on `admin.actions` (L366-374).

> ⚠️ **No `synthGuard` anywhere in this package** (verified: `grep -rn synthGuard
> packages/bb-auth-cognito/src` → no matches). The CDK class simply *omits* all 42 runtime methods
> (its only members are `userPool`, `userPoolClient`, `sessions`, `adminOptions`, ctor,
> `fromExisting`, `createApi`, `grantCognitoPermissions` — `src/index.cdk.ts:69-323`). Calling
> `auth.requireAuth(ctx)` at synth time therefore produces a raw `TypeError: not a function`, not
> the actionable `synthGuard` message `AGENTS.md` prescribes.

**Export parity gaps across the four entries:**

| Symbol | mock `index.ts` | aws `index.aws.ts` | cdk | browser |
|---|---|---|---|---|
| `SessionStore`, `SessionRecord` | ✅ `:91` | ✅ `:140` | ❌ | ❌ |
| `extractUserAttributes` | ❌ | ✅ `:2378` | ❌ | ❌ |
| `BlocksAuth`/`AuthUser`/`AuthState`/… type re-exports | ❌ | ❌ | ❌ | ✅ `:24` |
| generic default | `AuthCognitoMockOptions` | `AuthCognitoOptions` | `AuthCognitoOptions` | `AuthCognitoOptions` |

---

### 1.4 `packages/bb-auth-oidc` — `@aws-blocks/bb-auth-oidc` v0.2.0

**`package.json`**

- `files[]` (L22-28): `dist`, `README.md`, `DESIGN.md`, `src`, `LICENSE`.
- `exports` (L29-48) — four-layer split **plus two aliased subpaths that both point at the same file**:
  ```jsonc
  ".":            { "browser": "./dist/index.browser.js",
                    "cdk": { … "./dist/index.cdk.js" },
                    "aws-runtime": "./dist/index.aws.js",
                    "types": "./dist/index.mock.d.ts",
                    "default": "./dist/index.mock.js" },
  "./middleware": { "types": "./dist/index.browser.d.ts", "default": "./dist/index.browser.js" },
  "./client":     { "types": "./dist/index.browser.d.ts", "default": "./dist/index.browser.js" }
  ```
  `./middleware` is the specifier registered via `registerClientMiddleware`
  (`src/auth-oidc.ts:83`); `./client` is a redundant alias for the same module.
- `scripts` (L49-55): `prebuild: generate-version.mjs AuthOidc` (→ `BB_NAME = 'AuthOidc'`, note
  the casing vs the class `AuthOIDC`), `build: tsc --build && npm run build:lambda`,
  **`build:lambda`** (esbuild bundle of `src/idp-registration-lambda.ts` → CJS),
  **`pretest: npm run build:lambda`**, `test: node --test --test-concurrency=1`.
- `dependencies` (L56-66): auth-common, bb-app-setting, bb-kv-store, bb-logger, core,
  `@aws-sdk/client-cognito-identity-provider`, `@aws-sdk/client-ssm`, **`jose ^6.2.3`**,
  **`openid-client ^6.8.4`**.

**`src/` layout** — 21 files, ~7 200 lines.

| File | Lines | Role |
|---|---|---|
| `src/auth-oidc.ts` | 677 | **shared base class** `AuthOIDC extends Scope implements BlocksAuth` (mock + aws both subclass it) |
| `src/engine.ts` | 143 | `AuthEngine` interface — the 11-method strategy seam |
| `src/engines/oidc-client-engine.ts` | 897 | `openid-client`-backed engine |
| `src/engines/cognito-federation-engine.ts` | 693 | Cognito-hosted-UI federation engine |
| `src/engines/session-manager.ts` | 416 | session rows + session/pending cookies |
| `src/engines/stub-idp.ts` | 804 | in-process RS256 stub IdP for local dev |
| `src/index.mock.ts` | 169 | mock entry (subclass + route mounting) |
| `src/index.aws.ts` | 169 | aws entry (subclass + SSM secret) |
| `src/index.cdk.ts` | 355 | CDK construct |
| `src/index.browser.ts` | 500 | **client middleware + `AuthOIDCClient`** |
| `src/routes.ts` | 357 | `mountAuthRoutes`, `mountStubIdpRoutes` (RawRoute escape hatch) |
| `src/providers.ts` | 407 | `google`, `github`, `customOidc`, `customOauth2`, `stubIdp`, `cognitoFederated` |
| `src/types.ts` | 394 | `AuthOIDCOptions`, `OIDCUser`, `OIDCClient`, provider configs |
| `src/errors.ts` | 54 | `AuthOIDCErrors`, `InvalidRelayError` |
| `src/state.ts` | 123 | signed `state` envelope (relay flow) |
| `src/relay.ts` | 213 | `relayOrigin`, `validateRelay` |
| `src/session-cookie.ts` | 177 | cookie encode/decode/sign |
| `src/utils.ts` | 35 | `cookieSecretEnvVar`, `resolveProviderIssuerUrl` |
| `src/idp-registration-lambda.ts` | 183 | deploy-time custom-resource handler |
| tests | 2 500+ | see §6 |

**Scope subclass:** only the base is a `Scope` subclass —
`export class AuthOIDC<P extends readonly ProviderConfig[]> extends Scope implements BlocksAuth`
(`src/auth-oidc.ts:56-58`), with a **`protected` constructor** (`:70`) that takes a pre-built
`AuthEngine` (`:74`). Mock (`src/index.mock.ts:62`) and AWS (`src/index.aws.ts:55`) each declare a
public subclass that selects and injects an engine. CDK is an unrelated class
(`src/index.cdk.ts:96`, `extends BuildingBlockScope`).

Constructor side effects (`src/auth-oidc.ts:77-84`): `super()`, logger, `validateAuthOIDCOptions`,
`this.registerClientMiddleware('@aws-blocks/bb-auth-oidc/middleware')` (**the only auth BB that
registers client middleware**). Both concrete entries additionally call
`registerSdkIdentifiers(this.fullId, { sessionTableName })` (`index.mock.ts:122`, `index.aws.ts:146`)
and `mountAuthRoutes(this)` (`index.mock.ts:135`, `index.aws.ts:149`).

**Public API — `API.md` is materially incomplete here.** The report (125 lines) carries **six
`ae-forgotten-export` warnings** (API.md:15-16, 20, 39-40, 45-46, 51-52, 57-58, 109-110) and reduces
the class to just its constructor:
```ts
export class AuthOIDC<P …> extends AuthOIDC_2<P> { constructor(scope, id, options: AuthOIDCOptions<P>); }
```
The real public surface, read from source (`src/auth-oidc.ts`):

| Member | Signature | Line |
|---|---|---|
| `get providers` | `readonly ProviderName<P>[]` | :86 |
| `get callbackPath` | `string` (default `/aws-blocks/auth/callback`) | :91 |
| `get signOutPath` | `string` (default `/aws-blocks/auth/signout`) | :96 |
| `get postSignInPath` | `string` (default `/`) | :101 |
| `get allowBearerAuth` | `boolean` | :106 |
| `get signInBasePath` | `string` (derived from `callbackPath`) | :506 |
| `requireAuth` | `(ctx) => Promise<OIDCUser>` | :144 |
| `checkAuth` | `(ctx) => Promise<boolean>` | :150 |
| `getCurrentUser` | `(ctx) => Promise<OIDCUser \| null>` | :155 |
| `getSignInUrl` | `(ctx, provider, opts?) => Promise<string>` | :191 |
| `handleCallback` | `(ctx) => Promise<OIDCUser>` | :215 |
| `handleCallbackDispatch` | `(ctx) => Promise<CallbackResult>` | :239 |
| `handleExchange` | `(input: ExchangeInput, ctx) => Promise<ExchangeResult>` | :337 |
| `getAuthorizeParams` | `(ctx, provider, request?) => Promise<AuthorizeParams>` | :365 |
| `refreshBearerTokens` | `(input, ctx) => Promise<BearerRefreshResult \| null>` | :380 |
| `signOut` | `(ctx) => Promise<void>` | :395 |
| `createApi` | `() => ApiNamespace<{getAuthState, setAuthState, getClient}>` | :422 |
| `signInRoutePath` | `(providerName) => string` | :495 |
| `signedOutState` | `protected (ctx) => AuthState` | :483 |
| `computeCallbackUrl` | `protected (ctx) => string` | :125 |

Module constants: `DEFAULT_CALLBACK_PATH` (:27), `DEFAULT_SIGNOUT_PATH` (:28),
`DEFAULT_POST_SIGNIN_PATH` (:29), `type CallbackResult` (:664).

Provider factories (API.md:43, 49, 55, 61, 66, 113): `cognitoFederated`, `customOauth2`,
`customOidc`, `github`, `google`, `stubIdp` — all with un-exported opts/return types.

`AuthOIDCErrors` — `src/errors.ts:22`, **8 entries** (API.md:28-37): `NotAuthenticated`,
`TokenExpired`, `InvalidState`, `InvalidCallback`, `ProviderNotConfigured`, `IdpError`,
`InvalidRelay`, `SdkOutdated`. Plus `InvalidRelayError extends Error` (`src/errors.ts:44`) and
`type InvalidRelayReason` (`src/errors.ts:41`) — **neither in `API.md`**.

`OIDCUser` (API.md:76-85): `{ userId; username; sub; iss; provider; email: string|null;
name: string|null; claims: Readonly<Record<string,unknown>> }`. `userId` is `${iss}:${sub}`
(`README.md:184`).

`AuthOIDCOptions` (`src/types.ts:289-355`, **not in API.md**): `providers` (required),
`allowBearerAuth?`, `postSignInPath?`, `callbackPath?`, `signOutPath?`, `onSignIn?`, `onSignOut?`,
`logger?`, `crossDomain?`, `allowedRelayOrigins?`.

Relay: `relayOrigin(uri)` + branded `RelayOrigin` (API.md:91-96), `StubUser`,
`StubAuthorizeRequest`, `OnStubAuthorize` (API.md:88-121).

Browser entry (`src/index.browser.ts`): `resolveApiBaseOrigin` (`:92`, `@internal`),
`handle401(err, provider)` (`:153`), `AuthStateMeta` (`:164`), `AuthStateHandler<U>` (`:169`),
`class AuthOIDCClient` (`:210`) with `signIn(provider, opts?)`, `handleRedirectCallback()`,
`signOut()`, `onAuthStateChange(handler)`. Registers a response middleware via
`registerMiddleware` from `@aws-blocks/core/client` (`:11`) that hydrates
`{__blocks:'oidc/client'}` into a live `AuthOIDCClient` (`:107`, `:123`). **None of this appears in
`API.md`.**

**CDK layer** (`src/index.cdk.ts`): `registerConfig(this, cookieSecretEnvVar(fullId), …)` (L116) and,
when a `cognitoFederated` provider is present, five more (L254-258: `_POOL_ID`, `_CLIENT_ID`,
`_CLIENT_SECRET`, `_REGION`, `_DOMAIN`). Only members are `callbackPath`, `signOutPath`, ctor,
`provisionCognitoFederation`, `registerIdentityProvider`, `createApi` — **same
no-`synthGuard` shape as Cognito** (L352-354).

**Export parity gaps:**

| Symbol | mock | aws | cdk | browser |
|---|---|---|---|---|
| `OIDCClient` type | ✅ `index.mock.ts:35` | ❌ | ❌ | ✅ (via `types.ts`) |
| `DEFAULT_CALLBACK_PATH`/`DEFAULT_SIGNOUT_PATH` | ❌ | ❌ | ✅ `index.cdk.ts:51-52` | ❌ |
| `ProviderOpts`, `ProviderKind`, `SecretLike`, `AuthOIDCOptions`, `*Provider` types | ❌ | ❌ | ❌ | ✅ `index.browser.ts:31-44` |
| `InvalidRelayError` | via `errors.js` only | via `errors.js` only | via `errors.js` only | via `errors.js` only |

---

## 2. Overlap & divergence matrix

Legend: ✅ = implemented · ➖ = absent · 🅛 = only via the lower-level BB it composes ·
**bold** = name/semantics differ from the sibling blocks.

### 2.1 Capability × block

| Capability | `AuthBasic` | `AuthCognito` | `AuthOIDC` |
|---|---|---|---|
| `requireAuth(ctx)` | ✅ `index.ts:393` → `AuthBasicUser` | ✅ `index.ts:1165` / `index.aws.ts:1531` → `CognitoUser<O>` | ✅ `auth-oidc.ts:144` → `OIDCUser` |
| **401 error name** | **`SessionExpiredException`** `index.ts:395` | `NotAuthenticatedException` `index.ts:1167` | `NotAuthenticatedException` (**hard-coded string**, not the constant) `auth-oidc.ts:648` |
| `checkAuth(ctx)` | ✅ `:399` | ✅ `:1172` | ✅ `:150` |
| `getCurrentUser(ctx)` | ✅ `:403` | ✅ `:1177` | ✅ `:155` |
| `requireRole` / groups | ➖ (no group concept) | ✅ `requireRole(ctx, role: GroupOf<O>)` `index.ts:1286`, 403 `NotAuthorizedException`; groups from `cognito:groups` ID-token claim (`DESIGN.md:142`) | ➖ (`OIDCUser.claims` exposed raw; no helper) |
| `signUp` | ✅ `(u, p) => void` `:254` | ✅ **overloaded** `(u, p, options?, context?) => SignUpResult` `index.ts:499-501` | ➖ (IdP owns registration) |
| `confirmSignUp` | ✅ `(u, code) => void` `:281` | ✅ **overloaded** `(u, code, context?) => ConfirmSignUpResult` `:583-585` | ➖ |
| `resendSignUpCode` | ➖ | ✅ `:668` | ➖ |
| `signIn` | ✅ `(u, p, ctx) => AuthBasicUser` **(throws on failure)** `:298` | ✅ `(u, p, ctx, opts?) => SignInResult<O>` — **returns a discriminated union `{status:'signedIn'} \| {status:'continueSignIn', nextStep}`** `:688` | ➖ **no `signIn` method at all** — `getSignInUrl(ctx, provider)` returns a redirect URL `:191` |
| `confirmSignIn` (challenge continuation) | ➖ | ✅ 3 overloads `:905-917`, 14 `SignInNextStep` shapes (API.md:487-553) | ➖ |
| `autoSignIn` | 🅛 (inlined in `createApi` `signUp` arm `:428`) | ✅ public method `:632` + encrypted auto-sign-in cookie `cookies.ts:160-253` | ➖ |
| `signOut` | ✅ `(ctx)` — **clears cookie only; JWT stays valid until exp** `:314` | ✅ `(ctx, {global?})` — deletes the server-side session row; `global:true` → Cognito `GlobalSignOut` `:1153` | ✅ `(ctx)` — deletes the session row + fires `onSignOut` hook `:395` |
| password reset | ✅ `resetPassword` `:324` / `confirmResetPassword` `:341` — **only when `codeDelivery` set**, else throws generic 400 `:325` | ✅ `resetPassword` → `ResetPasswordResult` `:1408` / `confirmResetPassword` `:1432` — always available | ➖ (IdP owns it) |
| `updatePassword` | ➖ | ✅ `:1313` | ➖ |
| MFA | ➖ | ✅ `setUpTOTP` `:1445`, `verifyTOTPSetup` `:1456`, `fetchMFAPreference` `:1586`, `updateMFAPreference` `:1490`; SMS/TOTP/EMAIL | ➖ (delegated to IdP) |
| passkeys / WebAuthn | ➖ | ✅ 4 methods `:1646`, `:1676`, `:1711`, `:1722` | ➖ |
| device tracking | ➖ | ✅ `fetchDevices` `:1604`, `rememberDevice` `:1611`, `forgetDevice` `:1626` | ➖ |
| user attributes | ➖ | ✅ 5 methods `:1302`, `:1325`, `:1361`, `:1368`, `:1375` | ➖ (`OIDCUser.claims` read-only) |
| `deleteUser` | ➖ | ✅ `:1383` (self) + `admin.deleteUser` | ➖ |
| admin / user management | ➖ | ✅ `auth.admin` — 13 methods, opt-in, IAM-gated (API.md:335-388) | ➖ |
| **token refresh** | ➖ **none** (fixed-`exp` JWT; re-login required) | ✅ silent `tryRefresh` on every read (`index.aws.ts:1555`, `:2272`, `:2284`) + `fetchAuthSession({forceRefresh})` `:1572` | ✅ engine `refreshSession` (`engine.ts:127`) + `refreshBearerTokens` for native `auth-oidc.ts:380` |
| bearer / native-client auth | ➖ | ➖ | ✅ `allowBearerAuth` option → `Authorization: Bearer` accepted `auth-oidc.ts:166-172`; `POST …/refresh` route `routes.ts:278` |
| raw token egress | ➖ | ✅ `fetchAuthSession()` returns real Cognito `idToken`/`accessToken` (`DESIGN.md:29`) | partially — `handleExchange` returns tokens **only when `allowBearerAuth`** `auth-oidc.ts:354-357` |
| federated / social sign-in | ➖ | 🅛 (pool-level; not surfaced by the BB) | ✅ `google`, `github`, `customOidc`, `customOauth2`, `cognitoFederated`, `stubIdp` |
| `fromExisting()` | ➖ (`DESIGN.md:256` — deliberate) | ✅ `static fromExisting = makeExternalUserPoolRef` `index.cdk.ts:304` → `ExternalUserPoolRef { userPoolId, clientId? }` | ➖ (uses `cognitoFederated({cognitoDomain, …})` instead — a provider factory, not a ref object) |
| `createApi()` | ✅ 2 RPC methods | ✅ 2 RPC methods, typed `: AuthStateApi` | ✅ **3** RPC methods, **untyped** |
| HTTP routes (`RawRoute`) | ➖ | ➖ | ✅ 5+ route families `routes.ts:65-314` |
| client middleware | ➖ | ➖ | ✅ `registerClientMiddleware('@aws-blocks/bb-auth-oidc/middleware')` `auth-oidc.ts:83` |
| Transferable / live client object | ➖ | ➖ | ✅ `OIDCClient` via `getClient()` + `toJSON() → {__blocks:'oidc/client'}` `auth-oidc.ts:445-474` |
| JWT verification | self-issued HS256 via `jsonwebtoken` `index.ts:382` | `aws-jwt-verify ^5.0.0` (dep) + local `decodeIdToken` `sessions.ts:85` | `jose ^6.2.3` + `openid-client` discovery |
| cookie **name** | `auth_${fullId}` `index.ts:355` | `auth_${fullId}` `cookies.ts:28-30` + `autosignin_${fullId}` `:126` | `oidc_${prefix}_session` + `oidc_${prefix}_pending` `session-manager.ts:56-62` |
| cookie **payload** | signed JWT `{username}`, HS256, `issuer: bb-auth-basic:${fullId}` `:354` | `<sessionId>.<base64url HMAC>` → DynamoDB row `cookies.ts:38-41` | `base64url(JSON) + HMAC`, `{mode:'stateful', provider, sessionId, exp}` `session-cookie.ts:68-69` |
| cookie security policy | shared `buildCookieSecurityAttrs` `index.ts:9` | shared `buildCookieSecurityAttrs` `cookies.ts:7` | shared `resolveCookieSecurity` `index.mock.ts:11`, `index.aws.ts:13` |
| `crossDomain` option | ✅ | ✅ | ✅ (the one option all three agree on) |
| server-side revocation | ➖ (impossible — stateless) | ✅ (session row delete + `revokeUserSessions` admin) | ✅ (session row delete) |
| `logger` option | ✅ | ✅ | ✅ |
| `codeDelivery` option | ✅ `(u, code) => void` — **2 params** `index.ts:57` | ✅ `(u, code, purpose) => void` — **3 params, mock-only** `types.ts`/API.md:231 | ➖ |
| `passwordPolicy` option | ✅ `requireSpecialChars` | ✅ **`requireSymbols`** (same concept, different key) API.md:434 | ➖ |

### 2.2 The seven name/semantics collisions a refactor must resolve

1. **"Not authenticated" has two names.** `SessionExpiredException` (AuthBasic) vs
   `NotAuthenticatedException` (Cognito, OIDC). `auth-common/src/index.ts:47` documents only the
   former, so the *documented* `BlocksAuth` contract is violated by two of the three implementations.
   A client cannot write one `isBlocksError(e, …)` guard across blocks.
2. **"User already exists" has two names.** `UserAlreadyExistsException`
   (`bb-auth-basic/src/errors.ts:23`) vs `UsernameExistsException`
   (`bb-auth-cognito/src/types.ts`, API.md:142) — both keyed `UserAlreadyExists`. Same constant
   name, different wire value.
3. **Code errors: 1 vs 2 constants.** AuthBasic collapses wrong-code and expired-code into
   `InvalidCode → 'InvalidCodeException'` (`errors.ts:24`); Cognito splits them into
   `CodeMismatch → 'CodeMismatchException'` and `ExpiredCode → 'ExpiredCodeException'`
   (API.md:145-146). Client branching is not portable.
4. **`signIn` return type is not a shared shape.** AuthBasic returns the user and throws on
   failure (`index.ts:298`); Cognito returns a `{status}` discriminated union and only throws for
   hard errors (`index.ts:688`, API.md:563-569); OIDC has no `signIn` at all (redirect-based).
   Three different mental models behind one verb.
5. **Password-policy key name.** `requireSpecialChars` (AuthBasic, API.md:99) vs `requireSymbols`
   (Cognito, API.md:434). Identical semantics.
6. **`codeDelivery` arity.** 2 params (AuthBasic, `index.ts:57`) vs 3 params with a `purpose`
   discriminator (Cognito, API.md:231). Not interchangeable.
7. **BB display name casing.** `BB_NAME` values are `AuthBasic`, `AuthCognito`, **`AuthOidc`**
   (`package.json` prebuild args; `packages/core/src/common/official-bb-names.generated.ts:13-15`)
   while the exported classes are `AuthBasic`, `AuthCognito`, **`AuthOIDC`**. Telemetry and
   autocomplete disagree.

### 2.3 Structural (non-API) divergences

| Dimension | AuthBasic | AuthCognito | AuthOIDC |
|---|---|---|---|
| mock entry filename | `index.ts` (single impl) | `index.ts` | `index.mock.ts` |
| conditional exports | `browser`/`types`/`default` | `browser`/`cdk`/`aws-runtime`/`types`/`default` + `./ui` | same + `./middleware` + `./client` |
| `types.ts` present | ➖ | ✅ but **contains values** (`AuthCognitoErrors`, `envVarNames`, `isRetriableAuthError`, `makeExternalUserPoolRef`) — violates the types-only convention | ✅ (types only) |
| `errors.ts` present | ✅ | ➖ (errors live in `types.ts:1142`) | ✅ |
| `synthGuard` stubs | n/a (no cdk entry) | ➖ **none** | ➖ **none** |
| `registerSdkIdentifiers` | ➖ | ➖ (delegates to nested `KVStore`) | ✅ `index.mock.ts:122`, `index.aws.ts:146` |
| `registerConfig` at synth | ➖ | ✅ ×3 (`index.cdk.ts:294-296`) | ✅ ×1, ×6 with federation (`index.cdk.ts:116`, `:254-258`) |
| shared base class across runtimes | n/a | ➖ **`index.ts` and `index.aws.ts` are two independent 2 400-line classes** | ✅ `auth-oidc.ts` base + thin entries |
| CDK base class | n/a | `BuildingBlockScope` | `BuildingBlockScope` |
| ships `src` in `files[]` | ✅ | ➖ | ✅ |
| `API.md` completeness | complete | complete, 4 warnings | **6 `ae-forgotten-export` warnings; class surface absent** |
| own `parity.test.ts` | ➖ | ➖ (uses `scenarios.mock.test.ts` + `scenarios.sandbox.test.ts` pair) | ➖ |

The Cognito mock↔AWS duplication is the biggest maintenance liability: `index.ts` (2332 L) and
`index.aws.ts` (2465 L) reimplement the same 42-method surface twice with no shared base, while
`bb-auth-oidc` proves the alternative (`auth-oidc.ts` base + 169-line entries) works.

---

## 3. What each `createApi()` exposes

All three mount at namespace id `'auth'` under their own BB scope (so `fullId` disambiguates), and
all three are consumed by the same `Authenticator` renderer (`auth-common/src/ui.ts:497`).

### 3.1 `AuthBasic.createApi()` — `bb-auth-basic/src/index.ts:409-465`

`new ApiNamespace(this, 'auth', ctx => ({ getAuthState, setAuthState }))`. Return type **inferred**
(not annotated `AuthStateApi`).

- `getAuthState()` (`:411`): cookie → `signedInState(user)` (`:525`) or `this.signedOutState()` (`:493`).
- `setAuthState(input)` (`:416`): handles **6** actions — `signIn`, `signUp`, `confirmSignUp`,
  `signOut`, `resetPassword`, `confirmResetPassword` (`:419-453`). Unknown action → `signedOut` +
  `error: 'Unknown action: …'` (`:455`).
- **Auto-sign-in is baked into the state machine, not a separate action**: `signUp` without
  `codeDelivery` immediately calls `signIn` and returns `signedIn` (`:428-429`); with `codeDelivery`
  it returns `confirmingSignUp` (`:426`).
- **`confirmSignUp` requires `password`** even though `AuthActionPayloadMap.confirmSignUp.password`
  is optional (API.md:76-80) — throws a bare 400 when missing (`:437`). Documented as D-AB-9
  (`DESIGN.md:160`). This is a *runtime* divergence from the shared type.
- Error handling (`:457-462`): re-reads the cookie, returns the *current* state plus
  `{error, errorName?}`. **Never emits `retriable`.**
- Signed-out actions (`:493-519`): `signIn`, `signUp`, and `resetPassword` **only if `codeDelivery`
  is configured** (`:512`).

Also ships the **deprecated** `buildApi()` (`:470-489`) — a *different, non-state-machine* RPC
namespace with `signUp`/`signIn`/`signOut`/`getCurrentUser`. Also registered at id `'auth'`, so
calling both `createApi()` and `buildApi()` on one instance would collide.

### 3.2 `AuthCognito.createApi(): AuthStateApi` — `bb-auth-cognito/src/index.ts:1733-1893` (mock) / `index.aws.ts:2056` (aws)

Return type **explicitly annotated `AuthStateApi`** — narrowest of the three.

- `getAuthState()` (`:1748`): `getCurrentUser` → `signedIn(user, {enablePasskeys})` or
  `signedOut({selfSignUp, userAttributes, enablePasskeys, signInWith})`.
- `setAuthState(input)` (`:1752`): handles **14** actions (`:1754-1869`) — `signIn`,
  `signInWithPasskey`, `signUp`, `confirmSignUp`, `autoSignIn`, `resendSignUpCode`, `confirmSignIn`,
  `startPasskeyRegistration`, `completePasskeyRegistration`, `listPasskeys`, `deletePasskey`,
  `resetPassword`, `confirmResetPassword`, `signOut`.
- `confirmSignIn` dispatches on the hidden **`challenge` discriminator** (`:1821-1831`), mapping 8
  payload shapes onto one `response: string` argument.
- `signUp` spreads unknown fields into `attributes` (`:1771-1785`) so custom attributes flow through
  the dynamic form.
- **Emits `retriable: true`** for recoverable challenge failures with an empty `actions: []`
  (`:1880-1888`) so the client preserves its current form. Neither sibling does this.
- States emitted (`state-machine.ts`): `signedOut` (:110), `confirmingSignUp` (:207),
  `confirmingSignIn` (:250, 14 `nextStep` branches), `signedIn` (:493), `registeringPasskey` (:519),
  `managingPasskeys` (:552), `confirmingPasswordReset` (:586). **Never emits `confirmingMfa`** even
  though `AuthState` declares it (`auth-common/src/index.ts:159`) — that union member is dead.
- Emits `AuthAction.capability` (`'webauthn-get'` `state-machine.ts:439`, `'webauthn-create'` `:530`)
  — the only block that uses the capability channel.

### 3.3 `AuthOIDC.createApi()` — `bb-auth-oidc/src/auth-oidc.ts:422-477`

Return type **inferred**; the namespace has **three** methods, so it is *not* an `AuthStateApi`
structurally-plus — it is a superset:

- `getAuthState()` (`:424`): `engine.verifySession` → `signedInState(user)` (`:512`) or
  `signedOutState(ctx)` (`:483`).
- `setAuthState(input)` (`:428`): handles **exactly one** action — `signOut` (`:429`). Everything
  else returns `signedOut` + `error: 'Unknown action: …'` (`:435-438`). The comment at `:433`
  explains why: sign-in is an **HTML form GET to an external URL**, not an RPC.
- **`getClient(): Promise<OIDCClient<ProviderName<P>>>`** (`:445`) — **unique to this block.**
  Returns a **Transferable**: a server-side object whose `toJSON()` emits
  `{__blocks:'oidc/client', providers, providerConfigs, callbackPath, exchangePath, signOutPath,
  signInBasePath, authorizeParamsBasePath}` (`:471-473`), re-hydrated client-side into a live
  `AuthOIDCClient` by the registered middleware (`index.browser.ts:107`, `:123`).
- `signedOutState` (`:483-492`) emits one **external** `AuthAction` per provider:
  `{name: p.name, label: 'Sign in with …', fields: [], url: signInRoutePath(p.name), method: 'GET'}`.
  So OIDC's action *names are provider names* (`google`, `github`, …), not verbs — the only block
  whose action namespace is open-ended.

### 3.4 RPC/HTTP surface comparison

| | AuthBasic | AuthCognito | AuthOIDC |
|---|---|---|---|
| JSON-RPC methods | 2 | 2 | **3** (`+getClient`) |
| `setAuthState` actions handled | 6 | **14** | **1** |
| `AuthState.state` values emitted | `signedOut`, `signedIn`, `confirmingSignUp`, `confirmingPasswordReset` | + `confirmingSignIn` | `signedOut`, `signedIn` only |
| uses `AuthAction.url` (external form) | ➖ | ➖ | ✅ (every provider) |
| uses `AuthAction.capability` | ➖ | ✅ | ➖ |
| emits `retriable` | ➖ | ✅ | ➖ |
| emits `errorName` | ✅ (`:460`) | ✅ (`:1875`) | ➖ **never** |
| raw HTTP routes | ➖ | ➖ | `GET {callbackPath}` (`routes.ts:65`), `POST {signOutPath}` (`:134`), `GET {signInBasePath}/<provider>` per provider (`:147`), `POST {base}/exchange` (`:168`), `GET+POST {base}/authorize-params/<provider>` per provider (`:212`, `:234`), `POST {base}/refresh` when `allowBearerAuth` (`:278`), plus the stub-IdP tree under `{base}/idp/<provider>/*` (`:318`) |
| reserved path namespace | ➖ | ➖ | ✅ all routes must live under `BLOCKS_AUTH_PREFIX` = `/aws-blocks/auth` (`core/src/constants.ts:31`), enforced at `auth-oidc.ts:621-632` |

Consequence: a unified auth API has to reconcile **an RPC-only block, an RPC-only block with a
14-action state machine, and a redirect/route-based block whose RPC surface is one action plus a
Transferable**. The `AuthStateApi` contract is the only thing all three satisfy, and OIDC satisfies
it only in the "2 of 3 states, 1 of 15 actions" sense.


---

## 4. Everything downstream that consumes auth

**Only two `package.json` files in the whole repo declare a direct dependency on any of the four auth
packages**: `packages/blocks/package.json` and `test-apps/comprehensive/package.json`. Everything else
consumes them through the umbrella `@aws-blocks/blocks` (or, in two cases, via undeclared imports —
see §4.9). That concentrates the blast radius, but it also means most consumers are pinned to whatever
the umbrella chooses to re-export.

### 4.1 `packages/blocks` — the umbrella

`packages/blocks/src/index.ts` (default + aws-runtime entry):

| Line | Export |
|---|---|
| 34 | `export type { AuthAction, AuthActionInput, AuthField, AuthState, AuthUser, BlocksAuth } from '@aws-blocks/auth-common'` |
| 110-116 | `export { AuthBasic, AuthBasicErrors, type AuthBasicOptions, type AuthBasicUser, type PasswordPolicy } from '@aws-blocks/bb-auth-basic'` |
| 117-148 | 30 Cognito **types**: `AdminAction`, `AdminActionGate`, `AdminCreateInit`, `AdminDisabled`, `AdminGetterOf`, `AdminGrants`, `AdminOptions`, `AdminSurface`, `AdminUser`, `AdminUserFilter`, `AuthCognitoOptions` (:128), `AuthFlowType`, `CodeDeliveryDetails`, `CodeDeliveryFn` (:131), `CognitoUser`, `ConfirmSignInOptions`, `DeviceRecord`, `ExternalUserPoolRef`, `GroupAdmin`, `LifecycleAdmin`, `MFAPreference`, `ResetPasswordResult`, `SetPasswordOptions`, `SignInNextStep`, `SignInOptions`, `SignInResult`, `SignUpOptions`, `SignUpResult`, `UpdateAttributeOutcome`, `UserAttribute` |
| 164 | `export { AuthCognito, AuthCognitoErrors } from '@aws-blocks/bb-auth-cognito'` |
| 165-170 | `export type { AuthOIDCErrorName, MappedClaims, OIDCUser, RelayOrigin } from '@aws-blocks/bb-auth-oidc'` |
| 187-197 | `export { AuthOIDC, AuthOIDCErrors, cognitoFederated, customOauth2, customOidc, github, google, relayOrigin, stubIdp } from '@aws-blocks/bb-auth-oidc'` |

`packages/blocks/src/index.cdk.ts` mirrors it: L58 (auth-common types), L77-92 (AuthBasic),
L93-107 (Cognito types + class, `AuthCognitoOptions` at :91), L108 (OIDC types),
L109-119 (`AuthOIDC` + the six provider factories).

`packages/blocks/src/ui.ts:5` — the **only** definition of `@aws-blocks/blocks/ui`, a pure
re-export: `export { Authenticator, AuthenticatedContent, AccountMenuBar, onAuthChange,
broadcastAuthChange, type AuthStateApi } from '@aws-blocks/auth-common/ui'`.

`packages/blocks/src/server.ts:4` — `export { withAuth, registerCookieProvider,
clearCookieProviders } from '@aws-blocks/core/server'`.

`packages/blocks/src/sdk-identifiers.ts` — **two auth-specific overloads**:
- `:21` `import type { AuthCognito } from '@aws-blocks/bb-auth-cognito'`
- `:22` `import type { AuthOIDC } from '@aws-blocks/bb-auth-oidc'`
- `:57` `getSdkIdentifiers(bb: AuthCognito<any>): { userPoolId: string; clientId: string }`
- `:58` `getSdkIdentifiers(bb: AuthOIDC<any>): { sessionTableName: string }`

> ⚠️ The `:57` overload promises `{ userPoolId, clientId }` for `AuthCognito`, but
> `bb-auth-cognito` never calls `registerSdkIdentifiers` in any layer (§1.3) — the identifiers it
> resolves come from its nested `KVStore`. This overload looks unbacked; verify before relying on it.

`packages/blocks/package.json`:
- deps: `@aws-blocks/auth-common ^0.1.8`, `bb-auth-basic ^0.1.9`, `bb-auth-cognito ^0.1.10`,
  `bb-auth-oidc ^0.2.0`.
- `aws-blocks.vendorize` map: `"@aws-blocks/bb-auth-basic": ["AuthBasic"]`,
  `"@aws-blocks/bb-auth-cognito": ["AuthCognito"]`, `"@aws-blocks/bb-auth-oidc": ["AuthOIDC"]`.
  **`auth-common` is deliberately absent** and is explicitly allow-listed out of the coverage check at
  `packages/blocks/src/vendorize-map.test.ts:55` (`dep.endsWith('/auth-common')`), justified at
  `:49-58` as an "infrastructure package (not a user-facing BB)". **If a refactor ever needs a
  directly-instantiable export from `auth-common`, this exclusion must be lifted.**

`packages/blocks/README.md`: `:10` import example includes `AuthBasic`; `:67-105` the "Adding auth
and data" tutorial (`new AuthBasic(...)`, `auth.createApi()`, `auth.requireAuth(context)`,
`Authenticator`/`onAuthChange` from `@aws-blocks/blocks/ui`); `:96` the "no auth by default" security
warning; `:120-123` catalog bullets for the three BBs; `:160`, `:164-166` catalog table rows for all
four packages; `:230`, `:237`, `:243` security callouts on `requireAuth`/`requireRole`/`crossDomain`;
`:257-258` the UI-components section.

**Umbrella export gaps** (symbols a customer can only reach by importing the BB package directly):
`AuthBasic.CodeDeliveryFn`, `AuthCognitoMockOptions`, `AuthCognito`'s `AttrOf`/`ReadAttrOf`/`GroupOf`/
`MfaTypeOf`/`AuthSession`/`JWT`/`PasskeyDescription`/`StartPasskeyRegistrationResult`/
`CompletePasskeyRegistrationResult`/`MFAPreferenceInput`/`MFASetting`/`PreferredChallenge`/
`SignInWith`/`StandardUserAttributeKey`/`WebAuthnRelyingPartyConfig`/`envVarNames`/
`isRetriableAuthError`/`makeExternalUserPoolRef`, and all of `AuthOIDC`'s options and engine types
(`AuthOIDCOptions`, `OIDCClient`, `StubUser`, `StubAuthorizeRequest`, `OnStubAuthorize`,
`InvalidRelayError`, `CallbackResult`, `ExchangeInput`/`ExchangeResult`/`AuthorizeParams`).

> ⚠️ **`bb-auth-cognito/DESIGN.md:103` appears to be wrong.** It claims `codeDelivery` is
> "not re-exported from the umbrella `blocks` package, so application code that passes
> `codeDelivery` to the AWS runtime is a TypeScript error." But the umbrella re-exports the *class*
> from the package root (`index.ts:164`), whose `types` condition resolves to the mock
> (`index.d.ts`), whose generic default is `AuthCognitoMockOptions` — so `new AuthCognito(scope,
> 'auth', { codeDelivery })` typechecks through the umbrella and is silently a no-op on AWS. The
> interface name not being re-exported (only `CodeDeliveryFn` at `index.ts:131` and
> `AuthCognitoOptions` at `:128`) does not prevent it. Confirm with a deliberate typecheck before
> the refactor removes or relies on this guard.

### 4.2 `packages/core` — auth-aware plumbing (no direct import of the 4 packages)

| File:line | Symbol / behavior |
|---|---|
| `src/constants.ts:31` | `export const BLOCKS_AUTH_PREFIX = '/aws-blocks/auth'` (and `BLOCKS_RPC_PREFIX` at `:19`) |
| `src/index.ts:27`, `src/index.cdk.ts:56` | re-export `BLOCKS_AUTH_PREFIX`, `BLOCKS_RPC_PREFIX` |
| `src/hosting.ts:24` | imports both prefixes |
| `src/hosting.ts:895-907` | CloudFront gets **one** behavior for `${BLOCKS_AUTH_PREFIX}/*` (`:902`); `:904` seeds the dedup set; `:907` skips per-route behaviors under the prefix. Comment names `AuthOIDC` as the mounter |
| `src/hosting.ts:827` | comment: the auth BB reads `process.env.BLOCKS_PUBLIC_ORIGIN` (consumed at `bb-auth-oidc/src/auth-oidc.ts:129`) |
| `src/errors.ts:124-128` | `hasAuthError<T, N>(state, name)` — the guard for `AuthState.errorName`; JSDoc example at `:119` imports `AuthBasicErrors.InvalidCredentials` |
| `src/index.ts:28`, `src/index.cdk.ts:57`, `src/client/index.ts:319` | re-export `hasAuthError` |
| `src/server/withAuth.ts` | `CookieProvider`, `registerCookieProvider`, `clearCookieProviders`, `_getProviders`, `withAuth<T>(fn, cookies?)` (`:295-323`); built-in `'nextjs'` provider (`:100-110`), `'nuxt'` provider (`:139-190`) |
| `src/lambda-handler.ts:23-32` | `requestCookies` `AsyncLocalStorage<string>`, registered as `globalThis.__BLOCKS_REQUEST_COOKIES_STORE__` |
| `src/lambda-handler.ts:517-524` | wraps each request in `requestCookies.run(...)` so BB session-cookie reads see the inbound `cookie` header |
| `src/lambda-handler.ts:667-692` | generic `Set-Cookie` strip/re-emit — every auth BB's session cookie rides this |
| `src/lambda-handler.ts:129` | comment on URL construction affecting `.../auth/callback` |
| `src/client/index.ts:14-17`, `:276-300` | SSR cookie forwarding — reads the same global store, merges + dedups into the outgoing `Cookie` header |
| `src/client/index.ts:148`, `:154`, `:163-166`, `:193` | `RequestMiddleware`/`ResponseHook` JSDoc examples demonstrate injecting an `authorization` header — the hook `bb-auth-oidc/middleware` plugs into |
| `src/redact.ts:22`, `:38`, `:53` | comments name `@aws-blocks/auth-common`'s `AuthField` / `confirmSignIn` payloads as the source of the sensitive-key vocabulary (`password`, `session`, `token`, `secret`, `credential`, `apikey`, `authorization`, exact-match `code`) |
| `src/redact.ts:107-121` | special-case redaction of form-field descriptors `{ name: 'session', defaultValue: '<token>' }`, explicitly modeled on `AuthField` |
| `src/common/index.ts:56`, `:63-64` | JSDoc: "**`AuthBasic`** from `@aws-blocks/bb-auth-basic` — Username/password authentication…"; "For authentication: Use `AuthBasic`…" |
| `src/common/index.ts:128` | comment: short BB names, e.g. `"AuthCognito"` |
| `src/common/official-bb-names.generated.ts:13-15` | `'AuthBasic'`, `'AuthCognito'`, **`'AuthOidc'`** |
| `src/api.ts:115`, `:129-156`, `:182` | `ApiNamespace` JSDoc — "no auth by default" model, examples calling `auth.requireAuth(context)` / `auth.requireRole(context, 'admins')`, names `bb-auth-cognito`'s README as the reference |
| `src/raw-route.ts` | the generic `RawRoute` primitive `bb-auth-oidc/src/routes.ts` builds on (no auth-specific code) |

So `packages/core` carries **five** load-bearing auth couplings: the reserved URL prefix, the
CloudFront behavior for it, `hasAuthError`, the SSR/Lambda cookie-forwarding pair, and the
redaction vocabulary. None of them import the auth packages, so none of them are typechecked against
them.

### 4.3 `packages/foundations` — stub, but ships stale auth docs

`src/index.ts` is literally `export default {};` with a TODO. Not a real consumer.
`README.md:5` disclaims itself as a stub, but the file still carries three auth snippets:
- `README.md:13-19` `import { AuthBasic } from '@aws-blocks/blocks'; const auth = new AuthBasic(scope, 'auth', {…});`
- `README.md:24-35` `import { AuthOIDC, google } from '@aws-blocks/blocks'; … await auth.requireAuth(ctx);`
- `README.md:38-45` `import { AuthCognito } from '@aws-blocks/blocks'; const users = new AuthCognito(scope, 'users'); export const auth = users.buildAPI();`
  — **`buildAPI()` does not exist on any auth BB.** `AuthBasic` has a deprecated `buildApi()`
  (lowercase, `bb-auth-basic/src/index.ts:470`); `AuthCognito` has only `createApi()`. A broken
  snippet in a published README, against `AGENTS.md` rule 11.

### 4.4 `packages/hosting` — **not** an auth consumer

No import of any of the four packages. Every `auth`/`cookie`/`session` hit is unrelated:
`src/constructs/skew_protection.ts:10-146` and `src/constructs/cdn_construct.ts:592-632` handle the
build-skew `__dpl` cookie and Next.js preview cookies (`__prerender_bypass`,
`__next_preview_data`); `src/types.ts:227`, `:391-404` mention "auth tokens" only as a header-pair
example; `src/adapters/nitro_cache_plugin_template.ts:11` refers to the AWS SDK credential chain.

### 4.5 Frontend / Authenticator UI

The UI lives in the producer package; there is no separate UI consumer package.

| Consumer | Line | Imports |
|---|---|---|
| `packages/blocks/src/ui.ts` | 5 | `Authenticator`, `AuthenticatedContent`, `AccountMenuBar`, `onAuthChange`, `broadcastAuthChange`, `type AuthStateApi` from `@aws-blocks/auth-common/ui` |
| `packages/bb-auth-cognito/src/ui.ts` | 22, 48 | `AuthenticatorOptions`, `AuthActionOverride`, `AuthFieldOverride` (etc.) from `@aws-blocks/auth-common/ui` |
| `packages/bb-auth-oidc/src/index.browser.ts` | 12-13 | `broadcastAuthChange` from `@aws-blocks/auth-common/ui`; `type AuthUser` from `@aws-blocks/auth-common` |
| `packages/create-blocks-app/resources/AGENTS.md` | 36-38 | scaffolded doc: `import { Authenticator, onAuthChange } from '@aws-blocks/blocks/ui'` |

There is **no React/JSX auth component** anywhere — the `Authenticator` returns raw DOM nodes.
The only hand-rolled auth UI outside `auth-common` is the Kotlin Compose screen in §4.6.
`test-apps/amplify-gen2/src/App.tsx:2` imports `signUp`/`confirmSignUp`/`signIn`/`signOut`/
`getCurrentUser` from `aws-amplify/auth` — Amplify's own SDK, unrelated to the Blocks auth BBs.

### 4.6 `native/*`

**Codegen fixtures** — auth is the hardest fixture in the codegen suite:
- `native/codegen-fixtures/18-hybrid-arm/spec.json:9` `"name": "authApi.setAuthState"`;
  `:384-501` the `AuthState`/`AuthUser`/`AuthAction`/`AuthField` schemas, mirroring
  `auth-common`'s wire shapes.
- `native/codegen-fixtures/18-hybrid-arm/kotlin/AuthApi.kt:19-24` `public class AuthApi`;
  `:23-27` `setAuthState(input: SetAuthState.Input): AuthState`; `:30-60+` sealed `Input` with
  `SignIn`/`SignUp`/`ConfirmSignUp`/`ResendSignUpCode` — generated proof the `AuthActionInput`
  discriminated union round-trips into native codegen.
- Same fixture's `swift/Api.swift`, `dart/client.dart`; plus `20-multiple-namespaces` and
  **`23-cognito-nested-unions`** (a golden fixture built specifically on Cognito's nested
  discriminated unions, consumed by
  `native/kotlin/runtime/src/commonTest/.../json/StatusDiscriminatorDecodeTest.kt` and
  `native/swift/Tests/BlocksRuntimeTests/StatusDiscriminatorDecodeTests.swift`).

**Kotlin** (`native/kotlin/`):
- `runtime/src/commonMain/kotlin/com/aws/blocks/kotlin/oidc/OidcClient.kt` (204 L) — `signIn(provider)`
  at `:38+` POSTs to `/auth/authorize-params/<provider>` (the `BLOCKS_AUTH_PREFIX` route
  `bb-auth-oidc/src/routes.ts:234` mounts); PKCE via `Pkce.generateRandom`/`generateCodeVerifier`/
  `calculateCodeChallenge`; `authState: StateFlow<OidcAuthState>`.
- Siblings: `OidcAuthState.kt`, `OidcTypes.kt`, `OidcPlatformLauncher.kt`,
  `PlatformLauncher.android.kt`/`.jvm.kt`/`.ios.kt`, `OidcRedirectActivity.kt`.
- `native/kotlin/AGENTS.md:11`, `:50` name `OidcClient.kt` as the OIDC auth client.
- `native/kotlin/e2e/src/commonTest/.../AuthBasicE2ETest.kt:15-23` — 8 tests against AuthBasic.
- `native/kotlin/example/kmp/composeApp/.../screens/AuthScreen.kt:27-31` — a real Compose UI built on
  the generated `AuthApi` / `AuthApi.SetAuthState.Input.SignIn|SignOut|SignUp` / `AuthState`.
- `native/kotlin/example/typescript/aws-blocks/index.ts` — `:1` imports `AuthOIDC`; `:19-28`
  `new AuthOIDC(scope, 'auth', { providers: [google(…)], allowBearerAuth: true,
  allowedRelayOrigins: [relayOrigin('blocks.testapp://oidcRedirect')] })`; `:99`
  `export const authApi = auth.createApi()`; `:145`, `:163`, `:179`, `:189` `await auth.requireAuth(context)`.

**Swift** (`native/swift/`):
- `Sources/BlocksRuntime/OIDC/OIDCClient.swift` (502 L), `OIDC/OIDCAuthState.swift`,
  `OIDC/AuthProvider.swift`, `OIDC/BrowserLauncher.swift`.
- `Sources/BlocksRuntime/KeychainCookieStore.swift` — persists the BB's session cookie in Keychain.
- `Tests/BlocksE2ETests/AuthBasicE2ETests.swift:22` `try await api.basicSignUp(…)`;
  `Tests/BlocksE2ETests/OIDCE2ETests.swift`; `Tests/BlocksRuntimeTests/OIDCClientTests.swift`.
- `Demo/swift-demo/Views/AuthSectionView.swift`, `Demo/swift-demo/App.swift`,
  `Demo/typescript-demo/aws-blocks/index.ts`.
- `native/swift/AGENTS.md:111` documents the generated signature
  `func setAuthState(input: Input) async throws -> AuthState`.

**Dart** (`native/dart/`):
- `packages/blocks_runtime/lib/src/oidc_client.dart` (557 L), `oidc_auth_state.dart`,
  `oidc_types.dart`, `auth_provider.dart`, `browser_launcher.dart`, `session_store.dart`.
- `packages/blocks_runtime_flutter/lib/src/flutter_browser_launcher.dart`.
- e2e: `example/bin/e2e/auth_basic_test.dart`, `auth_cognito_test.dart`,
  `oidc_test.dart` (`:138` `discovery.oidcAuthApi.getClient()`, `:188` `oidc.signInRelay(…)`,
  `:214` `blocks.api.oidcRequireAuth()`, `:251` `.api.oidcSignOut()`, plus a
  `TODO(SDK #824)` about relay routes resolving against the API origin), `harness.dart`;
  runner `native/dart/run-e2e.sh`.

> The three native SDKs each hand-implement the **OIDC** protocol against the exact HTTP surface in
> `bb-auth-oidc/src/routes.ts` (`authorize-params`, `exchange`, `refresh`, callback, relay). They
> consume **AuthBasic** and **AuthCognito** only through generated RPC clients. A refactor that
> changes OIDC's route paths, `AuthorizeParams` shape, relay-state envelope, or `getClient()`
> descriptor breaks all three native SDKs, and none of them are typechecked against the TS source.

### 4.7 `test-apps/*`

| App | BB instances | Key call sites |
|---|---|---|
| `comprehensive` | **7 auth instances.** `aws-blocks/index.ts:7` imports `AuthBasic, AuthCognito, AuthOIDC, google, stubIdp, relayOrigin`. `:121-127` `auth = new AuthBasic(scope,'auth',{codeDelivery})`; `:133` `authSameOrigin`, `:136` `authCrossDomain` (D-007 pair); `:145-176` `authC = new AuthCognito(...)`, `authCMfa`; `:219` `oidcAuth`, `:229` `oidcAuthExtras` (+`onSignIn` → KVStore upsert, `:192-226`), `:255` `oidcAuthRelay` | `package.json:26`, `:30-32` — direct deps on all four auth packages |
| `native-bindings` | `aws-blocks/index.ts:8-21` imports `AuthBasic, AuthCognito, AuthOIDC, stubIdp, relayOrigin`; `:36` `authBasic`; `:39-53` `authCognito` (groups `['admins','users']`, `mfa:'off'`, `mfaTypes:['TOTP']`, `selfSignUp`, `codeDelivery`); `:59-68` `oidcAuth` (stubIdp + relay + `onSignIn`) | `aws-blocks/client.js:9` **`import '@aws-blocks/bb-auth-oidc/middleware'`** (side-effect); `:14-16` three generated clients `authBasicApi`, `authCognitoApi`, `oidcAuthApi`; `aws-blocks/scripts/seed-cognito-user.ts:5` |
| `auth-cognito-passkeys` | `aws-blocks/index.ts:1` imports `AuthCognito`; `:26-42` `new AuthCognito(scope,'auth',{ signInWith:'email', authFlowType:'USER_AUTH', enablePasskeys:true, webAuthnRelyingParty, mfa:'off', selfSignUp, codeDelivery })`; `:45` `createApi()`; `:55` `requireAuth` | no `test/` directory — manual demo only |
| `vpc-smoke` | `aws-blocks/index.ts:17` **`import { AuthCognito } from '@aws-blocks/bb-auth-cognito'`** (direct, bypassing the umbrella); `:58-59` `new AuthCognito(scope,'auth')` + `createApi()` | ⚠️ `package.json` has **no `dependencies` section at all** — the import is undeclared and satisfied only by workspace hoisting; `npm run lint:deps` coverage here is worth checking |
| `hosting-spa`, `hosting-ssr`, `hosting-ssr-nuxt` | each `aws-blocks/index.ts`: `import { ApiNamespace, Scope, KVStore, AuthBasic } from '@aws-blocks/blocks'` + `new AuthBasic(scope,'auth',{codeDelivery})` | `hosting-ssr/src/app/api-test/page.tsx:302` and `hosting-ssr-nuxt/app/pages/api-test.vue:264` drive `withAuth` from `@aws-blocks/blocks/server` against `authApi` |
| `amplify-gen2` | **none** — hand-rolls `aws-blocks/cognito-verifier.ts` (`CognitoJwtVerifier` from `aws-jwt-verify`, own `checkAuth` at `:86`, own `requireAuth` at `:91-95` throwing `ApiError('Unauthorized', 401)`) | ⚠️ **shadow implementation**: it reproduces the `BlocksAuth` shape *without importing the type*, so an interface change in `auth-common` will not be caught by typechecking this file. `aws-blocks/index.ts:9`, `:21`, `:35+` — `requireAuth` at 6 call sites. Frontend `src/App.tsx:2` uses `aws-amplify/auth` |
| `db-pull-typecheck` | none | `generated/index.ts:102-107` — `supabaseCrud(context, auth?: { requireAuth: (ctx) => Promise<{userId: string}> })`, a **structurally-typed** auth param, deliberately not `BlocksAuth` |

No auth usage in `pipeline`, `hosting-ssr-astro`, `hosting-ssr-astro-default404`,
`hosting-ssr-sveltekit`, `telemetry`, `extending-blocks-guide`,
`extending-blocks-guide-blocksbackend`.

### 4.8 `packages/create-blocks-app` templates

| Template | Auth usage |
|---|---|
| `templates/auth-cognito/aws-blocks/index.ts` | **the richest consumer of `AuthCognito` in the repo.** `:1` import; `:51-68` `new AuthCognito(scope,'auth',{ authFlowType:'USER_AUTH', … })` (passwordless email-OTP + groups + custom attrs); `:114` `createApi()`; `:124`, `:138`, `:143`, `:149`, `:164`, `:180`, `:188` `requireAuth`/`requireRole(context,'editors'\|'readers')`; `:196`, `:208`, `:212` `fetchUserAttributes`/`updateUserAttributes`; `:219`, `:224` `confirmUserAttribute`/`sendUserAttributeVerificationCode`; `:229` `updatePassword`; `:236` `fetchDevices`; `:246` `forgetDevice`; `:255` `signOut(context,{global:true})` |
| `templates/default/` + `templates/react/` | `aws-blocks/index.ts:18` import `AuthBasic`; `:24` construct; `:28` `createApi()`; `:67`, `:72`, `:90`, `:109`, `:122`, `:135` `requireAuth` (6 sites each). `README.md:26` catalog bullet; `:44`, `:46` test-structure notes |
| `templates/demo/aws-blocks/index.ts` | `:1` import; `:24-78` construct + `createApi()`; `:114`, `:125`, `:145`, `:155` `requireAuth` |
| `templates/bare/aws-blocks/index.ts` | auth fully **commented out** as a next step: `:11`, `:21-22`, `:31-45`, `:67`, `:75` — including inline `setAuthState({action:'signUp'\|'signIn'\|'signOut'})` / `getAuthState()` hints |
| `templates/backend/`, `templates/nextjs/` | no instance; only a comment pointing at `@aws-blocks/bb-auth-cognito` + `auth.requireAuth(context)` |
| `templates/amplify/` | ships an **identical copy** of the `amplify-gen2` shadow pattern: `amplify-blocks.ts:14-16`, `aws-blocks/cognito-verifier.ts` (full `checkAuth`/`requireAuth`), `aws-blocks/client.js:14`, `:25`, `:27`, `aws-blocks/scripts/generate-client.ts:7`, `:38`, `:50-52`, `aws-blocks/index.ts:9`, `:16` |
| `resources/AGENTS.md` | `:5`, `:16`, `:20`, `:29`, `:31-41` — teaches "Auth is a Building Block, not hand-rolled": `await auth.requireAuth(context)`, `Authenticator`/`onAuthChange` from `@aws-blocks/blocks/ui`, and "`AuthBasic` without a `codeDelivery` config signs a user in immediately on sign-up" |
| `README.md` | `:45`, `:72`, `:77`, `:80`, `:136` — Amplify bearer-token auto-wiring, the `AuthBasic` quick start, the template list including `auth-cognito`/`amplify` |

`packages/create-blocks-app/package.json` has **no** direct dependency on the auth packages.

### 4.9 `packages/create-block`

**Not a consumer.** A repo-wide grep for `auth` in `packages/create-block` returns only incidental
word matches (`author`, `authoritative`). No auth-specific scaffold branch.

### 4.10 `docs/`

| File:line | Claim |
|---|---|
| `docs/DECISIONS.md:107-133` | **D-004 "Auth-first naming convention"** (Jon Wire) — mandates the `Auth` prefix for classes (`AuthBasic`, `AuthOIDC`, `AuthCognito`), types (`AuthBasicUser`, `AuthBasicOptions`, `AuthBasicErrors`), and packages (`bb-auth-basic`, `bb-auth-oidc`, `bb-auth-cognito`, `auth-common`); rejects strategy-first (`BasicAuth`/`OIDCAuth`). **`:133` cites `docs/tech-design/BB-auth-common.md` and `docs/tech-design/BB-auth-basic.md` — neither file exists** (two dead links; `docs/tech-design/` contains only the two `BB-auth-cognito-admin*` files) |
| `docs/DECISIONS.md:135-164` | **D-005 "Auth state machine uses a unified form model (no redirect action type)"** — OAuth/OIDC redirect is just a form submission to an external `url`, not a discriminated `AuthFormAction \| AuthRedirectAction`. This is the decision that makes `AuthOIDC`'s one-action `setAuthState` legal |
| `docs/DECISIONS.md:191-232` | **D-007 "Auth cookies default to `SameSite=Lax`; cross-domain is opt-in"** — the table at `:201-203` records that `bb-auth-basic`/`bb-auth-cognito` once hardcoded `SameSite=None` while `bb-auth-oidc` used `Lax`; converges all three on the shared `@aws-blocks/auth-common/cookies` helper (`:215`, `:232`), backed by a cross-BB parity test. **Still blocked on issue #769** (the Lax flip vs legacy two-port dev templates) |
| `docs/DECISIONS.md:239-271` | **D-006** — establishes the third-doc exception for `packages/auth-common/CUSTOMIZING-AUTH-UI.md` (PR #834, issue #700) |
| `docs/tech-design/BB-auth-cognito-admin.md:1-9` | **SUPERSEDED** — originally proposed a separate `bb-auth-cognito-admin` package; defers to the implementation plan and the shipped `auth.admin` handle |
| `docs/tech-design/BB-auth-cognito-admin-implementation-plan.md` | authoritative plan for the admin surface, incl. the `AuthCognito<O>` variance analysis |
| `docs/native-clients/codegen-design.md:47`, `:71-72`, `:126`, `:139-146`, `:157`, `:253`, `:255` | uses `authSignIn`/`AuthState` as the running codegen example |
| `docs/native-clients/schema-generation-guide-for-devs.md:153-209` | `setAuthState`/`AuthActionInput`/`AuthActionPayloadMap` is the canonical worked example for discriminated-union parameter narrowing; `:187` points at `packages/auth-common/src/ui.ts` "for the live pattern"; `:205-209` at `auth.createApi()` |
| `docs/design/API-DESIGN.md:39` | table row `Server-only \| … \| KVStore, AuthCognito` |
| `docs/design/API-DESIGN.md:100` | "auth failures" as the example of a genuine throw (vs not-found) |
| `docs/design/API-DESIGN.md:397-399` | naming table: `require*` → `auth.requireAuth(context)`, `auth.requireRole(context,'admin')`; `check*` → `auth.checkAuth`; `getCurrent*` → `auth.getCurrentUser` |
| `docs/design/API-DESIGN.md:592-610` | documents the `BB.createApi()` convention using `AuthBasic`/`authApi` as the paradigm case |
| `docs/design/scaffold-new-bb.md:47` | classifies `bb-auth-basic` as the reference "Composite (composes other BBs, no own infra)" shape — single `index.ts`+`errors.ts`+`version.ts`(+browser stub), `browser`/`types`/`default` only |
| `docs/guides/extending-with-existing-aws-resources.md:43`, `:234` | `AuthCognito.fromExisting(userPoolId, clientId?)` adoption path |
| `docs/reference/building-block-structure.md:130-143`, `docs/reference/ARCHITECTURE-LAYERS.md:183-218` | use a **fictional** `Auth` class (`new Auth(...)`, `this.auth.requireUser(context)`) as a generic composite-BB illustration — pedagogical stand-ins, **not** the real BBs. `requireUser` is not a real method name anywhere |
| `docs/SUPABASE-E2E.md` | Supabase's own auth (`auth.uid()`), unrelated except as the migration source for `bb-data`'s db-pull → `AuthOIDC` guidance |

### 4.11 Root files

- `package.json` `workspaces[]` includes all four auth packages (plus `packages/blocks` and every
  test-app above).
- **`tsconfig.json` `references[]` (L3-19, 15 entries) lists `packages/auth-common` (L11) and
  `packages/bb-auth-basic` (L12) but NOT `packages/bb-auth-cognito` or `packages/bb-auth-oidc`.**
  (It also omits `bb-cron-job`, `bb-lambda-compute`, `bb-dashboard`, `bb-tracer`, `bb-metrics`,
  `bb-logger`, `bb-async-job`, `bb-distributed-data`, `create-block`, `create-blocks-app`.) A
  refactor that relies on `tsc --build` from the repo root to surface breakage will **silently miss
  type errors in the two largest auth packages**. Verify how CI actually builds them
  (`npm run build` → workspace fan-out, not the root project reference) before trusting a green root build.
- `.changeset/` — **no pending changeset touches any of the four auth packages.** The only
  auth-adjacent one is `agents-md-frontload-knowledge.md` (`@aws-blocks/create-blocks-app: patch`),
  which front-loads "auth via `requireAuth` + the `@aws-blocks/blocks/ui` components" into the
  scaffolded `AGENTS.md`.
- `AGENTS.md` (root) — `:26` rule 9 ("gate inside each method with `await auth.requireAuth(context)`");
  `:62` glossary row for `auth.requireAuth`; `:70-79` the consume-a-BB mental model uses `AuthBasic`
  verbatim; `:103`, `:110` cite `bb-auth-basic` as the reference for the "auth / composed from other
  BBs" shape and for the single-`index.ts` pattern; `:209` "Auth BBs lead with `Auth`".
- **`scripts/generate-bb-names.mjs:29-33`** hardcodes the override `{'AuthOIDC': 'AuthOidc'}` because
  "the vendorize map uses class export names … but telemetry needs runtime `bbName` values". This is
  the **only** place the `AuthOIDC`-class/`AuthOidc`-telemetry case mismatch is reconciled; a rename
  that misses it silently breaks OIDC telemetry attribution.
- `packages/bb-app-setting/src/secrets-bulk.ts:10` — comment naming "`bb-auth-oidc`'s
  IdP-registration custom resource" as a consumer of bulk-secret writes (a real cross-BB coupling:
  `bb-auth-oidc/src/index.cdk.ts:340-341` depends on `SECRETS_BULK_CONSTRUCT_ID`).

### 4.12 Indirect / surprising consumers

- **`packages/bb-data`'s db-pull generator emits auth code as strings.**
  `packages/bb-data/src/db-pull/templates.ts:181-215`, `:324-326` and `pull.ts:325-328` generate
  scaffolded app code and a `MIGRATION_GUIDE.md` "## Auth" section instructing users to
  `import { AuthOIDC, google } from '@aws-blocks/bb-auth-oidc'` and wire it into
  `supabaseCrud(context, auth)`. `db-pull.test.ts:126-129`, `:282-286` assert the generated CRUD
  helper never imports `@aws-blocks/bb-auth*` and that the doc example names `AuthOIDC` (not
  `AuthCognito`). **Any rename of `AuthOIDC` / `bb-auth-oidc` must also update these string
  templates**, or generated migration guides will reference a broken import.
- `packages/bb-kv-store/src/user-agent.test.ts:26-173` simulates a parent scope with
  `bbName: 'AuthBasic'` purely as a nesting fixture.
- `packages/bb-knowledge-base/src/index.cdk.test.ts:184` and
  `packages/bb-distributed-data/src/index.cdk.test.ts:6` cite `bb-auth-cognito`'s CDK test structure
  as prior art (comments only, no import).
- `test-apps/comprehensive/test/sandbox-admin-e2e.ts:96-97` walks CDK stack resources to find the
  UserPool/Client **because `bb-auth-cognito` emits no `CfnOutput`s** — a real integration seam.
- `test-apps/comprehensive/aws-blocks/knowledge/faq/general.md:17` describes AuthBasic as RAG
  fixture content.

---

## 5. In-flight auth work on other branches

All nine named branches exist as `origin/<branch>`. The worktree branch `refactor/auth-blocks` has
**no divergent commits** from `main` yet. **Five of the nine are already merged** — their remote refs
are stale leftovers and `git diff main...origin/<branch>` is misleading for them (squash-merges and,
in one case, a rename). Merged status was verified by content inspection (`git show main:<path>`),
not by diff alone.

### 5.1 Genuinely in flight (4)

| Branch | PR | Commits | Diff | What it changes | Conflicts with unification? |
|---|---|---|---|---|---|
| **`feat/bb-auth-jwt`** | #297, **draft** | 12 (`88e8c100`, `3e5fb3c6`, `9b915bf3`, `bc816677`, `d5f43ccb`, `6ca223a3`, `3bcb571e`, `dac9ae75`, `ef8311be`, +3 merges, `55d6ed91`) | 27 files, **+1541/−1** | A **new 4th official auth BB**: `@aws-blocks/bb-auth-jwt`, class `AuthBearerJwt extends Scope implements BlocksAuth`. Stateless bearer-JWT verifier — no session store, no sign-in flow, for apps where sign-in is owned by a third-party IdP. New public API: `AuthBearerJwt`, `AuthBearerJwtOptions` (`issuer`, `jwks \| hmacSecret`, `audience`, `requiredClaims`, `subjectClaim`, `mapUser`, `jwksCacheMaxAge`, `clockTolerance`, `logger`), `AuthBearerUser extends AuthUser { claims }`, `AuthBearerJwtErrors`, `SecretLike`, plus a `./mock` entry exporting `createLocalJwt`. Files: `packages/bb-auth-jwt/**` (new), `packages/blocks/src/index.ts`, `index.cdk.ts`, `package.json`, `API.md`, `README.md`, `packages/core/src/common/official-bb-names.generated.ts` (+`'AuthBearerJwt'`), `test-apps/comprehensive/aws-blocks/index.ts` + `test/bearer-jwt-auth.test.ts` + `test/e2e.test.ts`, `.changeset/add-bb-auth-jwt.md`, root `package.json` | **HIGH relevance, LOW mechanical risk.** Already conforms to `BlocksAuth`. Textual conflicts likely in the umbrella export blocks (`packages/blocks/src/index.ts`, `index.cdk.ts`, `package.json`) and `official-bb-names.generated.ts`. **Coordinate before changing `BlocksAuth` itself.** |
| **`fix/auth-cognito-requirerole-live-groups`** | #583, **open** (newest, 2026-09-21) | 2 (`37a2a32c`, `945e7b05`) | 10 files, **+179/−10** | Bug fix: `requireRole` authorized against the **stale** `cognito:groups` claim from the session token, so `admin.addUserToGroup`/`removeUserFromGroup` had no effect until token refresh. Now reads live membership — AWS runtime calls paginated `AdminListGroupsForUser` via a new private `liveGroupsForUser()`; mock reads `this.state.groups`. Also grants `cognito-idp:AdminListGroupsForUser` **unconditionally** (previously gated behind the opt-in `admin` surface) and updates the CDK least-privilege baseline. Files: `bb-auth-cognito/src/{index.aws.ts, index.ts, index.cdk.ts, admin.test.ts, index.cdk.test.ts}`, `DESIGN.md`, `README.md`, `.changeset/*`, `test-apps/comprehensive/{aws-blocks/index.ts, test/auth-cognito-admin-sandbox.test.ts}` | **MEDIUM.** Direct conflict at `requireRole` in both `index.ts:1286` and `index.aws.ts:1605`, and at `CognitoUser<O>.groups` semantics (live vs cached). Also touches `index.cdk.ts` IAM wiring. **Note: this contradicts `bb-auth-cognito/DESIGN.md:142`**, which documents the stale-claim read as an intentional decision — the design doc will need updating. |
| **`fix/auth-reactivity-185`** | #208, **open** (oldest, 2026-07-15) | 11 (`a21b5629`, `a15e501f`, `3dd8205e`, `802bc6a4` + 7 merge-from-main) | 7 files, **+256/−34** | Fixes issue #185: hand-rolled custom auth UIs calling `setAuthState` directly never triggered `onAuthChange`/`AuthenticatedContent` re-renders (only the built-in `Authenticator` did, via a manual 3-step sequence at ~4 call sites). Adds a new browser-only export **`submitAuthAction(api: AuthStateApi, input: AuthActionInput): Promise<AuthState>`** that owns RPC-call → cache-update → conditional broadcast (only on real signedIn/signedOut transitions, not mid-flow challenge states), and refactors `Authenticator`, `renderState`, `renderInternalAction`, `AccountMenuBar` onto it. Files: `packages/auth-common/src/ui.ts` (+84), `src/ui.test.ts` (+136), `CUSTOMIZING-AUTH-UI.md`, `README.md`, `packages/blocks/src/ui.ts`, 2 changesets. Confirmed absent from `main` | **HIGH for any client-side UI work.** Same file/lines as anything that generalizes `auth-common/src/ui.ts` for a new provider. `packages/blocks/src/ui.ts` is a shared conflict point with `feat/bb-auth-jwt`. A unification refactor should rebase onto `submitAuthAction` once #208 lands. |
| **`supabase-auth-poc`** | **no PR** (pure spike) | 2 (`1a7d179a`, `23455964`) | 18 files, **+1464/−1** | A **PoC 4th provider**: `@aws-blocks/bb-auth-supabase`, `class AuthSupabase extends Scope implements BlocksAuth`. Stateless — verifies a Supabase access token locally via `jose`, no round-trip. Same `requireAuth`/`checkAuth`/`getCurrentUser` trio **plus `requireRole(context, role)`** (Supabase `role` claim) which is not on `BlocksAuth`. Handles both Supabase JWT eras (asymmetric ES256/RS256 via JWKS; legacy HS256 via an `AppSetting` SSM SecureString or inline `jwtSecret`). New symbols: `AuthSupabase`, `AuthSupabaseOptions` (`supabaseUrl`, `audience`, `jwtSecret`), `SupabaseUser`/`SupabaseClaims`, `AuthSupabaseErrors`, `createSupabaseVerifier()`, `supabaseAuthHeader`. **Not wired into `packages/blocks` or `official-bb-names.generated.ts`** — only root `workspaces` + `build:packages` | **LOW mechanical, HIGH design.** Isolated package. It **independently re-derives the same `BlocksAuth` shape** as `feat/bb-auth-jwt` — strong evidence the existing interface generalizes across session-based and stateless providers. Its divergence from `bb-auth-jwt` (`getCurrentUser` never throws and swallows some errors, vs stricter propagation) is useful comparison material. Root `package.json` `build:packages` line is a shared-edit point. Note: `auth-common/src/ui.ts:344-345` **already mentions `bb-auth-supabase`** in a JSDoc rationale — the PoC is already leaking into shipped docs. |

### 5.2 Already merged — stale refs, no action (5)

| Branch | PR | Merged | What it was | Verification |
|---|---|---|---|---|
| `fix/cognito-prevent-user-enumeration` | #293 | 2026-08-05, merge `7b3bb069` | Sets Cognito's `PreventUserExistenceErrors` to close a username-enumeration oracle | `main:packages/bb-auth-cognito/src/index.cdk.ts` already contains `preventUserExistenceErrors: true` |
| `fix/oidc-signin-shared-state` | #285 | 2026-07-30 | **Test-app only.** `test-apps/comprehensive` used one shared in-module variable for "most recent OIDC sign-in", racing across concurrent test users; keyed records by `userId` per instance | `main:test-apps/comprehensive/aws-blocks/index.ts` already has `SignInRecord` / `signInKey(instance, userId)` |
| `fix/bb-auth-oidc-stub-idp-reserved-params` | **#354, opened from a differently-named branch `fix/stub-idp-redirect-uri-validation`** | 2026-08-13 | Stub IdP now rejects `redirect_uri`s carrying reserved OAuth/OIDC response params (`scope`, `code`, `state`, `error`, `access_token`, …), matching Google, so mock tests don't false-green | `main:packages/bb-auth-oidc/src/engines/stub-idp.ts` already has `RESERVED_RESPONSE_PARAMS` + `redirectUriRejectionReason`. ⚠️ This ref's history also carries an unrelated `bb-async-job` commit (`d4ef9646`), so a literal `git log`/`git diff` on it is noisy |
| `fix/auth-cognito-vendorize-script` | #314 | 2026-08-06 | Adds the missing `vendorize` npm script to the `create-blocks-app` `auth-cognito` template | `main:packages/create-blocks-app/templates/auth-cognito/package.json` already has `"vendorize": "blocks-vendorize"` |
| `fix/authenticator-test-ids` | #272 | 2026-07-28 | Adds stable `data-testid` hooks to `Authenticator`/`AccountMenuBar`/`AuthenticatedContent` | `main:packages/auth-common/src/ui.ts` has 20 `data-testid` sites. **Note for the refactor:** these values are now a de-facto public DOM contract (documented in `CUSTOMIZING-AUTH-UI.md:202-261` and `auth-common/src/ui.ts:460-466` — "treat the names as public API"). Preserve or deliberately version them |

### 5.3 Conflict hotspots (ranked)

1. **`packages/auth-common/src/ui.ts`** — `fix/auth-reactivity-185` (open, +84/−? in this one file)
   and the already-landed `data-testid` contract.
2. **Umbrella export blocks** — `packages/blocks/src/index.ts`, `index.cdk.ts`, `src/ui.ts`,
   `package.json`, and `packages/core/src/common/official-bb-names.generated.ts`: actively edited by
   `feat/bb-auth-jwt` (draft #297).
3. **`packages/bb-auth-cognito/src/index.ts` + `index.aws.ts` at `requireRole`** —
   `fix/auth-cognito-requirerole-live-groups` (open #583).
4. Root `package.json` (`workspaces` / `build:packages`) — touched additively by both
   `feat/bb-auth-jwt` and `supabase-auth-poc`.

### 5.4 The design signal

Two independent, unmerged efforts (`feat/bb-auth-jwt`, `supabase-auth-poc`) each converged on the
same `BlocksAuth` shape for **stateless, sign-in-less** providers — and both added `requireRole` or
its equivalent above the interface. That is a strong existence proof that the 3-method
`BlocksAuth` contract generalizes; it is also evidence that **`requireRole` belongs on the shared
interface** (3 of 5 provider implementations — Cognito, Supabase-PoC, and arguably JWT via
`requiredClaims` — need role/claim gating, and today each invents its own).

---

## 6. Test inventory

### 6.1 How tests run

Root `package.json`:
- `test` and `test:unit` are **identical**: `npm run test --workspaces`
- `test:e2e:local` → `cd test-apps/comprehensive && npm run test:e2e:local`
  (→ `BLOCKS_TEST_ENV=local tsx -C browser test/e2e.test.ts`) then `npm run test:vendorize`
- `test:e2e:sandbox` / `test:e2e:production` → same with `BLOCKS_TEST_ENV=sandbox|production`
- `test:all` = unit + e2e:local + e2e:sandbox + e2e:production; `test:dev` = unit + local + sandbox

Per-package (all Node's built-in runner, against compiled `dist/`, never `src/`):

| Package | `test` script |
|---|---|
| `auth-common` | `node --test dist/**/*.test.js` |
| `bb-auth-basic` | `node --test dist/**/*.test.js` |
| `bb-auth-cognito` | `node --test --test-concurrency=1 dist/**/*.test.js` (serialized — shared `.bb-data` file store + real-pool provisioning) |
| `bb-auth-oidc` | `pretest: npm run build:lambda`; `node --test --test-concurrency=1 dist/**/*.test.js` |
| `blocks` | `node --test dist/conditional-exports.test.js dist/vendorize-map.test.js && node --conditions=cdk --test dist/umbrella-compute.test.js` |

> ⚠️ **`*.types-test.ts` files are never executed.** The glob `dist/**/*.test.js` does not match
> `*.types-test.js` (suffix `-test.js`, not `.test.js`). They are only type-checked by `tsc --build`
> via `tsconfig.json`'s `include: ["src/**/*"]` — "the compile is the test". A `@ts-expect-error`
> that stops erroring breaks the **build**, not a test run. Combined with §4.11's finding that the
> **root `tsconfig.json` does not reference `bb-auth-cognito` or `bb-auth-oidc`**, this means the
> four Cognito types-test files are only exercised if CI builds those workspaces individually.
> **Verify this before trusting types-test coverage in a refactor.**

> ⚠️ **By default, every real-AWS auth test in the repo is skipped.** `npm test` runs only
> mock-runtime units, cdk-synth suites, and types-test compiles. Real coverage needs
> `BLOCKS_INTEGRATION=1` (package-level) or `BLOCKS_TEST_ENV=sandbox|production` + pool-id env vars
> (app-level). There is no root script that sets `BLOCKS_INTEGRATION=1`.

### 6.2 `packages/auth-common`

| File | Lines | Class | Suites / tests | Locks in |
|---|---|---|---|---|
| `src/cookies.test.ts` | 134 | unit | `resolveCookieSecurity` (:16, :23, :30, :37 — 4), `buildCookieSecurityAttrs` (:48, :55, :62, :69 — 4), `isLoopbackRequest` (:86–:106 — 6), **`cross-BB parity`** (:124 — 4 parametrized) | SameSite/Secure/Partitioned rules for every auth BB's cookie. **The "parity" describe is NOT mock↔AWS parity** — it asserts the string builder (used by basic/cognito) and the attribute-object resolver (used by oidc) agree byte-for-byte |
| `src/ui.test.ts` | 925 | unit (happy-dom) | **69 tests / 5 describes**: `Authenticator` (:108 — 21: form rendering, `setAuthState` wiring, signed-in view, error display, external-action HTML forms + hidden fields, `hideActions`, heading/label/placeholder/autocomplete overrides, field hidden/order/hint/render slots, action render slot, WebAuthn `navigator.credentials.get` auto-submit, warm-cache synchronous paint / no-flash); `AuthenticatedContent` (:545 — 5); `onAuthChange` (:614 — 8: sync emission from warm cache, resilience to a rejected `getAuthState`, retry-after-reject, cross-tab broadcast, unsubscribe); `test hooks` (:758 — 10: hook addressability + uniqueness + provider-suffixed action names) | The whole declarative Authenticator contract: `data-testid` hook stability, no-flash guarantee, external-action form shape, WebAuthn submission |
| `src/ui.types-test.ts` | 64 | **types-only** | no `describe`/`test`; `positive()` exercises every valid `setAuthState` shape incl. 4 `confirmSignIn` challenge branches; `negative()` has **7 `@ts-expect-error`** lines (missing password, missing code, password on `resetPassword`, missing code+newPassword, missing session, wrong key `pwd`, unknown action) | The `setAuthState` discriminated-union contract every BB implements |

### 6.3 `packages/bb-auth-basic`

| File | Lines | Class | Suites / tests | Locks in |
|---|---|---|---|---|
| `src/cookies.test.ts` | 87 | unit | `AuthBasic session cookie` (:33, :47, :57, :68, :79 — 5): Lax+Secure default, no Secure on localhost, `crossDomain` → None/Secure/Partitioned, crossDomain-on-localhost, `signOut` clears with matching attributes | AuthBasic's cookie defaults mirror the shared policy |
| `src/index.browser.test.ts` | 21 | unit | `AuthBasic browser entry` (:13 — 1): browser entry exports error constants **without importing the server entry** | Bundle hygiene — no server code in browser bundles |
| `src/index.test.ts` | 123 | unit | `AuthBasic setAuthState errorName` (:46, :58, :69 — 3): unknown-user and wrong-password → `errorName = InvalidCredentials`; generic `ApiError` with no structured name → **no** `errorName` (issue #81 regression). `AuthBasic telemetry registration` (:99, :103, :108, :114 — 4): `BB_NAME` matches vendorize map + `OFFICIAL_BB_NAMES`, `BB_VERSION` tracks package version, instance carries `bbName`/`bbVersion`, registers as official | `errorName` propagation (the `hasAuthError` path) + telemetry self-identification |

**No parity test, and structurally none is possible** — one backend, no `index.aws.ts`, no
`aws-runtime` export condition. Confirmed: `src/` contains only `cookies.test.ts`, `errors.ts`,
`index.browser.test.ts`, `index.browser.ts`, `index.test.ts`, `index.ts`, `version.ts`.
**If a refactor gives `AuthBasic` a second backend there is no parity-test pattern in this package to
copy — only `bb-auth-cognito`'s.**

### 6.4 `packages/bb-auth-cognito` (largest, most stratified)

| File | Lines | Class | Suites / tests | Locks in |
|---|---|---|---|---|
| `src/index.test.ts` | 1111 | unit (mock) | **69 tests / 13 describes**, `.bb-data` cleaned per test: signUp/confirmSignUp/resendSignUpCode (:76 — 6), `status` discriminator (:147 — 1), signIn/signOut/getCurrentUser/requireAuth/checkAuth (:203 — 7), fetchAuthSession (:285 — 4), MFA + confirmSignIn (:347 — 7), update/fetchMFAPreference (:510 — 8: PREFERRED demotion, NOMFA sentinel, double-PREFERRED rejection, `SoftwareTokenMFANotFound`, factor-not-in-pool), profile (:631 — 8), resetPassword (:710 — 3), devices (:750 — 2), createApi namespace (:785 — 1), `authFlowType` runtime guard (:798 — 4: USER_PASSWORD_AUTH/USER_AUTH accepted; USER_SRP_AUTH/CUSTOM_AUTH throw), USER_AUTH flow (:824 — 6), Passkeys (:937 — 10) | The entire mock behavioral surface incl. the exact `errorName` strings clients branch on |
| `src/index.aws.test.ts` | 88 | unit (pure fn) | `extractUserAttributes (JWT allow-shape)` (:8 — 6): passes standard OIDC attrs + `custom:`, drops `cognito:`-prefixed, drops reserved JWT/lifecycle claims, drops non-string values, auto-allows a new standard attr | Security-relevant claim filter — must not leak internal Cognito/JWT claims as user attributes. **The only test of `index.aws.ts` (2465 L) that runs by default** |
| `src/index.cdk.test.ts` | 729 | **cdk-synth** | **53 tests / 11 describes**: user pool (:121), client (:194), `UserPoolDomain` (:234), groups (:245), session store (:271), **createApi sentinel** (:307 — locks the `Symbol.for('blocks:ApiNamespace')` shape at `index.cdk.ts:318`), authFlowType guard (:321), signInWith (:341), featurePlan (:468), enablePasskeys (:522), admin IAM grant (:679) | Synthesized CFN shape + IAM least privilege |
| `src/admin.test.ts` | 256 | unit (mock) | **22 tests / 4 describes**: runtime gate (:63 — 2), group membership (:79 — 5), user lifecycle (:131 — 8), **action-scope runtime gate "Gap 3"** (:213 — 4: groups-only pool fast-fails a lifecycle call and vice versa) | The opt-in `auth.admin` action-scoping guard (security-relevant) |
| `src/admin.types-test.ts` | 150 | **types-only** | compile-only positive/negative for the admin action-scoping gate | Type-level mirror of the runtime gate |
| `src/confirmSignIn.types-test.ts` | 58 | **types-only** | negative tests for `confirmSignIn`'s discriminated overloads | — |
| `src/fetchAuthSession.types-test.ts` | 93 | **types-only** | negative tests for JWT-payload narrowing + `forgetDevice`'s required `deviceKey` | — |
| `src/types.types-test.ts` | 108 | **types-only** | negative tests for `AuthCognito`'s generic surface (explicit note: prefer deleting a test over `@ts-expect-error`-ing it) | — |
| `src/cookies.test.ts` | 179 | unit | **23 tests / 4 describes**: `signSessionId`+`verifySessionId` (:28 — 6: round trip, tampered sig / tampered id / wrong secret / no separator rejection, base64url), `setSessionCookie` (:64 — 5), `clearSessionCookie` (:124 — 1), `readSessionCookie` (:137 — 6 incl. **suffix-collision isolation** :158 and **metacharacter-safety** :166, :173) | Session-id HMAC + cookie-name isolation — regex-injection-style guard so a maliciously named sibling cookie can't be read as the session cookie |
| `src/sessions.test.ts` | 260 | unit | **25 tests / 3 describes**: `safeStringClaim` (:12), `safeStringArrayClaim` (:42), `SessionStore TTL` (:148) | JWT claim coercion guards + session expiry |
| `src/state-machine.test.ts` | 477 | unit | **56 tests / 12 describes**: `isStandardAttribute` (:25), `signedOut` (:42, nested `signInWith` threading :100), `confirmingSignUp` (:174), `confirmingSignIn` (:199), `signedIn` (:358), `confirmingPasswordReset` (:371), `signedOut + enablePasskeys` (:387), `signedIn + enablePasskeys` (:404), `CONFIRM_SIGN_IN_WITH_WEB_AUTHN` (:420), `registeringPasskey` (:441), `managingPasskeys` (:454) | The exact `AuthField[]` descriptors the Authenticator renders per state |
| `src/scenarios.mock.test.ts` | 390 | **parity (mock half)** | `scenarios.mock` (:62) — "16 scenarios across USER_PASSWORD_AUTH + USER_AUTH × mfa modes"; header names `scenarios.sandbox.test.ts` as the mirror suite. Uses `./index.js` | **The only genuine mock↔AWS parity pair in the auth family** |
| `src/scenarios.sandbox.test.ts` | 592 | **sandbox-e2e, skipped by default** | `ENABLED = process.env.BLOCKS_INTEGRATION === '1'`; 7 describes all `{ skip: !ENABLED }`: Pool A mfa:off (:77), B optional (:119), C required/TOTP (:167), D required/EMAIL (:207), E required/TOTP+EMAIL (:259), F optional/SMS+TOTP (:356), G USER_AUTH (:454). 23 tests. Uses `./index.aws.js` + provisions real pools | Real-Cognito parity for the same 16 scenarios — divergence here means the mock lies |
| `src/scenarios.passwordless-demo.test.ts` | 317 | unit (mock) | 7 tests / 2 describes: passwordless USER_AUTH + EMAIL_OTP (:115), default `signInWith` auto-collects email at sign-up (:261) | The demo/template config matches actual mock behavior |
| `src/scenarios.passwordless-demo.sandbox.test.ts` | 248 | **sandbox-e2e, skipped** | 1 describe (:123), `{ skip: !ENABLED }` on the same gate | Real-Cognito counterpart (second, narrower parity pair) |
| `src/user-auth-integration.test.ts` | 529 | **sandbox-e2e, skipped** | 17 tests / 8 describes, `{ skip: !ENABLED }` + a second gate `CUSTOMER_SES_ENABLED` (`BLOCKS_INTEGRATION_CUSTOMER_SES`): MFA_SETUP TOTP (:104), enrolled TOTP (:136), enrolled SMS w/ capture sender (:199), enrolled EMAIL (:249), SELECT_MFA_TYPE (:290), NEW_PASSWORD_REQUIRED (:379), USER_AUTH (:415), customer-SES shape-only regression (:485) | The strongest guarantee in the suite: real OTP **delivery + verification** via a custom-sender capture Lambda (decrypts the KMS-encrypted OTP into DynamoDB so the test reads the real code) |

**Test-support infrastructure** (`src/test-support/`):
- `test-pool-fixture.ts` — `setupTestPool()` / `cleanup()` / `createConfirmedUser` /
  `setMfaPreference`; provisions a throwaway real User Pool + client per suite. Two delivery modes:
  `'custom-sender'` (default) or `'customer-ses-sns'` (shape-only assertions).
- `custom-sender-harness.ts` — `setupCustomSender(pool)`: provisions KMS key + IAM role + DynamoDB
  capture table + Lambda (attached as Cognito's `CustomSMSSender`/`CustomEmailSender`); returns
  `captureCode(username, purpose)` + `teardown`.
- `zip.ts` — hand-rolled minimal PKZIP builder (stored entries) to package the inlined Lambda source
  for `CreateFunction.Code.ZipFile` without a dev-dep.
- `totp.ts` — minimal RFC-6238 `totpNow` so TOTP tests compute live codes from the `sharedSecret`.
- `sender-lambda-source.js` — the inlined capture-Lambda source.
- `README.md` — documents the two-tier delivery strategy, the broad IAM permissions required
  (KMS/IAM/Lambda/DDB create+delete, `cognito-idp:*`), and the invocation
  `BLOCKS_INTEGRATION=1 AWS_PROFILE=<profile> node --test dist/user-auth-integration.test.js`.

**Manual scripts** (`scripts/`): `deploy-manual-test-pools.mjs` stands up all 7 scenario pools (A–G)
and writes a manifest; `teardown-manual-test-pools.mjs` reverses it; `README.md` documents each
pool's config, seeded users, and purpose keys.

### 6.5 `packages/bb-auth-oidc`

| File | Lines | Class | Suites / tests | Locks in |
|---|---|---|---|---|
| `src/index.test.ts` | 1289 | unit (mock + stub-IdP HTTP + JWT crypto) | **~75 tests / ~16 describes**: `computeCallbackUrl` public origin (:54), `cognitoFederated` in mock fails fast (:81), `buildExchangeUrl` (:115), `stubIssuerUrl` gateway origin (:143), **construction validation** (:178 — 14: missing/duplicate providers, malformed configs, `/aws-blocks/auth/` path-prefix enforcement), **stub IdP `/authorize`** (:378 — 17 incl. reserved-query-param rejection, `redirect_uri` validation, custom `users.json` dir), provider helpers (:629), `requireAuth`/`checkAuth`/`getCurrentUser` without session (:685), `createApi` (:732), path configuration (:749), `AuthOIDCErrors` (:799), `allowBearerAuth` (:810), **`verifyAccessToken` signature verification** (:852 — 6 incl. forged-signature + expired), **Cognito issuer cross-pool rejection** (:1030 — 4), **`alg:none` rejection** (:1157 — 2) | **The highest-stakes tests in the family** — JWT signature / issuer / expiry / `alg:none` regressions are auth bypasses, not UX bugs |
| `src/index.browser.test.ts` | 686 | unit (browser client) | **~28 tests / 9 describes**: `resolveApiBaseOrigin` (:128), `signIn` redirect_uri construction (:146), `signIn` error propagation (:184), `handleRedirectCallback` return shape (:223), **idempotency under double invocation** (:318 — concurrent + sequential share one exchange, guard released after settling, error-path parity), `auth-common` bridge same-window + cross-tab (:473), `signOut` bridge (:548), `signOut` server-side no-window (:591), `handle401` documented pattern (:658) | Idempotent redirect-callback handling (a real browser race), cross-tab broadcast, the `handle401` contract customers wire into fetch interceptors |
| `src/index.cdk.test.ts` | 222 | **cdk-synth** | 9 tests: issue #447 regression (no native IdP resource, no `ssm-secure` ref leak), custom-resource IdP registration names SSM params rather than embedding secrets, BulkSecrets dependency ordering, Lambda IAM grants (`cognito-idp`, `ssm:GetParameter`, scoped `kms:Decrypt`), self-hosted provider emits no Cognito resources, per-provider-type CFN mapping (Facebook / LoginWithAmazon / custom OIDC), duplicate `identityProvider` name fails synth | Synth shape + secret-handling hygiene |
| `src/relay.test.ts` | 113 | unit | **17 tests / 2 describes**: `relayOrigin` constructor (:10 — custom-scheme/HTTPS authority validation; rejects paths, queries, userinfo, bare localhost, empty), `validateRelay` (:40 — loopback allowed without allowlist, custom-scheme allowlist matching, malformed / plaintext-non-loopback / unknown-origin rejection) | Native-client (mobile) relay redirect security |
| `src/state.test.ts` | 56 | unit | 7 tests, `state envelope` (:15): signed round trip, canonical encoding, tampered-body / wrong-secret / unknown-version / malformed rejection | CSRF `state`-param integrity for the redirect flow |
| `src/idp-registration-lambda.test.ts` | 139 | unit | 7 tests: Create/Update/Delete custom-resource handler + `readSecret` retry/terminal-error (`ParameterNotFound`, needed because BulkSecrets provisioning is eventually consistent) | Deploy-time IdP registration |

**`bb-auth-oidc` has no mock↔AWS parity suite** — the shared `auth-oidc.ts` base class plus the
`AuthEngine` seam is its structural answer to parity, but there is no test that asserts
`OidcClientEngine`-under-mock and `-under-aws` behave identically.

### 6.6 `packages/blocks/src/conditional-exports.test.ts`

87 lines. **Dynamically generated** — `discoverBBPackages()` (:27-38) finds every `packages/bb-*`
whose `exports["."]` has an `aws-runtime` condition, then emits one
`test('${pkg}: aws-runtime exports match default')` (:84) per package, actually `import`ing each
entry under `node --conditions` and diffing `Object.keys()` (:83-87). Plus
`test('umbrella: cdk exports match default')` (:68-70) and a discovery sanity check (:76, ≥8 packages).

- ✅ covers `bb-auth-cognito`, `bb-auth-oidc`
- ❌ **does not cover `bb-auth-basic`** (no `aws-runtime` condition — correct, it has one backend)
- ❌ **does not cover `auth-common` at all** — no `bb-` prefix, so discovery never sees it; its three
  subpaths (`.`, `./ui`, `./cookies`) have no export-parity gate whatsoever
- ⚠️ The check is `aws-runtime ⊇ default`, so the parity gaps found in §1.3/§1.4 (e.g.
  `extractUserAttributes` exported only from `index.aws.ts`; `OIDCClient` only from
  `index.mock.ts`; `SessionStore` missing from cdk/browser) are **not** all caught: a superset in
  `aws-runtime` passes, and `browser`/`cdk` are only checked for the umbrella, not per-BB.

### 6.7 `test-apps/comprehensive` — app-level e2e

All aggregated by `test/e2e.test.ts`, which type-checks the backend, spawns a real local dev server
(or targets a deployed stack per `BLOCKS_TEST_ENV`), and runs each suite over real HTTP with a
cookie jar. `test/e2e.test.ts:210-225` routes to the auth files.

| File | Lines | Gate | Content |
|---|---|---|---|
| `test/basic-auth.test.ts` | 396 | **none — always runs** | ~26 tests, `AuthBasic` (:26) with nested signUp (:30), signIn (:100), session (:142), password reset (:221), **verification-code read-back** (:302 — 4 regression guards: codes readable from shared state not process memory, per-user keyed not a shared "latest" pointer, unknown-username → null, exactly-one-record-written) |
| `test/auth-cookie-attrs.test.ts` | 104 | none | 2 tests, `AuthBasic cookie attributes (D-007)` (:70): same-origin default + `crossDomain` opt-in, asserted on real HTTP `Set-Cookie` headers |
| `test/auth-cognito.test.ts` | 659 | `{ skip: !isLocal && '…needs a mailbox…' }` — **mock backend only** | ~40 tests, `AuthCognito` (:68) nested: signUp (:71), signIn+session (:111), profile (:177), requireRole (:257), resendSignUpCode (:291), resetPassword (:311), fetchAuthSession (:345), confirmSignIn (:380), destructive+idempotent (:398), devices "[mock-only]" (:431), updateMFAPreference per-factor Amplify-v6 shape (:481 — 9), fetchUserAttributes (:638) |
| `test/auth-cognito-sandbox.test.ts` | 338 | `{ skip: !isSandbox \|\| !COGNITO_POOL_ID }` (needs `TEST_AUTHC_POOL_ID`) | `AuthCognito Sandbox` (:109): signIn admin-created (:112), requireRole (:169), fetchAuthSession (:210), deleteUser (:235), devices (:256 — documents that **`rememberDevice` throws 501 with a `NewDeviceMetadata` message on real AWS**, a divergence the mock does not have). `AuthCognito MFA Sandbox` (:286, needs `TEST_AUTHC_MFA_POOL_ID`): TOTP round trip (:287), "updateMFAPreference rejects EMAIL without SES" (:314) |
| `test/auth-cognito-admin-sandbox.test.ts` | 153 | `{ skip: !isSandbox }` | 7 tests (:30): `admin.createUser`→`setUserPassword`→`signIn`, `addUserToGroup`→`requireRole` on a fresh token, `revokeUserSessions` revokes real refresh tokens, `disableUser`/`enableUser`, `deleteUser`, `getUser` round-trips custom attr + group, `scan` startsWith filter |
| `test/oidc-auth.test.ts` | 1350 | none | **largest e2e file, ~45 tests / ~20 describes**: provider listing, unauthenticated guards, sign-in redirects (google + custom "corporate"), `onSignIn` hook incl. per-user/per-instance keying regressions, `userId` format, createApi state machine, callback error handling, signOut, stub-IdP discovery/JWKS/authorize, profile upsert (no duplicate on second sign-in), client-initiated PKCE exchange, bearer-token auth + refresh 401/400, and **`relay flow (native clients)`** (:880 — 13 tests: full custom-scheme mobile round trip, loopback exemption, `appState` round-trip, **wire-shape assertion that the `redirect_uri` sent to the real IdP is always the backend HTTPS URL and never the relay URI**, plus unknown-origin / plaintext-non-loopback / malformed-URI / tampered-state / wrong-code negatives) |
| `test/poll-for-signin.ts` | — | helper | shared OIDC sign-in poller |
| `test/sandbox-admin-e2e.ts` | — | helper | walks CDK stack resources to find the UserPool/Client because **`bb-auth-cognito` emits no `CfnOutput`s** (`:96-97`) |

### 6.8 Auth tests elsewhere

**`packages/core`:**
- `src/server/withAuth.test.ts` (348 L, ~20 tests / 2 describes) — `withAuth` (:19: forwards
  explicit cookies, reuses an existing ALS context, throws when no cookies and no framework
  detected, nested calls share context, error propagation) and `Cookie Provider Registry` (:140:
  Next.js/Nuxt providers auto-registered on module load, Nitro v2 h3 `{event}` vs v3/Nuxt5 srvx
  `{request}` shapes, custom provider registration, first-match-wins, explicit-cookies/ALS priority).
  **Breaking this breaks every `hosting-ssr-*` app's ability to call protected APIs from server
  components.**
- `src/errors.test.ts:52` — `hasAuthError` (4 tests: match, no-match on different name, no-match with
  no `errorName`, null/undefined-safe).
- `src/redact.test.ts:89` — "redacts `defaultValue` of a sensitive `AuthField` descriptor": the
  state machine's hidden-form secrets (`{name:'session', defaultValue:'<token>'}`) are redacted from
  logs even though the key isn't literally `session`/`password`. **Security-relevant.**
- `src/hosting.test.ts:783` — "proxies the reserved `/aws-blocks/auth` subtree with a single
  behavior": a refactor emitting per-route auth paths would blow the CloudFront behavior budget.
- `src/raw-route.test.ts` uses `/aws-blocks/auth/signin/google` as a route-matching fixture;
  `src/lambda-handler.test.ts` uses `Cookie: 'session=…; auth=token'` headers;
  `src/common/index.test.ts` uses `'auth'`/`'AuthBasic'` as BB-name fixtures;
  `src/telemetry/telemetry.test.ts` classifies deploy-credential errors as `phase: 'auth'` (unrelated
  to runtime auth).

**`packages/hosting`:** no auth-BB-specific tests.

**`native/*`:**
- `native/swift/Tests/BlocksE2ETests/AuthBasicE2ETests.swift` (84 L, 6 tests:
  `testSignUpAndSignIn`, `testCheckAuthWhenSignedIn`, `testRequireAuthWhenSignedIn`, `testSignOut`,
  `testRequireAuthWhenSignedOutThrows`, `testWrongPasswordThrows`).
- `native/kotlin/e2e/src/commonTest/.../AuthBasicE2ETest.kt` (96 L, 8 `@Test`: same set plus
  `getCurrentUserWhenSignedIn`, `checkAuthAfterSignOut`).
- `native/dart/example/bin/e2e/auth_basic_test.dart` (65 L) — signUp→signIn→checkAuth→requireAuth→
  getCurrentUser→signOut→post-signOut null→checkAuth-false→negatives.
- `native/dart/example/bin/e2e/auth_cognito_test.dart` (236 L) — `_signUpConfirmFlow`,
  `_returningCustomerFlow`, `_provisionLocalUser`.
- `native/dart/example/bin/e2e/oidc_test.dart` — drives `OidcClient.signInRelay` headlessly against
  the stub IdP.
- `native/codegen-fixtures/23-cognito-nested-unions/` — a golden codegen fixture built on Cognito's
  nested discriminated unions, consumed by
  `native/kotlin/runtime/src/commonTest/.../json/StatusDiscriminatorDecodeTest.kt` and
  `native/swift/Tests/BlocksRuntimeTests/StatusDiscriminatorDecodeTests.swift`. **Auth's type shapes
  are the hardest fixture in the codegen suite.**

**`test-apps/amplify-gen2/test/e2e.test.ts`** (Playwright, 6 tests) — "Sign in and call protected
API", "Protected API rejects unauthenticated calls", "unauthenticated user cannot create todos":
exercises the `requireAuth` authorization boundary from an **external** auth provider.
**`test-apps/auth-cognito-passkeys/`** has no `test/` directory — manual demo only.

### 6.9 Skipped / conditionally-skipped — consolidated

| File | Gate |
|---|---|
| `bb-auth-cognito/src/scenarios.sandbox.test.ts` | 7 describes, `{skip: !ENABLED}`, `BLOCKS_INTEGRATION === '1'` |
| `bb-auth-cognito/src/scenarios.passwordless-demo.sandbox.test.ts` | 1 describe, same gate |
| `bb-auth-cognito/src/user-auth-integration.test.ts` | 7 describes on `BLOCKS_INTEGRATION`; 1 more on `BLOCKS_INTEGRATION_CUSTOMER_SES === '1'` |
| `test-apps/comprehensive/test/auth-cognito.test.ts` | skipped when **not** local |
| `test-apps/comprehensive/test/auth-cognito-sandbox.test.ts` | 2 describes, need sandbox/production **and** `TEST_AUTHC_POOL_ID` / `TEST_AUTHC_MFA_POOL_ID` |
| `test-apps/comprehensive/test/auth-cognito-admin-sandbox.test.ts` | 1 describe, needs sandbox/production |

### 6.10 Coverage map — what a unification refactor can and cannot lean on

| Behavior | Default-run coverage |
|---|---|
| `AuthBasic` end-to-end over HTTP | **strong** (`basic-auth.test.ts`, always runs) |
| `AuthCognito` mock behavior | **very strong** (`index.test.ts` 69 + `state-machine.test.ts` 56 + `admin.test.ts` 22 + `scenarios.mock.test.ts`) |
| `AuthCognito` **AWS runtime** (`index.aws.ts`, 2465 L) | **very weak by default** — only `index.aws.test.ts`'s 6 pure-function tests. Everything else is `BLOCKS_INTEGRATION`-gated |
| `AuthOIDC` mock + JWT crypto + browser client | **strong** (`index.test.ts` ~75, `index.browser.test.ts` ~28, `oidc-auth.test.ts` ~45) |
| `AuthOIDC` **AWS runtime** | **none** — no sandbox suite for the OIDC AWS path at the package level; `oidc-auth.test.ts` runs against the mock locally |
| `auth-common` `ui.ts` | **strong** (69 DOM tests) |
| `auth-common` export parity | **none** (not discovered by `conditional-exports.test.ts`) |
| Cognito CDK synth | **strong** (53 tests) |
| OIDC CDK synth | **moderate** (9 tests) |
| `AuthBasic` CDK synth | **none** (no cdk entry) |
| Types-level contracts | 5 types-test files, but **only via `tsc --build` on those workspaces**, and the root `tsconfig.json` omits `bb-auth-cognito`/`bb-auth-oidc` |
| Native SDK ↔ OIDC HTTP contract | Kotlin/Swift/Dart e2e exist but are **not** in `npm test`; they need a running backend |

---

## 7. Top decision-relevant findings

1. **The shared contract is tiny and already generalizes.** `BlocksAuth` (3 methods) is the only
   thing all three BBs implement, and two independent unmerged branches (`feat/bb-auth-jwt`,
   `supabase-auth-poc`) re-derived exactly that shape for stateless providers. Unification should
   build **on** `BlocksAuth`, not redesign it.
2. **The "common" state-machine type is 60 % Cognito-private.** 6 of 15 `AuthActionPayloadMap` keys
   and the whole 8-arm `confirmSignIn` union serve only Cognito; OIDC uses 1 key, Basic uses 6. This
   is the concrete shape of the user-confusion problem.
3. **`requireAuth` throws two different error names.** `SessionExpiredException` (Basic) vs
   `NotAuthenticatedException` (Cognito, OIDC), and `auth-common/src/index.ts:47` documents only the
   first. **Fixing this is a breaking change** to the client-visible error name and must be flagged
   for maintainer review per `AGENTS.md`.
4. **`requireRole` is the missing interface member.** Cognito has it; the Supabase PoC added it; JWT
   approximates it with `requiredClaims`; Basic and OIDC have nothing. Three of five providers need
   role gating and each invents its own.
5. **Cognito's mock and AWS runtimes are two independent 2 400-line classes with no shared base.**
   `bb-auth-oidc` proves the alternative works (`auth-oidc.ts` base + 169-line entries). This is the
   single largest structural win available, and it is also the highest-risk change, because the AWS
   runtime has **6 default-run tests** covering one pure function.
6. **Neither Cognito nor OIDC uses `synthGuard`.** Their CDK classes simply omit all runtime methods,
   so calling one at synth time yields a raw `TypeError`. Adding `synthGuard` stubs is a low-risk,
   high-value alignment with `AGENTS.md`.
7. **Two build/test blind spots to fix before refactoring.** (a) Root `tsconfig.json:3-19` does not
   reference `packages/bb-auth-cognito` or `packages/bb-auth-oidc`, so a root `tsc --build` misses
   them — and `*.types-test.ts` files are *only* checked by `tsc`. (b) `conditional-exports.test.ts`
   never sees `auth-common` (no `bb-` prefix) and only checks `aws-runtime ⊇ default`, so the real
   parity gaps (`extractUserAttributes` aws-only, `OIDCClient` mock-only, `SessionStore` missing from
   cdk/browser) pass today.
8. **Session semantics are irreconcilable as-is.** Basic is stateless (no revocation possible, no
   refresh); Cognito and OIDC are server-side session stores with revocation and silent refresh. Yet
   Basic and Cognito **use the same cookie name** `auth_${fullId}` with incompatible payloads.
9. **`bb-auth-oidc`'s `API.md` is broken** (6 `ae-forgotten-export` warnings; the class surface is
   absent), and `auth-common`'s `API.md` covers only 1 of 3 subpaths. `npm run check:api` cannot gate
   most of the auth surface today.
10. **Three open PRs to reconcile, plus a PoC.** `feat/bb-auth-jwt` (#297, draft — a 4th official BB,
    conflicts on the umbrella export blocks), `fix/auth-cognito-requirerole-live-groups` (#583 — the
    exact `requireRole` method, and it contradicts `DESIGN.md:142`), `fix/auth-reactivity-185`
    (#208 — adds `submitAuthAction` to `auth-common/src/ui.ts`), and `supabase-auth-poc`
    (design signal only). Five other named branches are already merged; their refs are stale.
11. **Undocumented blast radius outside TypeScript.** The Kotlin/Swift/Dart SDKs hand-implement the
    OIDC HTTP protocol (`authorize-params`, `exchange`, `refresh`, callback, relay) and are not
    typechecked against the source; `packages/bb-data/src/db-pull/templates.ts:181-215` emits
    `import { AuthOIDC, google } from '@aws-blocks/bb-auth-oidc'` as a **string**;
    `scripts/generate-bb-names.mjs:29-33` is the only place the `AuthOIDC`/`AuthOidc` case mismatch
    is reconciled; and `test-apps/amplify-gen2` + `templates/amplify` carry a **shadow
    `requireAuth`** that reproduces the interface without importing it.
12. **Documentation defects to fix in the refactor PR** (all violate `AGENTS.md` rule 11):
    `auth-common/src/index.ts:35` → dead `docs/tech-design/A0-API-DESIGN.md`;
    `docs/DECISIONS.md:133` → dead `BB-auth-common.md` + `BB-auth-basic.md`;
    `packages/foundations/README.md:45` → non-existent `buildAPI()`;
    `bb-auth-basic/DESIGN.md:292` → claims AuthOIDC uses a "self-signed JWT cookie" when it uses a
    stateful signed-session-id cookie (`bb-auth-oidc/src/session-cookie.ts:68-69`), and `:297` calls
    its infrastructure "Lambda + RawRoute" when it also provisions a DynamoDB session table, an SSM
    secret, and optionally a Cognito pool; `bb-auth-cognito/DESIGN.md:103` → the `codeDelivery`
    typecheck guard it claims appears not to hold through the umbrella.
