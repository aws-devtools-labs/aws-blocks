# BB: AuthCognitoAdmin (Implementation-Ready)

> **STATUS — Implementation-ready.** API surface, error model, per-runtime implementation, mock parity, and naming have been validated against the shipped `bb-auth-cognito` code and the binding guidelines (API Design Guidelines, Building Block Architecture, [DECISIONS D-004](../DECISIONS.md)). The design was independently reviewed and every claim verified against source. Open items remaining are explicitly listed at the end and are non-blocking for a v1 build.

**Package:** `@aws-blocks/bb-auth-cognito-admin`
**Type:** Composite (composes an existing `AuthCognito` instance; no new AWS infrastructure)
**AWS Service:** Amazon Cognito User Pool (admin-side `Admin*` / `List*` APIs)

## Prior art in the repo (this block was pre-planned)

This block is not speculative — the shipped `AuthCognito` docs explicitly carved it out and pre-documented its surface. The design below is the realization of that plan:

- **`packages/bb-auth-cognito/docs/DESIGN.md:24`** (authoritative, ships with the package): *"Admin user-lifecycle APIs … deliberately excluded. **Those operate on any user and can't self-gate from a `context`**, so they don't belong on the same class that exposes `signIn`/`signUp`. They return as a separate admin Building Block in a future PR."* — This is the canonical rationale (sharper than "client vs admin": the real boundary is **self-gating**).
- **`packages/bb-auth-cognito/docs/DESIGN.md:88`**: *"No `cognito-idp:Admin*` or `cognito-idp:List*` actions are granted; those belong to the future admin BB."* — confirms the IAM split this block fills.
- **`packages/bb-auth-cognito/docs/COGNITO-SUPPORT.md`**: a full Cognito-operation matrix where every API this block implements is tagged ❌ "Admin BB" (`AdminAddUserToGroup`, `AdminRemoveUserFromGroup`, `AdminListGroupsForUser`, `ListUsersInGroup`, `AdminCreateUser`, `AdminDeleteUser`, `AdminEnable/DisableUser`, `AdminSetUserPassword`, `AdminResetUserPassword`, `AdminUserGlobalSignOut`, `ListUsers`).
- **`DESIGN.md:191`** (open question): *"Typed `ListUsers.filter`. When the admin BB lands, the filter string is still stringly-typed."* — resolved here as a typed filter subset.
- **`DECISIONS.md` D-004** (auth-first naming): mandates `bb-auth-*` packages and `Auth*` classes — `bb-auth-cognito-admin` / `AuthCognitoAdmin` comply.

## Purpose

Server-side administrative surface for a Cognito User Pool created by `AuthCognito`. Provides the user-lifecycle and group-membership operations that `AuthCognito` deliberately omits from its client-facing class: creating/deleting users, enabling/disabling them, resetting passwords, listing users, and adding/removing group membership.

**The boundary, precisely.** `AuthCognito` methods take `context: KitContext` and act on *the signed-in user* — they self-gate. `AuthCognitoAdmin` methods take a `username` and act on *any* user — they cannot self-gate, so they must be gated by the caller (`requireRole`). Keeping them on a separate class makes that distinction structural, not a convention you can forget.

**Why it matters:** `AuthCognito` seeds groups at deploy time (`CfnUserPoolGroup` per `options.groups`) and `requireRole(ctx, 'admins')` checks the `cognito:groups` claim — but ships **no way to put a user into a group**. The mock keeps every group permanently empty, and the AWS runtime relies on an out-of-band `aws cognito-idp admin-add-user-to-group` CLI call. As a result `requireRole('admins')` returns 403 for every user and the admin surface is unreachable. `AuthCognitoAdmin` closes that gap with a first-class, typed, mock-parity API.

**When to use:** You need server-side admin operations — seeding the first admin, building an internal user-management screen, or scripting group membership — against a pool owned by `AuthCognito`.

**When NOT to use:** For client-facing auth (sign-in/up, MFA, profile self-service) use `AuthCognito` directly. Never expose `AuthCognitoAdmin` methods to unauthenticated callers — gate every admin route behind `auth.requireRole(ctx, 'admins')` (see Usage Examples).

## Relationship to AuthCognito

`AuthCognitoAdmin` references — does not re-create — the pool. It takes the `AuthCognito` instance via options and reuses its discovery channel:

- **AWS runtime:** re-derives the same env vars via `envVarNames(auth.fullId)` (`KIT_AUTH_COGNITO_<UPPER_FULLID>_USER_POOL_ID` etc.), so it talks to the exact pool `AuthCognito` created. No new env vars, no second pool.
- **Mock:** reads and writes the **same** `.bb-data/<auth.fullId>/state.json` that the mock `AuthCognito` persists, so a membership change made by the admin block is visible to the next `signIn` / `requireRole` on the auth block (mock reloads state from disk and `flushToDisk()`es on every write).
- **CDK:** adds an IAM policy statement granting the API handler the `Admin*` / `List*` actions, scoped to `auth.userPool.userPoolArn` (public getter on the CDK construct). No resources are created.

Because it holds the `AuthCognito` reference, the admin block re-threads the generic options literal `O` to keep group-name narrowing: `addUserToGroup(username, group: GroupOf<O>)` is a compile error on a typo'd group.

## API Surface

### Generic type contract

`AuthCognitoAdmin<O extends AuthCognitoOptions = AuthCognitoOptions>` mirrors `AuthCognito<O>`. The generic is recovered from the `auth` option (`AuthCognitoAdminOptions<O>.auth: AuthCognito<O>`), so callers who passed `as const` options to `AuthCognito` get the same narrowed `GroupOf<O>` on the admin methods with no extra annotation.

> **Caveat — narrowing requires `as const` discipline.** `GroupOf<O>` only narrows when the `auth` **variable's static type** carries the narrowed `O`, which happens only when its options were passed `as const` (the literal-tuple guard in `types.ts:175-177`). A pool declared `new AuthCognito(scope, 'auth', { groups: ['admins', 'readers'] })` **without** `as const` (as the comprehensive test-app does) has `O = AuthCognitoOptions`, so `GroupOf<O>` collapses to `string` and `addUserToGroup` accepts any string. This is the same behavior as `AuthCognito.requireRole` and is not a regression — but the narrowing is **opt-in**, not automatic. Document it in the README.

