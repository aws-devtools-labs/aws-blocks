---
'@aws-blocks/create-blocks-app': patch
---

The e2e tests of new apps now use the new `getLastAuthCode` and `createTestClient` helpers from `@aws-blocks/blocks/utils`.

- Tests read each sign-up code with `getLastAuthCode`. Previously they read `.bb-data/my-app-auth/last-code.json` directly, a path that breaks when the scope or the block is renamed.
- The "another user can neither see nor change them" tests keep two users signed in at once, instead of signing out and back in.
