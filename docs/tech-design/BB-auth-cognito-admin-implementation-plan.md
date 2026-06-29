# AuthCognitoAdmin — Implementation Plan (in-package `auth.admin` handle)

**Status:** approved direction, ready to implement.
**Supersedes:** the separate-`@aws-blocks/bb-auth-cognito-admin`-package design in [`BB-auth-cognito-admin.md`](./BB-auth-cognito-admin.md) and [PR #38](https://github.com/aws-devtools-labs/aws-blocks/pull/38).
**Adopts:** [Chorus counter-proposal — "Alternative to PR #38: in-package admin surface for `bb-auth-cognito`"](https://chorus.aws.dev/doc/8Cdonf9Y6RdR/Alternative-to-PR-38-in-package-admin-surface-for-bb-auth-co).

## Decision

Expose the admin surface as an **opt-in handle on the existing `AuthCognito` class** (`auth.admin`), gated by an `admin` options object — **not** a second package/class. This deletes the `/internal` subpath, the `CognitoMockAdminPort` (11-method) indirection, the second construct, and the live-reference wiring, while preserving the API separation the original design valued.

The two designs are equivalent on safety (neither is an access-control boundary; both rely on lint + the shared-Lambda IAM model — verified: `Scope.handler` resolves to one stack handler, `core/src/cdk/index.ts:92-102`). The handle wins on cost. We give up independent versioning of the admin surface, which we do not need.

**Breaking changes are acceptable** — the service is in preview. We do not need back-compat shims.

## Scope of edits (all within `packages/bb-auth-cognito/`)

| Area | File | Change |
|---|---|---|
| Options + types | `src/types.ts` | Add `admin?: AdminOptions`; `AdminOptions`, `AdminActionsOf<O>`, `AdminSurface<O>`, `AdminDisabled`; the `GroupAdmin<O>` / `LifecycleAdmin<O>` method interfaces; **`const O`** on the class generic (see Step 5). |
| Mock runtime | `src/index.ts` | `#admin` field built against the live `this.state`; `get admin()` getter; mock implementations of group + lifecycle mutators reusing existing `state` + `flushToDisk()`. |
| AWS runtime | `src/index.aws.ts` | `#admin` built against SDK `Admin*` commands; same getter; error-mapping via the existing helper. |
| Browser stub | `src/index.browser.ts` | Add a throwing `get admin()` to the no-op class so the shape typechecks under `--conditions=browser`. |
| CDK | `src/index.cdk.ts` | In `grantCognitoPermissions`, add a **second** `PolicyStatement` (admin `Admin*`/`List*`) gated on `this.options.admin`, scoped by `actions`. |
| Tests | `src/*.test.ts` | Mock admin unit tests; type-level tests for the gate + narrowing; CDK grant assertions; fix existing `requireRole` call sites for `const O`. |
| Docs | `README.md`, this doc | Document the handle, the `admin`/`actions` opt-in, the narrowing rules, and session-freshness caveat. |

No new package. No `/internal` subpath. No export-parity carve-out.

## Interface (target)

```typescript
// types.ts
interface AuthCognitoOptions {
  /**
   * Enables the admin surface (`auth.admin`) and grants the Admin*/List* IAM
   * on the pool. Omit for the client-only surface with no admin grant (default,
   * identical to today).
   */
  admin?: AdminOptions;
}

interface AdminOptions {
  /** Scopes both the IAM grant and the typed surface. Omit to grant all. */
  actions?: readonly ('groups' | 'lifecycle')[];
}

type AdminActionsOf<O extends AuthCognitoOptions> =
  O extends { admin: { actions: infer A extends readonly string[] } } ? A[number] : 'groups' | 'lifecycle';

type AdminSurface<O extends AuthCognitoOptions> =
  ('groups'    extends AdminActionsOf<O> ? GroupAdmin<O>     : unknown) &
  ('lifecycle' extends AdminActionsOf<O> ? LifecycleAdmin<O> : unknown);

// Access without opting in is a compile error whose message names the fix.
type AdminDisabled = { readonly __adminNotEnabled: "construct AuthCognito with { admin: {} }" };
```

```typescript
// usage
const auth = new AuthCognito(scope, 'auth', {
  groups: ['admins'],
  admin: { actions: ['groups'] },         // exposes auth.admin, grants only group Admin* actions
});
await auth.requireRole(ctx, 'admins');                 // gate the route
await auth.admin.addUserToGroup('alice', 'admins');    // group narrowed via GroupOf<O>
```

`auth.admin` is `AdminDisabled` (compile error on access) unless `admin` is set; the getter also throws at runtime for untyped JS callers. A pool that never opts in gets **no** `Admin*` grant — synthesized role identical to today.

## Method surface

`GroupAdmin<O>`:
- `addUserToGroup(username: string, group: GroupOf<O>): Promise<void>`
- `removeUserFromGroup(username: string, group: GroupOf<O>): Promise<void>`
- `listGroupsForUser(username: string): Promise<GroupOf<O>[]>`
- `listUsersInGroup(group: GroupOf<O>): Promise<AdminUser[]>`

`LifecycleAdmin<O>`:
- `createUser(username, init): Promise<AdminUser>`
- `deleteUser(username): Promise<void>`
- `disableUser(username): Promise<void>` / `enableUser(username): Promise<void>`
- `resetUserPassword(username): Promise<void>` / `setUserPassword(username, password, permanent): Promise<void>`
- `getUser(username): Promise<AdminUser | null>`
- `scan(): AsyncIterable<AdminUser>` (full-pool enumeration; page-by-page)
- `revokeUserSessions(username): Promise<void>` (immediate effect for permission changes)

Return shapes are stable so a future `AdminSite` "Users" panel binds to the same methods.

## Implementation steps

### Step 1 — Types and the gate (`src/types.ts`)
1. Add `admin?: AdminOptions` to `AuthCognitoOptions` (interface at `types.ts:276`).
2. Add `AdminOptions`, `AdminActionsOf<O>`, `AdminSurface<O>`, `AdminDisabled`, `GroupAdmin<O>`, `LifecycleAdmin<O>`, `AdminUser`.
3. **Gate is `object`, not `true`:** `admin: true` must NOT enable (a primitive isn't `object`); the gate `O extends { admin: object }` requires `admin: {}`.
4. `actions` scoping needs no `as const` — `admin: { actions: ['groups'] }` is preserved as `('groups')[]` by contextual typing.

### Step 2 — Mock runtime (`src/index.ts`)
1. Build a `#admin` object in the constructor (after `this.state = this.loadFromDisk()`, `index.ts:238`) that closes over the **same** `this.state` and calls the existing private `flushToDisk()`. No port, no second instance → the lost-update hazard the original design feared cannot occur.
2. `get admin()` returns `#admin` typed as `AdminSurface<O>`; throws `Error("admin not enabled: construct AuthCognito with { admin: {} }")` when `!this.options.admin`.
3. Mutators map onto existing state (`PersistedState`, `index.ts:159`: `users`, `groups: Record<string, string[]>`):
   - `addUserToGroup` → push to `state.groups[group]`, throw `GroupNotFound` if group was never seeded (Cognito has no implicit group creation); `removeUserFromGroup` → filter.
   - `createUser` → write a `MockUserRecord` mirroring `signUp` (reuse `prefixCustomAttrs`, password policy); `deleteUser` → delete record **and** strip from every `state.groups[*]`.
   - `disableUser`/`enableUser` → toggle the existing `disabled` flag (`MockUserRecord.disabled`, `index.ts:114`). **Do not** re-implement the disabled-sign-in check — `signIn` already rejects disabled users (`index.ts:474`).
   - `resetUserPassword`/`setUserPassword` → reuse the existing **`forcePasswordChange`** flag name (`index.ts:528`) — do NOT introduce a parallel `forceChangePassword`.
   - `revokeUserSessions` → delete the user's session records.
   - `scan`/`listUsersInGroup` → iterate in-memory maps, yield page-by-page (exercise the same `AsyncIterable` path AWS pagination uses).
4. Every mutator calls `flushToDisk()` so changes are visible to the same instance's next `signIn`/`requireRole`.

### Step 3 — AWS runtime (`src/index.aws.ts`)
1. Build `#admin` against `@aws-sdk/client-cognito-identity-provider` `Admin*` commands (already a hard dep — `package.json:41`). Reuse the existing client, discovery (env vars), and error-mapping helper so the code reads as a sibling of the client methods.
2. Same getter contract and throw behavior.
3. `revokeUserSessions` → `AdminUserGlobalSignOut`.

### Step 4 — CDK grant (`src/index.cdk.ts`)
1. In `grantCognitoPermissions` (`index.cdk.ts:310`), after the existing client-facing statement, add a **second** `PolicyStatement` **only when `this.options.admin` is set**, scoped to `this.userPool.userPoolArn`.
2. `actions` scopes the grant:
   - `['groups']` → `AdminAddUserToGroup`, `AdminRemoveUserFromGroup`, `AdminListGroupsForUser`, `ListUsersInGroup`
   - `['lifecycle']` → `AdminCreateUser`, `AdminDeleteUser`, `AdminEnableUser`, `AdminDisableUser`, `AdminResetUserPassword`, `AdminSetUserPassword`, `AdminGetUser`, `ListUsers`, `AdminUserGlobalSignOut`
   - omitted → all of the above
3. The typed surface (`AdminSurface<O>`) and the grant are both driven by `actions` → they cannot drift.

### Step 5 — `const O` (separable; flag in PR description)
1. Change the class generic to `<const O ...>` across `index.ts:200`, `index.aws.ts:583`, `index.cdk.ts:66`, `index.browser.ts:31` so inline literals (`groups: ['admins']`) narrow without `as const`.
2. **Blast radius is wider than groups** — `const O` flips five literal projections to narrow-by-default: `GroupOf` (`requireRole`), `AttrOf` (`updateUserAttribute`/`confirmUserAttribute`/`sendUserAttributeVerificationCode`/`updateUserAttributes`), `ReadAttrOf` (`fetchUserAttributes` return), `MfaTypeOf` (`confirmSignIn({ mfaType })`), `CustomAttrNames`.
3. **Concrete call sites that break** (variable arg vs. narrowed union):
   - `test-apps/comprehensive/aws-blocks/index.ts:938` — `authC.requireRole(context, role)` where `role: string`
   - `test-apps/native-bindings/aws-blocks/index.ts:241` — `authCognito.requireRole(context, role)` where `role: string`
   Fix: widen the handler param to `GroupOf<typeof auth>` (or accept `string` and cast at the call). The scaffold template already uses literals, so new users are unaffected.
4. **Recommendation:** land `const O` as its own commit within this PR with the blast radius explicitly listed, so reviewers see it's a deliberate API change, not a free side effect. If it proves contentious, it can ship separately — the handle does not strictly require it (it only improves group-narrowing ergonomics).

### Step 6 — Browser stub (`src/index.browser.ts`)
Add `get admin(): never { throw ... }` to the no-op class (`index.browser.ts:31`) so `auth.admin` typechecks under `--conditions=browser`. No SDK reaches client bundles — the `"browser"` export condition already resolves away `index.aws.ts` (verified in `package.json` exports).

### Step 7 — Tests
1. Mock unit tests: group add/remove (+ `GroupNotFound`), lifecycle create/delete (+ group cleanup), disable/enable (+ regression: `signIn` still rejects disabled), password reset/set, `scan` pagination, `revokeUserSessions`.
2. Type-level tests: `auth.admin` is `AdminDisabled` without opt-in (expect compile error); `actions: ['groups']` exposes only `GroupAdmin`; `admin: true` does NOT enable; `GroupOf<O>` narrows under `const O`.
3. CDK: assert no admin statement without `admin`; correct scoped actions for `['groups']` / `['lifecycle']` / all.
4. Confirm `conditional-exports.test.ts` (`packages/blocks/src/`) still passes — it inspects only the bare specifier, so the handle adds no new subpath to reconcile.

### Step 8 — Docs
Update `README.md`: the `admin`/`actions` opt-in, narrowing rules (and the `const O` story), "always gate admin routes behind `requireRole`", and the session-freshness caveat (group changes apply on next sign-in/refresh; `revokeUserSessions` for immediate effect — inherent Cognito behavior, not a KIT bug).

## Open questions (carried from the counter-proposal)
1. Property name: `admin` vs a louder `adminApi`.
2. `actions` granularity: `'groups' | 'lifecycle'` vs 1:1 mapping to individual `Admin*` actions.

## Verification before PR update
- `tsc --build` clean across the package (all four entries).
- Package unit + type tests green.
- `conditional-exports.test.ts` green.
- `test-apps/comprehensive` and `test-apps/native-bindings` typecheck after the `const O` call-site fixes.
