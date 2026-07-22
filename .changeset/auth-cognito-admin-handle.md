---
"@aws-blocks/bb-auth-cognito": patch
---

Add an opt-in `auth.admin` handle to `AuthCognito` for server-side group-membership and user-lifecycle administration.

Enable it by passing an `admin` options object; `admin.actions` scopes both the granted `Admin*` / `List*` IAM **and** the compile-time method surface. Without it, `auth.admin` is a compile error and no admin IAM is granted (unchanged default).

```ts
const auth = new AuthCognito(scope, 'auth', { groups: ['admins'], admin: { actions: ['groups'] } });
await auth.admin.addUserToGroup('alice', 'admins');
```

The admin surface is fully typed by the pool config `O`:

- **Action gating:** calling a method whose action group wasn't granted (e.g. `deleteUser` under `actions: ['groups']`) is a compile error, and fast-fails at runtime with a clear message instead of a cryptic AWS `AccessDenied`.
- **Typed reads:** `getUser` / `scan` / `listUsersInGroup` return `AdminUser<O>` — `groups` narrows to the configured group union and `attributes` keys to the declared attributes, matching the client-side `CognitoUser`.
- **Typed writes:** `createUser`'s `attributes` narrow to the declared keys (catches typos like `signUp` does).
- **`scan(filter?)`** accepts a server-side `AdminUserFilter` mapped to Cognito's `ListUsers` `Filter`.
- **`setUserPassword(username, password, { permanent })`** takes a named options object instead of a bare boolean.

The `AuthCognito` class generic is now a `const` type parameter, so inline options literals narrow without `as const`.

BREAKING CHANGE: `const O` narrows the params of `requireRole`, `updateUserAttribute`, and `updateMFAPreference` for inline-literal options. Callers passing widened `string` variables to these now need a cast or literal arguments.
