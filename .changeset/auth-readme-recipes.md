---
"@aws-blocks/bb-auth": patch
"@aws-blocks/blocks": patch
---

The `Auth` README has a "Recipes" section of complete, compile-checked snippets: MFA with an authenticator app (config, TOTP enrolment through `setUpTotp` / `verifyTotpSetup`, and the challenge the `Authenticator` handles), roles and an admin-only user list (`users.groups`, `requireRole`, `admin: {}`, `auth.admin.scan()`), the first admin (an `onSignIn` hook that calls `auth.admin.addUserToGroup` for an allowlisted email the pool has verified, read with `auth.admin.getUser`, since `user.attributes.email` alone does not prove ownership), and social sign-in (setting the client secret's SSM value and registering the Cognito callback URL). `@aws-blocks/bb-auth` ships its `API.md`.
