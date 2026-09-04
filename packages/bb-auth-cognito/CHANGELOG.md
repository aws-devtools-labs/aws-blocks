# @aws-blocks/bb-auth-cognito

## 0.1.9

### Patch Changes

- 64ddd74: test: adapt CDK tests to the new config-registry finalize signature
  
  Test-only change: both packages' CDK tests were updated to call
  `finalizeConfigRegistry` with its new `(root, executionRole, computes)`
  signature. No runtime or public API change.
- Updated dependencies [64ddd74]
- Updated dependencies [646614b]
- Updated dependencies [c45eb92]
- Updated dependencies [4a830a6]
- Updated dependencies [1da58fd]
  - @aws-blocks/core@0.4.0
  - @aws-blocks/bb-logger@0.1.6
  - @aws-blocks/bb-app-setting@0.2.1
  - @aws-blocks/auth-common@0.1.7
  - @aws-blocks/bb-kv-store@0.1.8

## 0.1.8

### Patch Changes

- 309a236: refactor(bb): attach IAM grants to the shared execution role
  
  Data and auth blocks now grant permissions to the shared Blocks execution role
  (`this.executionRole`) instead of the handler function directly. Grants land on
  the same role the handler assumes, so the effective runtime permissions are
  identical — this decouples IAM wiring from the concrete Lambda function ahead of
  the multi-compute model.
  
  For `bb-distributed-data`, the DSQL endpoint and region now flow through the
  config registry (loaded into `process.env` at cold start, like every other
  block) rather than being set as direct handler environment variables, and the
  migration Lambda maps the shared execution role's ARN.
- Updated dependencies [1ff9d03]
- Updated dependencies [5798492]
- Updated dependencies [f00adb0]
- Updated dependencies [f00adb0]
- Updated dependencies [309a236]
- Updated dependencies [08ab129]
- Updated dependencies [9d4ccea]
- Updated dependencies [5bfae0a]
- Updated dependencies [0ac3879]
- Updated dependencies [e4dac4a]
  - @aws-blocks/bb-app-setting@0.2.0
  - @aws-blocks/core@0.3.0
  - @aws-blocks/bb-kv-store@0.1.7
  - @aws-blocks/auth-common@0.1.6
  - @aws-blocks/bb-logger@0.1.5

## 0.1.7

### Patch Changes

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-kv-store@0.1.6
  - @aws-blocks/auth-common@0.1.5
  - @aws-blocks/bb-app-setting@0.1.4
  - @aws-blocks/bb-logger@0.1.4

## 0.1.6

### Patch Changes

- feb5be4: Add an opt-in `auth.admin` handle to `AuthCognito` for server-side group-membership and user-lifecycle administration.

  Enable it by passing an `admin` options object; `admin.actions` scopes both the granted `Admin*` / `List*` IAM **and** the compile-time method surface. Without it, `auth.admin` is a compile error and no admin IAM is granted (unchanged default).

  ```ts
  const auth = new AuthCognito(scope, "auth", {
    groups: ["admins"],
    admin: { actions: ["groups"] },
  });
  await auth.admin.addUserToGroup("alice", "admins");
  ```

  The admin surface is fully typed by the pool config `O`:

  - **Action gating:** calling a method whose action group wasn't granted (e.g. `deleteUser` under `actions: ['groups']`) is a compile error, and fast-fails at runtime with a clear message instead of a cryptic AWS `AccessDenied`.
  - **Typed reads:** `getUser` / `scan` / `listUsersInGroup` return `AdminUser<O>` — `groups` narrows to the configured group union and `attributes` keys to the declared attributes, matching the client-side `CognitoUser`.
  - **Typed writes:** `createUser`'s `attributes` narrow to the declared keys (catches typos like `signUp` does).
  - **`scan(filter?)`** accepts a server-side `AdminUserFilter` mapped to Cognito's `ListUsers` `Filter`.
  - **`setUserPassword(username, password, { permanent })`** takes a named options object instead of a bare boolean.

  The `AuthCognito` class generic is now a `const` type parameter, so inline options literals narrow without `as const`.

  Note: `const O` narrows the params of `requireRole`, `updateUserAttribute`, and `updateMFAPreference` for inline-literal options. Callers passing widened `string` variables to these may need a cast or literal arguments.