```typescript
/**
 * Server-side admin surface for an AuthCognito User Pool.
 *
 * **When to use:** You need privileged user-lifecycle or group-membership
 * operations — seed the first admin, build an internal user-management
 * screen, or script membership changes.
 *
 * **When NOT to use:** For client-facing auth (sign-in/up, MFA, profile
 * self-service) use `AuthCognito`. These methods are privileged — always
 * gate them behind `auth.requireRole(ctx, 'admins')`.
 *
 * **Best practices:**
 * - Expose admin methods only from API routes guarded by `requireRole`.
 * - Prefer `scan()` for enumeration; it communicates full-pool cost (G14).
 * - Seed the first admin via a one-off script/migration, not a public route
 *   (bootstrapping paradox: the first admin can't be promoted by an admin).
 *
 * **Scaling:** Admin/List APIs share the Cognito account-level quota with
 * the client-facing pool (~25 req/s for many Admin* actions, adjustable via
 * Service Quotas). `scan()` paginates internally (60 users/page) and is
 * O(total users) — do not call it on a hot path.
 */
class AuthCognitoAdmin<O extends AuthCognitoOptions = AuthCognitoOptions> extends Scope {
	/**
	 * @param scope - Parent scope to attach to.
	 * @param id - Unique identifier within the parent scope.
	 * @param options - Must include the `auth` block whose pool to administer.
	 *
	 * @example
	 * ```typescript
	 * const auth  = new AuthCognito(scope, 'auth', { groups: ['admins'] as const });
	 * const admin = new AuthCognitoAdmin(scope, 'admin', { auth });
	 * ```
	 */
	constructor(scope: ScopeParent, id: string, options: AuthCognitoAdminOptions<O>);

	// ── Group membership ──────────────────────────────────────────────────

	/**
	 * Add a user to a group. Idempotent — adding an already-member is a no-op.
	 * @param username - The username (or sub) to add.
	 * @param group - The group name. Narrowed to `GroupOf<O>` when `auth` was
	 *   configured with `groups: [...] as const`.
	 * @throws {AuthCognitoAdminErrors.UserNotFound} If the user does not exist.
	 * @throws {AuthCognitoAdminErrors.GroupNotFound} If the group does not exist.
	 * @example
	 * ```typescript
	 * await admin.addUserToGroup('alice', 'admins');
	 * ```
	 */
	addUserToGroup(username: string, group: GroupOf<O>): Promise<void>;

	/**
	 * Remove a user from a group. Idempotent on membership: removing a user who
	 * is not a member succeeds as a no-op (matches Cognito's
	 * `AdminRemoveUserFromGroup`, which does not error on a non-member). Still
	 * throws if the *user* or the *group* itself does not exist.
	 * @throws {AuthCognitoAdminErrors.UserNotFound} If the user does not exist.
	 * @throws {AuthCognitoAdminErrors.GroupNotFound} If the group does not exist.
	 * @example
	 * ```typescript
	 * await admin.removeUserFromGroup('alice', 'admins');
	 * ```
	 */
	removeUserFromGroup(username: string, group: GroupOf<O>): Promise<void>;

	/**
	 * List the groups a user belongs to.
	 * @returns The user's group names (narrowed to `GroupOf<O>[]`). Empty array
	 *   if the user is in no groups.
	 * @throws {AuthCognitoAdminErrors.UserNotFound} If the user does not exist.
	 * @example
	 * ```typescript
	 * const groups = await admin.getUserGroups('alice'); // ['admins']
	 * ```
	 */
	getUserGroups(username: string): Promise<GroupOf<O>[]>;

	/**
	 * Enumerate the members of a group. Unbounded — returns `AsyncIterable`
	 * and paginates internally (G5).
	 * @throws {AuthCognitoAdminErrors.GroupNotFound}
	 * @example
	 * ```typescript
	 * for await (const user of admin.getUsersInGroup('admins')) {
	 *   console.log(user.username);
	 * }
	 * ```
	 */
	getUsersInGroup(group: GroupOf<O>): AsyncIterable<CognitoUser<O>>;

	// ── User lifecycle ──────────────────────────────────────────────────────

	/**
	 * Look up a single user by username. Returns `null` if not found (G3).
	 * @returns The user, or `null` if no such user exists.
	 * @example
	 * ```typescript
	 * const user = await admin.getUser('alice');
	 * if (user) console.log(user.groups);
	 * ```
	 */
	getUser(username: string): Promise<CognitoUser<O> | null>;

	/**
	 * Enumerate all users in the pool. Full-pool cost — named `scan` to
	 * communicate that it reads every user (G14). Paginates internally.
	 * @param options - Optional typed `filter` for the limited set of
	 *   attributes Cognito's `ListUsers` can narrow on server-side (G18).
	 * @returns An `AsyncIterable` of users; consume with `for await`.
	 * @example
	 * ```typescript
	 * for await (const user of admin.scan({ filter: { attribute: 'email', op: '^=', value: 'a' } })) {
	 *   console.log(user.username);
	 * }
	 * ```
	 */
	scan(options?: AdminScanOptions): AsyncIterable<CognitoUser<O>>;

	/**
	 * Administratively create a user, bypassing self-sign-up. The user is
	 * created in a `FORCE_CHANGE_PASSWORD` state unless `options.permanent`.
	 * @returns The created user.
	 * @throws {AuthCognitoAdminErrors.UserAlreadyExists}
	 * @throws {AuthCognitoAdminErrors.InvalidPassword}
	 * @example
	 * ```typescript
	 * await admin.createUser('bob', { temporaryPassword: 'Temp1!pass',
	 *   attributes: { email: 'bob@example.com' }, groups: ['readers'] });
	 * ```
	 */
	createUser(username: string, options?: AdminCreateUserOptions<O>): Promise<CognitoUser<O>>;

	/**
	 * Permanently delete a user. Idempotent only if the user exists; deleting
	 * a missing user throws (precondition violation, G3).
	 * @throws {AuthCognitoAdminErrors.UserNotFound}
	 */
	deleteUser(username: string): Promise<void>;

	/**
	 * Disable a user — blocks all sign-in without deleting the record. Toggles
	 * the `disabled` flag the mock `signIn` already enforces (`index.ts:452`).
	 * @throws {AuthCognitoAdminErrors.UserNotFound} If the user does not exist.
	 * @example
	 * ```typescript
	 * await admin.disableUser('alice'); // alice can no longer sign in
	 * ```
	 */
	disableUser(username: string): Promise<void>;

	/**
	 * Re-enable a previously disabled user.
	 * @throws {AuthCognitoAdminErrors.UserNotFound} If the user does not exist.
	 * @example
	 * ```typescript
	 * await admin.enableUser('alice');
	 * ```
	 */
	enableUser(username: string): Promise<void>;

	/**
	 * Force a password reset on the user's next sign-in (admin-initiated).
	 * Does not email a code in mock mode (logged to console instead).
	 * @throws {AuthCognitoAdminErrors.UserNotFound} If the user does not exist.
	 * @example
	 * ```typescript
	 * await admin.resetUserPassword('alice');
	 * ```
	 */
	resetUserPassword(username: string): Promise<void>;

	/**
	 * Set a user's password directly (admin override).
	 * @param permanent - When `true`, the password is permanent; when `false`
	 *   the user must change it on next sign-in. Default: `false`.
	 * @throws {AuthCognitoAdminErrors.UserNotFound} If the user does not exist.
	 * @throws {AuthCognitoAdminErrors.InvalidPassword} If the password fails policy.
	 * @example
	 * ```typescript
	 * await admin.setUserPassword('alice', 'NewP@ss1!', { permanent: true });
	 * ```
	 */
	setUserPassword(username: string, password: string, options?: { permanent?: boolean }): Promise<void>;

	/**
	 * Revoke all of a user's active sessions, forcing re-authentication.
	 *
	 * Use after a group change to make the new permissions take effect
	 * immediately — otherwise the user's existing token keeps its stale
	 * `cognito:groups` claim until it expires/refreshes (see DESIGN §
	 * Session-freshness). AWS: `AdminUserGlobalSignOut`; mock: deletes the
	 * user's session records.
	 * @throws {AuthCognitoAdminErrors.UserNotFound}
	 */
	revokeUserSessions(username: string): Promise<void>;
}

interface AuthCognitoAdminOptions<O extends AuthCognitoOptions = AuthCognitoOptions> {
	/** The AuthCognito block whose User Pool this block administers. Required. */
	auth: AuthCognito<O>;
}

interface AdminScanOptions {
	/**
	 * Server-side narrowing on a single indexed attribute. Modeled as a typed
	 * subset rather than a raw Cognito filter string (G10 — no leaking the
	 * service's filter DSL; G18 — only attributes Cognito can narrow on
	 * server-side are offered). Omit for all users.
	 *
	 * `op: '^='` is prefix-match; `'='` is exact. `attribute` is limited to
	 * the standard set Cognito's `ListUsers` `Filter` supports natively.
	 */
	filter?: {
		attribute: 'username' | 'email' | 'phone_number' | 'sub' | 'status';
		op: '=' | '^=';
		value: string;
	};
}

interface AdminCreateUserOptions<O extends AuthCognitoOptions = AuthCognitoOptions> {
	/** Temporary password. If omitted, Cognito generates one. */
	temporaryPassword?: string;
	/** When true, the password is permanent (no FORCE_CHANGE_PASSWORD). */
	permanent?: boolean;
	/** Standard + custom attributes. Keys narrowed to `AttrOf<O>`. */
	attributes?: Partial<Record<AttrOf<O>, string>>;
	/** Suppress the Cognito invitation message. Default: true (admin flows). */
	suppressInvite?: boolean;
	/** Groups to add the user to immediately after creation. */
	groups?: readonly GroupOf<O>[];
}
```

