---
'@aws-blocks/bb-auth': minor
'@aws-blocks/blocks': minor
'@aws-blocks/core': patch
---

Add auth test helpers to `@aws-blocks/blocks/utils`. Both are Node-only and are not reachable from any browser entry.

- `getLastAuthCode(username, { block?, purpose?, cwd? })` returns the verification code the local pool sent to a user, for e2e tests of sign-up, password-reset, MFA and attribute-verification flows. It finds the block's data under `.bb-data/` itself, so renaming the scope or the block no longer breaks the test with `ENOENT`. It reads the codes the pool still holds, so a user's code is still found after another user's code was sent. When there is nothing to read, it throws an error that names what each local block last sent. It is also exported from `@aws-blocks/bb-auth/testing`.
- `createTestClient(clients)` returns the app's typed clients (for example `createTestClient(await import('aws-blocks'))`) with a cookie jar of their own. A test can now act as two users at once, such as an owner and an intruder, without signing out between steps. The shared jar from `installCookieJar()` is never involved.

To support this, the generated API client (`ApiNamespaceClient`) now sends a call with the `fetch` that the call's async context supplies, when there is one. Nothing changes for an app that doesn't use `createTestClient`.
