# Required @aws-blocks Building Blocks

All Building Blocks are imported from `@aws-blocks/blocks`. The implementation must route the task's core behavior through the real block API below — not an in-memory Map/array, a hardcoded result, or an inline stub.

- AuthCognito — drives the passwordless email-OTP flow (the template ships it configured for `USER_AUTH` + `EMAIL_OTP`). Expect the real auth methods — `auth.signUp` / `auth.confirmSignUp(username, code)` / `auth.signIn` and `auth.requireAuth(context)` (or `getCurrentUser`) — establishing and restoring the session, not a faked code check.