`CognitoUser<O>`, `GroupOf<O>`, `AttrOf<O>`, and `AuthCognitoOptions` are re-exported from `@aws-blocks/bb-auth-cognito` — the admin block adds no parallel user type (G2: one client-safe shape across the ecosystem).

No `createApi()` — admin operations are not part of the client Authenticator state machine. Customers wire their own guarded `ApiNamespace` routes (see Usage Examples).

**Deliberate G14 verb deviations.** Two method names depart from the G14 "verbs to avoid" guidance, intentionally, because they mirror the underlying Cognito admin verbs that have no idempotent/upsert equivalent:
- `createUser` (not `put` + `{ ifNotExists }`): Cognito's `AdminCreateUser` is genuinely non-idempotent — it throws `UsernameExistsException` on a duplicate and there is no admin upsert. `create` communicates that semantics honestly; a `put` name would falsely imply idempotent replace.
- `setUserPassword` (not `put`): mirrors Cognito's `AdminSetUserPassword`, the recognized name for the operation.

**No `fromExisting` (G9).** The admin block provisions no resources, so it has no `fromExisting` factory. Pool lifecycle is owned by the referenced `AuthCognito`, which has its own `fromExisting`. An admin block transparently administers a `fromExisting` pool: the AWS runtime discovers it through the same `envVarNames(auth.fullId)` env vars, which the AWS `AuthCognito` constructor registers for `fromExisting` pools too (`index.aws.ts:613`).

## Error Constants

```typescript
export const AuthCognitoAdminErrors = {
	UserNotFound: 'UserNotFoundException',
	UserAlreadyExists: 'UsernameExistsException',
	GroupNotFound: 'ResourceNotFoundException',
	InvalidPassword: 'InvalidPasswordException',
	InvalidParameter: 'InvalidParameterException',   // createUser with a bad attribute, etc.
	LimitExceeded: 'LimitExceededException',          // admin-create / list throttling at the pool level
	TooManyRequests: 'TooManyRequestsException',      // account-level throttling
	UnsupportedUserState: 'UnsupportedUserStateException', // e.g. setUserPassword on a not-yet-confirmed user
	NotAuthorized: 'NotAuthorizedException',
} as const;
```

Each value is a subset of the parent `AuthCognitoErrors` (`types.ts:805-820`) with identical string values, so the two constants are interchangeable in `isKitError`. The lifecycle methods surface the extra codes (`InvalidParameter`, `LimitExceeded`, `TooManyRequests`, `UnsupportedUserState`) because `AdminCreateUser` / `AdminSetUserPassword` / `ListUsers` throw them where the client-facing surface never would.

Names match the Cognito SDK error names (G6) so customers who know Cognito recognize them. Every value here is **identical to the corresponding `AuthCognitoErrors` value in the shipped code** (`types.ts:805-820`): `NotAuthorized`→`NotAuthorizedException`, `UserNotFound`→`UserNotFoundException`, `UserAlreadyExists`→`UsernameExistsException`, `InvalidPassword`→`InvalidPasswordException`, and `GroupNotFound`→`ResourceNotFoundException`. So `isKitError(e, AuthCognitoAdminErrors.X)` and `isKitError(e, AuthCognitoErrors.X)` are interchangeable for the overlapping codes — no divergence.

