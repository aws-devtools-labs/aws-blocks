# AuthCognitoAdmin — Implementation Plan (in-package `auth.admin` handle)

**Status:** approved direction, ready to implement.
**Supersedes:** the separate-`@aws-blocks/bb-auth-cognito-admin`-package design in [`BB-auth-cognito-admin.md`](./BB-auth-cognito-admin.md) and the original [PR #38](https://github.com/aws-devtools-labs/aws-blocks/pull/38).
**Adopts:** [Chorus counter-proposal — "Alternative to PR #38: in-package admin surface for `bb-auth-cognito`"](https://chorus.aws.dev/doc/8Cdonf9Y6RdR/Alternative-to-PR-38-in-package-admin-surface-for-bb-auth-co).
**Guiding tenet:** **type safety first.** Every conditional type below was compiled under `tsc --strict` (TS 5.9) with positive and `@ts-expect-error` negative cases before this plan was written. The proof is reproduced in Appendix A and lands in-repo as `admin.types-test.ts` (Step 7).

## Decision

Expose the admin surface as an **opt-in handle on the existing `AuthCognito` class** (`auth.admin`), gated by an `admin` options object — **not** a second package/class. This deletes the `/internal` subpath, the `CognitoMockAdminPort` (11-method) indirection, the second construct, and the live-reference wiring, while preserving the API separation the original design valued.

The two designs are equivalent on safety (neither is an access-control boundary; both rely on lint + the shared-Lambda IAM model — verified: `Scope.handler` resolves to one stack handler, `core/src/cdk/index.ts:92-102`). The handle wins on cost. We give up independent versioning of the admin surface, which we do not need.

**Breaking changes are acceptable** — the service is in preview. No back-compat shims.

## Type design (the core of this plan)

All additions live in `packages/bb-auth-cognito/src/types.ts`, alongside the existing `GroupOf<O>` / `AttrOf<O>` / `MfaTypeOf<O>` projections, which set the precedent this design follows exactly.

### 1. Options

```typescript
/**
 * Enables the admin surface (`auth.admin`) and grants the matching Admin*/List*
 * IAM on the pool. Omit for the client-only surface with no admin grant — the
 * default, byte-identical to today's synthesized role.
 */
admin?: AdminOptions;   // added to AuthCognitoOptions
```

```typescript
export interface AdminOptions {
  /**
   * Scopes BOTH the IAM grant and the typed `auth.admin` surface. Omit to
   * enable everything. `['groups']` exposes only the group-membership methods
   * and grants only the group Admin* actions.
   */
  actions?: readonly ('groups' | 'lifecycle')[];
}
```

### 2. The gate and surface projections

```typescript
/** Active admin action set. Omitted `actions` ⇒ all. Mirrors GroupOf/MfaTypeOf style. */
export type AdminActionsOf<O extends AuthCognitoOptions> =
  O extends { admin: { actions: infer A extends readonly string[] } }
    ? A[number]
    : 'groups' | 'lifecycle';

/** Intersection of the enabled slices. `unknown` is the identity for `&`, so a
 *  disabled slice contributes nothing. */
export type AdminSurface<O extends AuthCognitoOptions> =
  ('groups'    extends AdminActionsOf<O> ? GroupAdmin<O>     : unknown) &
  ('lifecycle' extends AdminActionsOf<O> ? LifecycleAdmin<O> : unknown);

/** Branded "disabled" type. Touching any member is a compile error whose text
 *  names the fix — better DX than a plain `never`. */
export type AdminDisabled = {
  readonly __adminNotEnabled: 'construct AuthCognito with { admin: {} }';
};

/** Getter return type — the gate. Note `{ admin: object }`, NOT `{ admin: any }`:
 *  `admin: true` is a primitive and fails the gate, so the opt-in MUST be an
 *  object (`admin: {}`). Verified by Appendix A assertion #6. */
export type AdminGetterOf<O extends AuthCognitoOptions> =
  O extends { admin: object } ? AdminSurface<O> : AdminDisabled;
```

### 3. Method interfaces (group narrowing reuses `GroupOf<O>`)

```typescript
export interface AdminUser {
  username: string;
  userSub: string;
  enabled: boolean;
  attributes: Record<string, string>;
  groups?: string[];
}

export interface AdminCreateInit {
  temporaryPassword?: string;
  attributes?: Record<string, string>;
  suppressInvite?: boolean;
}

export interface GroupAdmin<O extends AuthCognitoOptions = AuthCognitoOptions> {
  addUserToGroup(username: string, group: GroupOf<O>): Promise<void>;
  removeUserFromGroup(username: string, group: GroupOf<O>): Promise<void>;
  listGroupsForUser(username: string): Promise<GroupOf<O>[]>;
  listUsersInGroup(group: GroupOf<O>): Promise<AdminUser[]>;
}

export interface LifecycleAdmin<O extends AuthCognitoOptions = AuthCognitoOptions> {
  createUser(username: string, init?: AdminCreateInit): Promise<AdminUser>;
  deleteUser(username: string): Promise<void>;
  disableUser(username: string): Promise<void>;
  enableUser(username: string): Promise<void>;
  resetUserPassword(username: string): Promise<void>;
  setUserPassword(username: string, password: string, permanent: boolean): Promise<void>;
  getUser(username: string): Promise<AdminUser | null>;
  scan(): AsyncIterable<AdminUser>;
  revokeUserSessions(username: string): Promise<void>;
}
```

### 4. The class generic — `const O` (separable change; see Step 5)

```typescript
export class AuthCognito<const O extends ...> { ... get admin(): AdminGetterOf<O>; }
```

`const O` makes inline literals (`groups: ['admins']`) narrow **without** `as const`. This is the one ergonomic upgrade and the one change with blast radius — handled deliberately in Step 5.

### Why this is provably type-safe

- **One cast, and it does not leak.** The runtime builds the *full* admin object once, typed against the wide base (`GroupAdmin<AuthCognitoOptions> & LifecycleAdmin<AuthCognitoOptions>`). The getter performs a single `return this.#admin as AdminGetterOf<O>`. Appendix B compiles a consumer against this exact pattern and confirms typos and ungranted methods are **still** rejected — the cast narrows, it does not widen away safety.
- **`unknown` is the correct "off" value.** `X & unknown = X`, so a disabled slice vanishes from the intersection. Using `never` would poison the whole intersection to `never`. (Compiled: assertions #2–#4.)
- **Gate is `object`, not `any`/`true`.** Prevents the `admin: true` footgun. (Compiled: assertion #6.)
- **Default `O` stays wide.** No-generic-arg construction keeps `string` group typing and a disabled admin handle — zero impact on existing non-const callers' *types* (their *call sites* are addressed in Step 5). (Compiled: assertions #7–#8.)

## Scope of edits (all within `packages/bb-auth-cognito/`)

| Area | File | Change |
|---|---|---|
| Types + gate | `src/types.ts` | `AdminOptions`, `AdminActionsOf`, `AdminSurface`, `AdminDisabled`, `AdminGetterOf`, `GroupAdmin`, `LifecycleAdmin`, `AdminUser`, `AdminCreateInit`; add `admin?` to `AuthCognitoOptions`. |
| Mock runtime | `src/index.ts` | `#admin` built against live `this.state`; `get admin()`; mock mutators reusing `state` + `flushToDisk()`. |
| AWS runtime | `src/index.aws.ts` | `#admin` against SDK `Admin*` commands; same getter; existing error-mapper. |
| Browser stub | `src/index.browser.ts` | throwing `get admin()` so the shape typechecks under `--conditions=browser`. |
| CDK | `src/index.cdk.ts` | second `PolicyStatement` in `grantCognitoPermissions`, gated on `this.options.admin`, scoped by `actions`. |
| `const O` | all four entries | `<O ...>` → `<const O ...>` (`index.ts:200`, `index.aws.ts:583`, `index.cdk.ts:66`, `index.browser.ts:31`). |
| Type tests | `src/admin.types-test.ts` | the Appendix A proof, repo-convention style. |
| Unit tests | `src/admin.test.ts` | mock behavior; CDK grant assertions. |
| Call-site fixes | `test-apps/*` | `requireRole` variable-arg sites (Step 5). |
| Docs | `README.md` | opt-in, narrowing, gating, session-freshness. |

No new package. No `/internal` subpath. No export-parity carve-out (`conditional-exports.test.ts` inspects only the bare specifier).

## Implementation steps

### Step 1 — Types and gate (`src/types.ts`)
Add the block from "Type design" §1–§3. Place it near `GroupOf`/`MfaTypeOf` (around `types.ts:271`) so the projections sit together. No class change yet (that's Step 5). **Gate: verify `admin: object`, not `true`.**

### Step 2 — Mock runtime (`src/index.ts`)
1. After `this.state = this.loadFromDisk()` (`index.ts:238`), build `this.#admin` closing over the **same** `this.state` object and the existing private `flushToDisk()`. One instance ⇒ one `state.groups` ⇒ the lost-update hazard that forced the original `/internal` port **cannot occur**.
2. `get admin(): AdminGetterOf<O>` — throw `Error('admin not enabled: construct AuthCognito with { admin: {} }')` when `!this.options.admin`; else `return this.#admin as AdminGetterOf<O>`.
3. Mutators onto `PersistedState` (`index.ts:159`; `users`, `groups: Record<string,string[]>`):
   - `addUserToGroup` → push to `state.groups[group]`; throw `GroupNotFound` (`AuthCognitoErrors.GroupNotFound`, `types.ts:968`) if the group was never seeded (Cognito has no implicit group creation). `removeUserFromGroup` → filter.
   - `createUser` → `MockUserRecord` mirroring `signUp` (reuse `prefixCustomAttrs`, password-policy enforcement); `deleteUser` → delete record **and** strip from every `state.groups[*]`.
   - `disableUser`/`enableUser` → toggle existing `MockUserRecord.disabled` (`index.ts:114`). **Do not** re-implement the disabled-sign-in check — `signIn` already rejects disabled users (`index.ts:474`). Add a regression test that it still does.
   - `resetUserPassword`/`setUserPassword` → reuse the existing **`forcePasswordChange`** flag name (`index.ts:528`); do NOT introduce `forceChangePassword`.
   - `revokeUserSessions` → delete the user's session records.
   - `scan`/`listUsersInGroup` → iterate in-memory maps, `yield` page-by-page (same `AsyncIterable` path AWS pagination uses).
4. Every mutator calls `flushToDisk()` so changes are visible to the same instance's next `signIn`/`requireRole`.

### Step 3 — AWS runtime (`src/index.aws.ts`)
1. Build `#admin` against `@aws-sdk/client-cognito-identity-provider` `Admin*` commands (already a hard dep — `package.json:41`). Reuse the existing client, discovery via `envVarNames(this.fullId)` (`types.ts:1051`), and the existing error-mapping helper so the methods read as siblings of the client methods.
2. Same getter contract and throw text.
3. `revokeUserSessions` → `AdminUserGlobalSignOut`. `setUserPassword` → `AdminSetUserPassword(Permanent)`. `resetUserPassword` → `AdminResetUserPassword`.

### Step 4 — CDK grant (`src/index.cdk.ts`)
In `grantCognitoPermissions` (`index.cdk.ts:310`), after the existing client statement, add a **second** `PolicyStatement` **only when `this.options.admin`**, scoped to `this.userPool.userPoolArn`, with actions selected by `actions`:
- `'groups'` → `AdminAddUserToGroup`, `AdminRemoveUserFromGroup`, `AdminListGroupsForUser`, `ListUsersInGroup`
- `'lifecycle'` → `AdminCreateUser`, `AdminDeleteUser`, `AdminEnableUser`, `AdminDisableUser`, `AdminResetUserPassword`, `AdminSetUserPassword`, `AdminGetUser`, `ListUsers`, `AdminUserGlobalSignOut`
- omitted → union of both

The typed surface and the grant are both driven by `actions`, so they cannot drift. No `admin` ⇒ no statement ⇒ role identical to today.

### Step 5 — `const O` migration (separable; own commit)
1. `<O ...>` → `<const O ...>` on all four entries (`index.ts:200`, `index.aws.ts:583`, `index.cdk.ts:66`, `index.browser.ts:31`).
2. **Blast radius is wider than groups** — `const O` flips five projections to narrow-by-default: `GroupOf` (`requireRole`), `AttrOf` (`updateUserAttribute`/`confirmUserAttribute`/`sendUserAttributeVerificationCode`/`updateUserAttributes`/`SignUpOptions.attributes`/`ConfirmSignInOptions.userAttributes`), `ReadAttrOf` (`fetchUserAttributes`, `CognitoUser.attributes`), `MfaTypeOf` (`confirmSignIn({ mfaType })`, `MFAPreferenceInput`, `MFAPreference`), `CustomAttrNames`.
3. **Concrete breaking call sites** (variable arg vs. narrowed union):
   - `test-apps/comprehensive/aws-blocks/index.ts:938` — `authC.requireRole(context, role)` where `role: string`.
   - `test-apps/native-bindings/aws-blocks/index.ts:241` — `authCognito.requireRole(context, role)` where `role: string`.
   Fix: type the handler param as `GroupOf<typeof auth>`, or keep `string` and pass `role as GroupOf<typeof auth>` at the call. Scaffold template already uses literals + literal args — new users unaffected.
4. Land as its own commit titled to flag the API change; list the five projections in the body. The handle does not strictly require it (it only improves group narrowing), so it can be dropped if review pushes back.

### Step 6 — Browser stub (`src/index.browser.ts`)
Add `get admin(): AdminGetterOf<O> { throw new Error('AuthCognito.admin is server-only'); }` to the no-op class (`index.browser.ts:31`) so `auth.admin` typechecks under `--conditions=browser`. No SDK reaches client bundles — the `"browser"` export condition already resolves away `index.aws.ts` (verified in `package.json` exports).

### Step 7 — Type tests (`src/admin.types-test.ts`)
Port Appendix A into the repo convention (compile-is-the-test, `@ts-expect-error`, matches `types.types-test.ts:1-18`). Picked up by `tsc --build`. Cases: gate-off error, `admin:{}` full surface, `actions:['groups']` excludes lifecycle, `actions:['lifecycle']` excludes groups, `const O` group typo rejected, `admin:true` rejected, default-O disabled, `requireRole` regression.

### Step 8 — Unit tests (`src/admin.test.ts`) + docs
- Mock: group add/remove (+ `GroupNotFound`), lifecycle create/delete (+ group cleanup), disable/enable (+ regression: `signIn` still rejects disabled), password reset/set, `scan` pagination, `revokeUserSessions`.
- CDK: no admin statement without `admin`; correct scoped actions for `['groups']` / `['lifecycle']` / omitted.
- `README.md`: `admin`/`actions` opt-in, narrowing rules + `const O`, "always gate admin routes behind `requireRole`", session-freshness caveat (group change applies on next sign-in/refresh; `revokeUserSessions` for immediate effect — inherent Cognito behavior).

## Verification gates (must all pass before PR update)
1. `tsc --build` clean across all four entries **and** `admin.types-test.ts`.
2. `admin.test.ts` (mock + CDK) green.
3. `conditional-exports.test.ts` (`packages/blocks/src/`) green — no new subpath.
4. `test-apps/comprehensive` + `test-apps/native-bindings` typecheck after Step 5 fixes.
5. `npm run build --workspace @aws-blocks/bb-auth-cognito` green.

## Task list (implementation order)

Each task is independently committable. T5 (`const O`) is isolated so it can be dropped if review pushes back without unwinding the rest.

| # | Task | Files | Depends on |
|---|---|---|---|
| T1 | Add admin types + gate (`AdminOptions`, `AdminActionsOf`, `AdminSurface`, `AdminDisabled`, `AdminGetterOf`, `GroupAdmin`, `LifecycleAdmin`, `AdminUser`, `AdminCreateInit`); add `admin?` to `AuthCognitoOptions` | `src/types.ts` | — |
| T2 | `admin.types-test.ts` (Appendix A) — land FIRST after T1 so the gate is locked before any runtime code | `src/admin.types-test.ts` | T1 |
| T3 | Mock runtime `#admin` + `get admin()` + mutators on live `this.state` | `src/index.ts` | T1 |
| T4 | AWS runtime `#admin` + getter against SDK `Admin*` commands | `src/index.aws.ts` | T1 |
| T5 | `const O` migration on all four entries + fix the 2 `requireRole` call sites *(separable commit)* | `src/index*.ts`, `test-apps/*` | T1 |
| T6 | Browser stub throwing `get admin()` | `src/index.browser.ts` | T1 |
| T7 | CDK second `PolicyStatement` gated on `admin`, scoped by `actions` | `src/index.cdk.ts` | T1 |
| T8 | Mock unit tests | `src/admin.test.ts` | T3 |
| T9 | CDK grant unit tests | `src/index.cdk.test.ts` | T7 |
| T10 | Integration: exercise `auth.admin` through the deployed Lambda backend | `test-apps/comprehensive/*` | T3,T4,T7 |
| T11 | README: opt-in, narrowing, gating, session-freshness | `README.md` | T3,T4,T7 |

## Verify list

### Unit (no AWS account; runs in CI)
Pattern mirrors the existing four test layers in this package.

**Type tests** — `src/admin.types-test.ts` (compile-is-the-test, `@ts-expect-error`; run by `tsc --build`):
- [ ] No `admin` opt-in ⇒ `auth.admin` member access is a compile error.
- [ ] `admin: {}` ⇒ both `GroupAdmin` + `LifecycleAdmin` present.
- [ ] `actions: ['groups']` ⇒ lifecycle methods are compile errors; group methods OK.
- [ ] `actions: ['lifecycle']` ⇒ group methods are compile errors; lifecycle OK.
- [ ] `const O` ⇒ group typo (`'editor'`) rejected **without** `as const`.
- [ ] `admin: true` ⇒ construction is a compile error.
- [ ] Default `O` ⇒ admin disabled; `requireRole('nope')` still rejected (const-O regression guard).

**Mock behavior** — `src/admin.test.ts` (`node:test`, real mock instance, in-memory):
- [ ] `addUserToGroup` writes to `state.groups`; visible to the same instance's next `requireRole`.
- [ ] `addUserToGroup` to an unseeded group throws `GroupNotFound`.
- [ ] `removeUserFromGroup` filters membership.
- [ ] `createUser` mirrors `signUp` (custom-attr prefixing, password policy); `deleteUser` removes record **and** strips from every group array.
- [ ] `disableUser`/`enableUser` toggle `MockUserRecord.disabled`; **regression:** `signIn` still rejects a disabled user (existing `index.ts:474` behavior unchanged).
- [ ] `resetUserPassword`/`setUserPassword` set the existing `forcePasswordChange` flag (no new `forceChangePassword`).
- [ ] `revokeUserSessions` deletes session records.
- [ ] `scan`/`listUsersInGroup` paginate via `AsyncIterable`.
- [ ] Getter throws the named error when `admin` not enabled (runtime guard for untyped JS callers).

**CDK** — `src/index.cdk.test.ts` (`Template.fromStack` + `hasResourceProperties`):
- [ ] No `admin` ⇒ synthesized handler role has **no** `Admin*` statement (byte-identical to today).
- [ ] `actions: ['groups']` ⇒ exactly the 4 group actions, scoped to the pool ARN.
- [ ] `actions: ['lifecycle']` ⇒ exactly the lifecycle/list actions.
- [ ] `admin: {}` (omitted actions) ⇒ union of both sets.

**Cross-cutting**:
- [ ] `tsc --build` clean across all four entries + `admin.types-test.ts`.
- [ ] `conditional-exports.test.ts` (`packages/blocks/src/`) green — confirms no new subpath/export-parity work.
- [ ] `npm run build --workspace @aws-blocks/bb-auth-cognito` green.
- [ ] `test-apps/comprehensive` + `test-apps/native-bindings` typecheck after the T5 call-site fixes.

### Integration (live AWS; sandbox-gated)
Exercises the real deployed surface through the Lambda backend, the way `test-apps/comprehensive/test/sandbox-admin-e2e.ts` already does for client methods. **Prereqs:** deployed `bb-test-*` sandbox, `AWS_PROFILE` with Cognito admin + CFN-describe perms, run from `test-apps/comprehensive`.
- [ ] Deploy comprehensive backend with `admin: { actions: ['groups','lifecycle'] }` on the pool; CFN synth/deploy succeeds and the handler role carries the admin statement.
- [ ] `auth.admin.createUser` → real Cognito user appears (`AdminGetUser` confirms).
- [ ] `auth.admin.addUserToGroup` → then `signIn` + `requireRole('admins')` succeeds (membership took effect on fresh token).
- [ ] Group change on an **existing** session is NOT retroactive until refresh; `revokeUserSessions` forces re-auth and the new claim appears (session-freshness contract).
- [ ] `auth.admin.disableUser` → subsequent `signIn` returns `NotAuthorizedException`; `enableUser` restores it.
- [ ] `setUserPassword(permanent:true)` → `signIn` with the new password succeeds, no `NEW_PASSWORD_REQUIRED`.
- [ ] `scan` paginates across a >1-page user set.
- [ ] **Negative least-privilege:** a pool deployed WITHOUT `admin` → calling an admin route 500s with an IAM `AccessDenied` server-side (no grant), proving the opt-in gates the grant.
- [ ] Teardown via existing `sandbox-destroy.ts`.

## Open questions (carried from the counter-proposal)
1. Property name: `admin` vs a louder `adminApi`.
2. `actions` granularity: `'groups' | 'lifecycle'` vs 1:1 mapping to individual `Admin*` actions.

---

## Appendix A — compiler-verified type proof (consumer side)

Compiled with `tsc --strict --noEmit` (TS 5.9.3), **exit 0**. Each `@ts-expect-error` asserts a real error; the file fails to compile if any expectation is wrong. This becomes `src/admin.types-test.ts`.

```typescript
// (1) no opt-in → AdminDisabled; method access errors
const a1 = new AuthCognito({ groups: ['admins'] });
// @ts-expect-error admin not enabled
a1.admin.addUserToGroup('u', 'admins');

// (2) admin: {} → full surface
const a2 = new AuthCognito({ groups: ['admins'], admin: {} });
a2.admin.addUserToGroup('u', 'admins'); a2.admin.createUser('u');

// (3) actions: ['groups'] → lifecycle absent
const a3 = new AuthCognito({ groups: ['admins'], admin: { actions: ['groups'] } });
a3.admin.addUserToGroup('u', 'admins');
// @ts-expect-error lifecycle not granted
a3.admin.createUser('u');

// (4) actions: ['lifecycle'] → groups absent
const a4 = new AuthCognito({ groups: ['admins'], admin: { actions: ['lifecycle'] } });
a4.admin.createUser('u');
// @ts-expect-error groups not granted
a4.admin.addUserToGroup('u', 'admins');

// (5) const O narrows WITHOUT as const → typo rejected
const a5 = new AuthCognito({ groups: ['admins', 'readers'], admin: { actions: ['groups'] } });
a5.admin.addUserToGroup('u', 'admins');
// @ts-expect-error 'editor' ∉ 'admins' | 'readers'
a5.admin.addUserToGroup('u', 'editor');

// (6) admin: true must NOT enable
// @ts-expect-error true ∉ AdminOptions
const a6 = new AuthCognito({ groups: ['admins'], admin: true });

// (7) default O → admin disabled
const a7: AuthCognito = new AuthCognito();
// @ts-expect-error disabled on default O
a7.admin.createUser('u');

// (8) requireRole regression under const O
const a8 = new AuthCognito({ groups: ['admins'] });
a8.requireRole('admins');
// @ts-expect-error not a known group
a8.requireRole('nope');
```

## Appendix B — compiler-verified proof (implementation side)

Compiled `tsc --strict --noEmit`, **exit 0**. Proves the single getter cast is safe: the impl is typed against the wide base, yet consumer typos and ungranted methods are still rejected.

```typescript
class AuthCognito<const O extends AuthCognitoOptions = AuthCognitoOptions> {
  readonly #options: O;
  readonly #admin: GroupAdmin<AuthCognitoOptions> & LifecycleAdmin<AuthCognitoOptions>;
  constructor(opts: O = {} as O) { this.#options = opts; this.#admin = { /* full impl */ }; }
  get admin(): AdminGetterOf<O> {
    if (!this.#options.admin) throw new Error('admin not enabled: construct AuthCognito with { admin: {} }');
    return this.#admin as AdminGetterOf<O>;   // the ONLY cast
  }
}
const auth = new AuthCognito({ groups: ['admins', 'readers'], admin: { actions: ['groups'] } });
auth.admin.addUserToGroup('u', 'admins');
// @ts-expect-error typo rejected even though impl is wide
auth.admin.addUserToGroup('u', 'editor');
// @ts-expect-error lifecycle hidden by actions scoping
auth.admin.createUser('u');
```