- 7b3bb06: Enable `PreventUserExistenceErrors` on the Cognito user pool client. Sign-in and forgot-password responses now return a uniform error regardless of whether the username exists, closing the account-enumeration oracle that Cognito exposes by default (distinct `UserNotFoundException` vs. wrong-password errors).
- b83aaba: Add opt-in TTL support to `KVStore` and use it to expire `AuthCognito` session records.

  `KVStore` gains a `ttl` construct option that enables DynamoDB Time-to-Live on the table, plus per-write expiry via `put(key, value, { ttlSeconds })` or `{ expiresAt }`. Both default to off, so existing tables and every existing `put()` call are unaffected. Because DynamoDB deletes expired items asynchronously, `get` and `scan` also filter expired items on read in every runtime, and the local mock emulates the same expiry semantics. Maintenance sweeps that need to act on rows the reaper has not collected yet can opt out with `scan({ includeExpired: true })`.

  `AuthCognito` now enables TTL on its sessions table and stamps each session write with `now + sessionTtlSeconds`. Session records store live Cognito refresh tokens, so without an expiry the table grew without bound and retained those credentials at rest indefinitely; abandoned sessions are now reaped automatically. Authorization is unchanged — validity is still decided by token revalidation on every request.

  Two things to know before upgrading:

  - **Your next `cdk deploy` enables TTL on the existing sessions table.** Even though this is a patch, `AuthCognito` now passes `{ ttl: true }`, so the deploy issues a one-time `UpdateTimeToLive` against the live table. That is an online, non-disruptive DynamoDB operation — no downtime, no data loss — but it is a mutation of a live resource, so it shouldn't surprise anyone diffing a patch upgrade.
  - **Only sessions written after the upgrade expire.** A missing `ttl` attribute means "never expires" (matching DynamoDB), and existing rows are not backfilled, so sessions created before the upgrade keep their refresh tokens at rest indefinitely. Backfilling would need a one-time migration writing `ttl` onto every existing row. To close the retention gap immediately, revoke the pre-existing sessions instead — the revoke sweep deletes rows regardless of expiry state.

- Updated dependencies [75f5446]
- Updated dependencies [2ed4177]
- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [b83aaba]
- Updated dependencies [2d3dfdc]
- Updated dependencies [3c56267]
  - @aws-blocks/auth-common@0.1.4
  - @aws-blocks/core@0.1.17
  - @aws-blocks/bb-kv-store@0.1.5
  - @aws-blocks/bb-logger@0.1.3

## 0.1.5

### Patch Changes

- 1da34f1: fix(auth): propagate the structured error name through `setAuthState()`

  The recommended client auth path is `createApi()` → `setAuthState()`. When an
  action failed, `setAuthState()` caught the thrown `ApiError` and returned an
  `AuthState` carrying only `error: e.message`, discarding the structured
  `e.name` (e.g. `'InvalidCredentialsException'`). Because `AuthState` had no
  field for an error name, a hand-rolled client could not branch on error type
  (e.g. "try sign-in, fall back to sign-up for a brand-new user") without
  brittle string-matching the human-facing message.

  `AuthState` now carries an optional `errorName`, and the `bb-auth-basic` and
  `bb-auth-cognito` `setAuthState` implementations populate it from the thrown
  `ApiError.name` (skipping the generic `'ApiError'` default). A new
  `hasAuthError(state, name)` type guard in `@aws-blocks/core` lets clients
  branch on the returned state — `isBlocksError` only matches thrown `Error`
  instances, so it cannot be used on the plain `AuthState` object. Rule of
  thumb: throw path → `isBlocksError`; returned `AuthState` → `hasAuthError`.

- Updated dependencies [f42c604]
- Updated dependencies [1da34f1]
- Updated dependencies [683bf49]
  - @aws-blocks/core@0.1.6
  - @aws-blocks/auth-common@0.1.3
  - @aws-blocks/bb-kv-store@0.1.4

## 0.1.4

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
- Updated dependencies [d4a1390]
  - @aws-blocks/auth-common@0.1.2
  - @aws-blocks/bb-app-setting@0.1.3
  - @aws-blocks/bb-kv-store@0.1.3
  - @aws-blocks/bb-logger@0.1.2

## 0.1.3

### Patch Changes

- 7fd51e0: fix(bb-auth-cognito): discriminate `SignInResult` on a string `status` field

  `SignInResult` (from `signIn` / `confirmSignIn` / `autoSignIn`) now discriminates
  on a string `status` (`'signedIn' | 'continueSignIn'`) instead of the `isSignedIn`
  boolean, so native-client codegen (Swift / Kotlin / Dart) emits clean, named,
  switch-decoded variants. Narrow with `if (result.status === 'signedIn')`.

  Breaking change to the `SignInResult` shape (pre-release): `isSignedIn` is removed,
  not aliased.

- Updated dependencies [e98bab4]
  - @aws-blocks/core@0.1.3

## 0.1.2

### Patch Changes

- 18880ff: Minor test improvements
- Updated dependencies [18880ff]
- Updated dependencies [18880ff]
  - @aws-blocks/bb-app-setting@0.1.2
  - @aws-blocks/bb-kv-store@0.1.2
  - @aws-blocks/core@0.1.2

## 0.1.1

### Patch Changes

- 270c049: docs: scrub and port documentation from internal staging repo
- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/auth-common@0.1.1
  - @aws-blocks/bb-app-setting@0.1.1
  - @aws-blocks/bb-kv-store@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