> **⚠️ Stale parent doc:** `BB-auth-cognito.md:296` documents `GroupNotFound: 'GroupNotFoundException'`, which does **not** match the shipped code (`types.ts:820` = `'ResourceNotFoundException'`). This admin doc follows the code. The parent doc should be corrected separately.

## Infrastructure (CDK)

Composite — **no resources created**. The CDK implementation only adds an IAM grant to the API handler, scoped to the pool owned by the referenced `AuthCognito`:

```typescript
// inside AuthCognitoAdmin (CDK) constructor
const poolArn = options.auth.userPool.userPoolArn;   // public getter on the CDK construct
this.handler.addToRolePolicy(new iam.PolicyStatement({
	actions: [
		'cognito-idp:AdminAddUserToGroup',
		'cognito-idp:AdminRemoveUserFromGroup',
		'cognito-idp:AdminListGroupsForUser',
		'cognito-idp:ListUsersInGroup',
		'cognito-idp:ListUsers',
		'cognito-idp:AdminGetUser',
		'cognito-idp:AdminCreateUser',
		'cognito-idp:AdminDeleteUser',
		'cognito-idp:AdminEnableUser',
		'cognito-idp:AdminDisableUser',
		'cognito-idp:AdminResetUserPassword',
		'cognito-idp:AdminSetUserPassword',
		'cognito-idp:AdminUserGlobalSignOut',
	],
	resources: [poolArn],
}));
```

These are deliberately **separate** from the client-facing grant in `AuthCognito.grantCognitoPermissions` (which intentionally excludes `Admin*`). Keeping the admin grant in the admin block means an app that never instantiates `AuthCognitoAdmin` never grants its handler admin privileges — least privilege by composition.

- **Removal policy:** N/A (no resources).
- **Naming:** N/A.
- **Discovery:** none added — reuses `AuthCognito`'s env vars via `envVarNames(auth.fullId)`.

> **Load-bearing assumption: one Lambda handler per stack.** Both the CDK grant (`this.handler.addToRolePolicy`) and the AWS-runtime discovery (`envVarNames(auth.fullId)` read from `process.env`) rely on KIT's single-shared-handler model — `Scope.handler` walks up to the one `KitStack` handler (`core/src/cdk/index.ts:81-92`), and the auth block writes its discovery env vars onto that same function. This design is correct **because** of that model. If KIT ever introduces per-block Lambdas, the admin block's handler would need its own grant + env vars and this section must be revisited.

### Package layout & browser stub

`bb-auth-cognito` ships an `index.browser.ts` because it is client-facing and must not bundle the AWS SDK into client code. `AuthCognitoAdmin` is **server-only** (no client plugin, no Transferable, no `createApi`) but it imports `@aws-sdk/client-cognito-identity-provider` for its `Admin*` commands. Per the architecture guide a composite's `index.browser.ts` is "optional" — but because the package pulls in the AWS SDK, it **must** ship an `index.browser.ts` stub if the package is ever transitively reachable from a client bundle, to prevent the SDK from bundling. The stub should throw on construction (the admin block has no legitimate browser use). Open Question 5 (separate package vs `bb-auth-cognito/admin` subpath) interacts with this: a separate package keeps the SDK dependency fully opt-in.

## Mock Implementation

> **Research note — why file-sharing does NOT work.** The obvious approach ("both blocks point at `.bb-data/<auth.fullId>/state.json`") is **incorrect** and would silently corrupt state. Confirmed by reading `index.ts`:
>
> 1. The mock loads the state file into memory **once, in the constructor** (`this.state = this.loadFromDisk()`, `index.ts:216`) and **never reloads it** — there is no per-request re-read anywhere in the file.
> 2. Blocks are instantiated **once at app-module scope** (e.g. `const authC = new AuthCognito(scope, 'authC', …)` in `test-apps/comprehensive/aws-blocks/index.ts:64`) and the dev server imports that module a single time (`dev-server.ts:76`, `await import(backendUrl)`). Every request reuses the **same long-lived instances**.
>
> So two instances pointed at the same file each hold their own in-memory `state`. A write from the admin instance flushes to disk, but the auth instance's in-memory copy is stale and its next `flushToDisk()` (e.g. on the next `signIn`) **overwrites the admin's change**. Last-flush-wins, lost updates, no visibility. File-sharing is a non-starter given the load-once model.

**Correct approach: the admin mock delegates to the live auth instance's in-memory state.** Because the customer passes the real `AuthCognito` instance via `{ auth }`, and both live in the same process, the admin block operates on the *same object*, not a copy. This is also why the standalone `{ auth }` wiring (vs a free-standing constructor that only knows a `fullId`) is the right call — it hands the admin block a live reference, not just a discovery key.

Concretely, the mock `AuthCognito` exposes a **narrow internal admin port** — a small interface, not its whole private state — that the admin mock calls:

```typescript
// Exposed from bb-auth-cognito via an "./internal" subpath export (types-free,
// not part of the public API surface; see Resolved Decision 1).
export interface CognitoMockAdminPort {
	addToGroup(username: string, group: string): void;      // throws UserNotFound / GroupNotFound
	removeFromGroup(username: string, group: string): void;
	groupsOf(username: string): string[];
	membersOf(group: string): MockUserRecord[];
	allUsers(): MockUserRecord[];
	getUser(username: string): MockUserRecord | null;
	createUser(username: string, init: AdminCreateInit): MockUserRecord;
	deleteUser(username: string): void;
	setDisabled(username: string, disabled: boolean): void;
	setForcePasswordChange(username: string, force: boolean): void;  // reuses existing `forcePasswordChange` flag (index.ts:506)
	setPassword(username: string, password: string, permanent: boolean): void;
	// every mutator calls the existing private flushToDisk() internally
}
```

The mock `AuthCognito` implements this against its single in-memory `state` (and its existing `flushToDisk()`), so every admin mutation is **immediately visible** to that same instance's `signIn` / `getCurrentUser` / `requireRole`. The admin block owns zero knowledge of the on-disk file format — it only knows the port. Behavioral notes:

