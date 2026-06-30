---
"@aws-blocks/bb-auth-cognito": minor
---

Add an opt-in `auth.admin` handle to `AuthCognito` for server-side group-membership and user-lifecycle administration.

Enable it by passing an `admin` options object; `admin.actions` scopes the granted `Admin*` / `List*` IAM. Without it, `auth.admin` is a compile error and no admin IAM is granted (unchanged default). Group names on the admin methods narrow via `GroupOf<O>`.

```ts
const auth = new AuthCognito(scope, 'auth', { groups: ['admins'], admin: { actions: ['groups'] } });
await auth.admin.addUserToGroup('alice', 'admins');
```

The `AuthCognito` class generic is now a `const` type parameter, so inline options literals narrow without `as const`.

BREAKING CHANGE: `const O` narrows the params of `requireRole`, `updateUserAttribute`, and `updateMFAPreference` for inline-literal options. Callers passing widened `string` variables to these now need a cast or literal arguments.