> **`/internal` conditional-export resolution (must be specified before build).** The port is a **mock-only** construct — it lives on the mock `AuthCognito` (`index.ts`), which is the `default` entry. There is no in-memory `state` under `aws-runtime` or `cdk`. So `@aws-blocks/bb-auth-cognito/internal` resolves per condition:
> - `default` (mock) → the real `CognitoMockAdminPort` interface + a factory that returns the live instance's port.
> - `aws-runtime` / `cdk` → a stub that **throws** if called (the admin block's AWS/CDK entries never import it).
>
> The discipline that keeps this sound: only the admin block's **mock entry** (`index.ts`) imports the port. Its `index.aws.ts` talks to Cognito via the SDK; its `index.cdk.ts` only adds the IAM grant. Neither touches `/internal`.
>
> This does **not** interact with the export-parity test. `conditional-exports.test.ts` imports only the bare package specifier (`import('${pkg}')` = the `"."` subpath) and asserts each condition's exports are a superset of `default`'s (`conditional-exports.test.ts:42-64`). It never inspects `/internal` or any other subpath — the existing `./ui` subpath is equally outside its view. So `/internal` is simply **out of scope** for that test, not specially excluded.

Behavioral notes:

- **Group membership:** `addToGroup` appends to `state.groups[group]`, throwing `GroupNotFound` when the group was never seeded (matches Cognito, which has no implicit group creation); `removeFromGroup` filters it out. This is the plumbing that is currently missing and the direct cause of the bug.
- **User lifecycle:** `createUser` writes a `MockUserRecord` mirroring `signUp` (reusing `prefixCustomAttrs`, password-policy enforcement); `deleteUser` removes the record **and** strips the user from every `state.groups` array; `disableUser`/`enableUser` toggle the existing `disabled` flag on `MockUserRecord` (already present at `index.ts:291`); `resetUserPassword` / `setUserPassword` set the existing `forcePasswordChange` flag (`index.ts:506`) and/or the password. **Reuse the existing flag name `forcePasswordChange` — do not introduce a parallel `forceChangePassword`.**
- **Enumeration:** `scan` / `getUsersInGroup` iterate the in-memory maps and yield page-by-page to exercise the same `AsyncIterable` consumption path the AWS pagination uses.
- **Disabled-user enforcement is ALREADY shipped.** The mock `AuthCognito.signIn` already rejects disabled users (`index.ts:452`: `if (!user || user.disabled) throw NotAuthorized`). This block does **not** need to wire that check. Its work is to add the `disableUser`/`enableUser` mutators that toggle the flag, plus a regression test asserting the existing `signIn` enforcement keeps working.

### Session-freshness (resolves former Open Question 4)

After `addUserToGroup`, a user with an **existing session** still carries the old `cognito:groups` claim until their token refreshes — `requireRole` (mock `index.ts:978`, AWS `index.aws.ts:1306`) reads the claim, not live state, in both runtimes (both resolve the user by decoding the stored ID token: mock `getCurrentUser` at `index.ts:894`, AWS `toCognitoUser` at `index.aws.ts:1916`). This is **inherent Cognito behavior, not a KIT bug**, and must be documented. Two mitigations the block provides:

- The mock's `fetchAuthSession({ forceRefresh: true })` already re-reads `state.groups` when re-minting the token (`index.ts:950-952`), and the AWS runtime re-issues via `REFRESH_TOKEN_AUTH` — so a client refresh picks up the new group.
- For immediate effect, the block exposes `revokeUserSessions(username)` (AWS: `AdminUserGlobalSignOut`; mock: delete the user's session records), forcing the user to re-authenticate and mint a fresh claim. Documented as the way to make a permission change take effect now.

## Mock vs AWS Parity Gap Mitigations

| Parity Gap | Impact | Mitigation |
|------------|--------|------------|
| No IAM enforcement in mock | An ungated admin route "works" locally but 403s in AWS only if the guard is missing | Document that admin routes must be `requireRole`-gated; mock logs a warning the first time an admin method runs without an authenticated admin in context (best-effort) |
| Mock `createUser` skips invitation email / SMS | No real invite delivered locally | Mock logs the temporary password to console (same convention as `signUp` codes) |
| `ListUsers` filter expression not fully emulated | Mock applies a simplified prefix/equality match; complex Cognito filter syntax may differ | Document supported subset; recommend sandbox testing for non-trivial filters |
| Account-level Admin* throttling not simulated | Bulk admin scripts that would throttle in AWS succeed locally | No mitigation — quotas are account-level and non-deterministic; document the gap |
| Disabled-user sign-in block | Already at parity — both runtimes reject disabled users | No new work: the mock `signIn` already enforces `disabled` (`index.ts:452`); AWS Cognito enforces it natively. This block only adds the `disableUser`/`enableUser` mutators that flip the flag |

## AWS Runtime Implementation (`index.aws.ts`)

Mirrors the structure of `bb-auth-cognito/src/index.aws.ts` exactly — same client, same discovery, same error-mapping helper — so the two files read as siblings.

**Construction & discovery.** No new env vars. The admin block reads the pool ID off the referenced auth block's discovery channel:

```typescript
import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand, AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand, ListUsersInGroupCommand, ListUsersCommand,
  AdminGetUserCommand, AdminCreateUserCommand, AdminDeleteUserCommand,
  AdminEnableUserCommand, AdminDisableUserCommand,
  AdminResetUserPasswordCommand, AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { ApiError, Scope, getSdkIdentifiers } from '@aws-blocks/core';

export class AuthCognitoAdmin<O extends AuthCognitoOptions = AuthCognitoOptions> extends Scope {
  private readonly client: CognitoIdentityProviderClient;
  private readonly auth: AuthCognito<O>;

  constructor(scope: ScopeParent, id: string, options: AuthCognitoAdminOptions<O>) {
    super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
    this.auth = options.auth;
    // Same lazy region resolution as AuthCognito; client is cheap to build.
    const { userPoolId, region } = getSdkIdentifiers(this.auth); // registered by AuthCognito ctor
    this.client = new CognitoIdentityProviderClient({ region });
  }

  private get userPoolId(): string {
    const { userPoolId } = getSdkIdentifiers(this.auth);
    if (!userPoolId) throw new ApiError(
      'AuthCognitoAdmin: pool not discovered — did the AuthCognito CDK construct run?', 500);
    return userPoolId;
  }
```

**Every method is a thin SDK wrapper through the shared `asApiError`** (reuse the exact helper from `index.aws.ts:531` — it maps `e.name` → HTTP status and preserves the Cognito exception name so `isKitError` works):

```typescript
  async addUserToGroup(username: string, group: GroupOf<O>): Promise<void> {
    try {
      await this.client.send(new AdminAddUserToGroupCommand({
        UserPoolId: this.userPoolId, Username: username, GroupName: group as string,
      }));
    } catch (e) { throw asApiError(e); }
  }

  async getUser(username: string): Promise<CognitoUser<O> | null> {
    try {
      const r = await this.client.send(new AdminGetUserCommand({
        UserPoolId: this.userPoolId, Username: username }));
      const groups = await this.fetchGroups(username);                 // AdminListGroupsForUser
      return toCognitoUser({ username: r.Username!, attributes: attrsToRecord(r.UserAttributes), groups });
    } catch (e) {
      if (e instanceof Error && e.name === 'UserNotFoundException') return null;  // G3: null for absence
      throw asApiError(e);
    }
  }

  async *scan(options?: AdminScanOptions): AsyncIterable<CognitoUser<O>> {
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListUsersCommand({
        UserPoolId: this.userPoolId,
        Filter: options?.filter ? `${options.filter.attribute} ${options.filter.op} "${options.filter.value}"` : undefined,
        Limit: 60, PaginationToken: token,
      }));
      for (const u of r.Users ?? []) yield toCognitoUser({
        username: u.Username!, attributes: attrsToRecord(u.Attributes), groups: [] }); // groups omitted on scan (cost)
      token = r.PaginationToken;
    } while (token);
  }
```

**Notes that matter for the build:**
- `getUser` returns `null` on `UserNotFoundException` (G3) — the *only* place that swallows an SDK error; everything else rethrows via `asApiError`.
- `scan` and `getUsersInGroup` use the **identical pagination loop** as `fetchDevices` (`index.aws.ts:1555-1580`): `Limit: 60`, `do { … } while (PaginationToken)`. `scan` yields users *without* resolving each one's groups — doing a per-user `AdminListGroupsForUser` inside a full-pool scan would be O(users) extra calls (a G18 cost trap). `getUser`/`getUsersInGroup` resolve groups because they're bounded.
- `createUser` maps `permanent` → a follow-up `AdminSetUserPassword({ Permanent: true })` after `AdminCreateUser` (Cognito has no single "create with permanent password" call), and `suppressInvite` → `MessageAction: 'SUPPRESS'`. Reuse `attrsToList` (`index.aws.ts:150`) + `prefixCustomAttrs` for attribute marshalling.
- `revokeUserSessions` → `AdminUserGlobalSignOutCommand`. Note it invalidates Cognito refresh tokens but the customer's **server-side KVStore session record still exists** until its next access-token expiry; document that the user is fully locked out only after the access token TTL, or pair with deleting the session record if immediate lockout is required.
- `toCognitoUser` is a tiny local shaper to the **same `CognitoUser<O>`** the auth block returns (G2 — one shape). Do not invent a parallel `AdminUser` type.

## Package Scaffold & Conditional Exports

New package `packages/bb-auth-cognito-admin/` following the standard four-entry layout (`08-building-block-architecture.md`):

```
packages/bb-auth-cognito-admin/
├── package.json            # exports map below; deps: bb-auth-cognito, core, @aws-sdk/client-cognito-identity-provider
├── README.md               # G11 source-of-truth docs (mirror class JSDoc)
├── DESIGN.md               # this design, condensed for extenders
├── tsconfig.json
└── src/
    ├── types.ts            # AuthCognitoAdminOptions, AdminScanOptions, AdminCreateUserOptions, AuthCognitoAdminErrors
    │                       #   — re-exports CognitoUser/GroupOf/AttrOf from bb-auth-cognito (no parallel types)
    ├── index.ts            # default (mock) — imports the /internal port from bb-auth-cognito
    ├── index.aws.ts        # aws-runtime — SDK wrappers above
    ├── index.cdk.ts        # cdk — IAM grant only
    ├── index.browser.ts    # browser — throwing stub (prevents AWS SDK bundling; server-only block)
    ├── version.ts          # BB_NAME / BB_VERSION (generated, matches bb-auth-cognito convention)
    └── *.test.ts           # see Test Plan
```

```jsonc
// package.json exports — identical condition order to bb-auth-cognito
{
  "name": "@aws-blocks/bb-auth-cognito-admin",
  "exports": {
    ".": {
      "browser": "./dist/index.browser.js",
      "cdk":         { "types": "./dist/index.cdk.d.ts", "default": "./dist/index.cdk.js" },
      "aws-runtime": "./dist/index.aws.js",
      "types":       "./dist/index.d.ts",
      "default":     "./dist/index.js"
    }
  }
}
```

**The one change required in `bb-auth-cognito` itself** — add an `./internal` subpath that exposes the mock admin port. This is the only edit to the existing package:

```jsonc
// bb-auth-cognito/package.json — add alongside "." and "./ui"
"./internal": {
  "types":       "./dist/internal.d.ts",
  "aws-runtime": "./dist/internal.aws.js",   // throwing stub
  "cdk":         "./dist/internal.cdk.js",   // throwing stub
  "default":     "./dist/internal.js"        // real port factory (mock)
}
```

`internal.ts` (mock) exports `getCognitoMockAdminPort(auth: AuthCognito): CognitoMockAdminPort`, returning a port bound to that instance's live in-memory `state` (+ its private `flushToDisk`). The `aws-runtime`/`cdk` stubs throw if imported (the admin block's aws/cdk entries never touch them). This subpath is invisible to `conditional-exports.test.ts` (it only imports the bare `"."`), so parity is unaffected — but the umbrella `@aws-blocks/blocks` must **not** re-export `/internal` (it's not customer API).

## Test Plan

Mirrors `bb-auth-cognito`'s test layout (`*.test.ts` per entry + a sandbox suite):

| File | Covers |
|---|---|
| `index.test.ts` (mock) | Full lifecycle against the mock port: add/remove group → `getUserGroups` reflects it → a **fresh `auth.signIn`** then sees the new claim in `requireRole` (the end-to-end bug-fix assertion); `createUser`+`groups` → member appears in `getUsersInGroup`; `deleteUser` strips group membership; `disableUser` → `auth.signIn` throws `NotAuthorized` (regression-guards the already-shipped `index.ts:452` check); `removeUserFromGroup` non-member = no-op; `addUserToGroup` to unseeded group throws `GroupNotFound`. |
| `index.cdk.test.ts` | Synth a stack with `AuthCognito` + `AuthCognitoAdmin`; assert the handler role has the 13 `Admin*`/`List*` actions scoped to the pool ARN, and that an app **without** the admin block has none of them (least-privilege regression). |
| `types.types-test.ts` | `addUserToGroup(u, 'typo')` is a compile error when `auth` was built with `groups: [...] as const`; widens to `string` without `as const` (matches `requireRole`). |
| `scenarios.sandbox.test.ts` | Real-Cognito: create user → add to group → user signs in → ID token carries `cognito:groups` → `requireRole` passes; `revokeUserSessions` invalidates refresh. Gated behind the same sandbox harness as `bb-auth-cognito`. |

## Serialization

All return values are plain `CognitoUser<O>` objects (or `null`, or `void`) — natively `JSON.stringify`-able and client-safe (G2). `getUsersInGroup` / `scan` return server-only `AsyncIterable` (G5): consume them inside an API method and return a collected plain array to the client; an `AsyncIterable` cannot cross the wire directly.

## Usage Examples

> **How a blocks customer builds an admin UI in v1.** There is no auto-generated admin panel yet (an `AdminSite` "Users" panel is future, additive work — see Resolved Decision 9). The first-class, supported path *today* is exactly what's shown below: the customer wires **their own guarded `ApiNamespace` routes** over `AuthCognitoAdmin` and renders the plain-data responses in their own frontend. The "full user-management admin screen" example is a copy-pasteable starting point for that.

### Guarded admin routes (the only correct way to expose these)

```typescript
const auth  = new AuthCognito(scope, 'auth', { groups: ['admins', 'readers'] as const });
const admin = new AuthCognitoAdmin(scope, 'admin', { auth });

export const adminApi = new ApiNamespace(scope, 'admin-api', (context: KitContext) => ({
	async promote(username: string) {
		await auth.requireRole(context, 'admins');        // gate first
		await admin.addUserToGroup(username, 'admins');     // GroupOf<O>-typed
	},
	async listAdmins() {
		await auth.requireRole(context, 'admins');
		const out: CognitoUser<typeof auth.options>[] = [];
		for await (const u of admin.getUsersInGroup('admins')) out.push(u);
		return out;                                         // plain array → client-safe
	},
}));
```

### Seeding the first admin (bootstrap script, not a public route)

```typescript
// scripts/seed-admin.ts — run once via a migration/CLI, not from the API.
// Solves the bootstrapping paradox: no admin exists yet to promote the first one.
await admin.createUser('founder', {
	temporaryPassword: process.env.SEED_PASSWORD,
	attributes: { email: 'founder@example.com' },
	groups: ['admins'],
});
```

### Error handling

```typescript
import { isKitError } from '@aws-blocks/core';
import { AuthCognitoAdminErrors } from '@aws-blocks/bb-auth-cognito-admin';

try {
	await admin.addUserToGroup(username, 'admins');
} catch (e) {
	if (isKitError(e, AuthCognitoAdminErrors.UserNotFound)) { /* surface 404 */ }
	if (isKitError(e, AuthCognitoAdminErrors.GroupNotFound)) { /* misconfigured group */ }
	throw e;
}
```

### Real-world: a full user-management admin screen

A complete backend for an internal "Users" admin page — list with search, view detail, change role, suspend. Every route gated; every return value plain data the frontend renders directly.

```typescript
const auth  = new AuthCognito(scope, 'auth', {
	groups: ['admins', 'editors', 'readers'] as const,
});
const admin = new AuthCognitoAdmin(scope, 'admin', { auth });

export const usersAdminApi = new ApiNamespace(scope, 'users-admin-api', (context: KitContext) => {
	// One gate helper, applied at the top of every method.
	const gate = () => auth.requireRole(context, 'admins');

	return {
		// Paginated list. AsyncIterable is server-only (G5) — collect a page and
		// return plain data. Optional server-side prefix search on email.
		async listUsers(emailPrefix?: string) {
			await gate();
			const users: CognitoUser<typeof auth.options>[] = [];
			const iter = emailPrefix
				? admin.scan({ filter: { attribute: 'email', op: '^=', value: emailPrefix } })
				: admin.scan();
			for await (const u of iter) {
				users.push(u);
				if (users.length >= 100) break;           // cap the page in the handler
			}
			return users;                                 // plain array → client-safe
		},

		async getUserDetail(username: string) {
			await gate();
			return await admin.getUser(username);         // CognitoUser | null
		},

		// Change a user's single role: remove from all configured groups, add the new one.
		async setRole(username: string, role: 'admins' | 'editors' | 'readers') {
			await gate();
			const current = await admin.getUserGroups(username);
			await Promise.all(current.map((g) => admin.removeUserFromGroup(username, g)));
			await admin.addUserToGroup(username, role);
			// Make the change effective immediately rather than next token refresh:
			await admin.revokeUserSessions(username);
			return { username, role };
		},

		async suspendUser(username: string) {
			await gate();
			await admin.disableUser(username);
			await admin.revokeUserSessions(username);     // kick active sessions
			return { username, status: 'suspended' };
		},

		async reinstateUser(username: string) {
			await gate();
			await admin.enableUser(username);
			return { username, status: 'active' };
		},
	};
});
```

### Real-world: bulk onboarding from a CSV (background job)

Admin-create a batch of users with a temp password and an initial role. Run from an `AsyncJob` or a CLI script — not a request handler — so a large batch isn't bound to one HTTP timeout.

```typescript
async function onboard(rows: { email: string; role: 'editors' | 'readers' }[]) {
	for (const { email, role } of rows) {
		try {
			await admin.createUser(email, {
				attributes: { email },
				groups: [role],
				suppressInvite: false,   // let Cognito email the temp password + invite
			});
		} catch (e) {
			if (isKitError(e, AuthCognitoAdminErrors.UserAlreadyExists)) continue;  // idempotent re-run
			throw e;
		}
	}
}
```

### Real-world: "make me an admin" is impossible by design — seed instead

There's a deliberate bootstrapping paradox: `setRole` is gated by `requireRole('admins')`, so with zero admins nobody can create the first one through the API. That's correct — promotion must not be self-service. Seed the first admin out-of-band:

```typescript
// scripts/seed-admin.ts — `npx tsx scripts/seed-admin.ts`, run once per environment.
import { admin } from '../aws-blocks/index.js';

await admin.createUser(process.env.FOUNDER_EMAIL!, {
	temporaryPassword: process.env.FOUNDER_TEMP_PASSWORD!,
	attributes: { email: process.env.FOUNDER_EMAIL! },
	groups: ['admins'],
});
console.log('Seeded founding admin. Sign in and change the temporary password.');
```

### Gotcha: group changes are not retroactive to live sessions

`requireRole` reads the `cognito:groups` claim baked into the user's ID token at sign-in (`bb-auth-cognito` DESIGN.md:183). After `addUserToGroup`, an already-signed-in user keeps their old permissions until their token refreshes. To force the new role to take effect *now*, call `revokeUserSessions(username)` (as `setRole`/`suspendUser` above do). This is inherent Cognito behavior, not a KIT quirk — surfaced explicitly so it's never a silent surprise.

## Resolved Decisions (from design research)

These were open questions, settled by reading the implementation:

1. **Wiring shape → standalone `new AuthCognitoAdmin(scope, id, { auth })`.** Chosen over `auth.createAdmin()`. The deciding factor is the mock process model (below): the admin block needs a **live reference** to the auth instance, not just a discovery key, and `{ auth }` supplies exactly that. It also keeps the `Admin*` IAM grant out of `AuthCognito` (least privilege) and mirrors the existing `AdminSite({ auth })` precedent (`BB-admin-site.md:74`). The generic `O` is recovered from `auth: AuthCognito<O>`, so `GroupOf<O>` narrowing flows through with no extra annotation.

2. **Mock state-sharing → in-memory delegation via a `CognitoMockAdminPort`, NOT file-sharing.** The mock loads `state.json` once at construction and never reloads (`index.ts:216`); blocks are module-scope singletons reused across all requests (`dev-server.ts:76`). Two instances on one file would clobber each other (lost updates). The admin mock therefore delegates to the live auth instance's in-memory `state` through a narrow port exported from a **`@aws-blocks/bb-auth-cognito/internal` subpath** (not in the public types). The export-parity test (`conditional-exports.test.ts`) inspects only the bare `"."` specifier, so `/internal` is out of its scope — see Mock Implementation for the per-condition resolution of that subpath. See Mock Implementation above.

3. **Session-freshness → document + `revokeUserSessions()`.** `requireRole` reads the token's `cognito:groups` claim, not live state (both runtimes). Group changes take effect on next token refresh; `revokeUserSessions()` forces immediate effect. This is inherent Cognito semantics, surfaced explicitly rather than hidden.

4. **Group *definition* stays deploy-time.** This block manages membership and user lifecycle at runtime only. Creating/deleting `CfnUserPoolGroup` remains an `AuthCognito.options.groups` (synth-time) concern — runtime group creation would violate G7 (constructor is the only infra side effect). `addUserToGroup` to an unseeded group throws `GroupNotFound`.

5. **`scan` filter → typed subset, not raw string.** Resolved during review: `AdminScanOptions.filter` is `{ attribute; op; value }` over the attributes Cognito's `ListUsers` narrows server-side (G10 — don't leak the filter DSL; G18 — don't imply efficient filtering on unsupported attributes). See API Surface.

6. **Disabled-user enforcement already ships** (corrected during review): the mock `signIn` already rejects `disabled` users (`index.ts:452`). This block only adds the `disableUser`/`enableUser` mutators + a regression test — it does not wire the `signIn` check. Reuse the existing `forcePasswordChange` field name (`index.ts:506`).

7. **`addUserToGroup` is single-group, no array overload.** Cognito has no batch `AdminAddUserToGroup`; an array param would loop internally, which G14 forbids (don't fake batch over a loop — it misrepresents cost). Callers compose `Promise.all(roles.map(r => admin.addUserToGroup(u, r)))`. The common "assign roles at creation" case is already covered by `createUser({ groups: [...] })`.

8. **`createUser` models `FORCE_CHANGE_PASSWORD` faithfully.** When `permanent` is falsy, the mock sets `forcePasswordChange = true` on the `MockUserRecord`; the existing mock `signIn` already routes such users through the `CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED` challenge (`index.ts:506-514` — the code comment even says "seed it to `true` when simulating an `AdminCreateUser({ Permanent: false })` user"). So faithful mock↔AWS parity is ~one line, not a shortcut. `permanent: true` skips the flag and writes the password directly (AWS: a follow-up `AdminSetUserPassword({ Permanent: true })`).

9. **`AdminSite` composition deferred — but the user-management path is accounted for, not left to chance.** No `AdminSite` work in v1, and the API is already compatible (every return is client-safe plain data / a collectable `AsyncIterable`). Crucially, a blocks customer must still be able to ship a user-management UI **today** — that path is the **customer-built guarded `ApiNamespace` routes** shown in § Usage Examples ("full user-management admin screen"). That is the supported, documented v1 answer; the future `AdminSite` auto-panel is an additive convenience on top of the same methods, not a prerequisite. **Action for the build:** the README must lead with the guarded-routes recipe as the first-class way to build admin UI, and explicitly name `AuthCognitoAdmin` as the intended backend for a later `AdminSite` "Users" panel so return shapes are kept stable. Tracked as a forward-compat note, not a v1 dependency.

10. **Ships as a separate package `@aws-blocks/bb-auth-cognito-admin`** (not a `bb-auth-cognito/admin` subpath). Three reasons: (a) **opt-in least privilege** — apps that import only `bb-auth-cognito` never pull the `Admin*` IAM grant or admin SDK surface; a subpath risks the grant leaking through shared CDK code; (b) **D-004 naming** blesses `bb-auth-*` family packages and sorts it next to its parent; (c) **browser-bundle safety** — its own throwing `index.browser.ts` keeps the AWS SDK out of client bundles without entangling the parent's exports. Cost: one more package to version (accepted; the release coupling a subpath would create is worse).

> **Independent review applied.** This doc was reviewed by an independent agent against G1–G18 / T1–T5 and verified against the implementation. Corrections folded in: the false "disabled not yet enforced" claim (it is, `index.ts:452`); `GroupNotFound` confirmed to match the shipped `AuthCognitoErrors` value `ResourceNotFoundException` (the *parent* doc `BB-auth-cognito.md:296` is stale); `/internal` per-condition resolution + parity-test framing made precise; generic-narrowing `as const` caveat added; browser-stub + single-Lambda assumptions documented; G14 `createUser`/`setUserPassword` deviations acknowledged; method `@example`s/`@returns` completed; `scan` filter typed.

## Open Questions

*None blocking. All prior open questions (Q1–Q4) are resolved above (decisions 7–10). New questions that surface during implementation should be appended here.*
