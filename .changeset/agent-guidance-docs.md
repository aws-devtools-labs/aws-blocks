---
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/auth-common": patch
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/blocks": patch
---

docs: tighten agent guidance in the app AGENTS.md and block READMEs

- The scaffolded `AGENTS.md` now says to keep and update `test/e2e.test.ts` instead of deleting it, to get `npm run test:e2e` passing before every deploy (it checks the API through the typed client, not the UI), to stop the dev server with `npm run dev:stop` before deploying and never with a name-matching kill, and to put functional checks in the e2e test rather than in local curl calls.
- `auth-common` and `bb-auth-basic` docs show that `setAuthState` and `submitAuthAction` are fully typed: a custom form needs no `as any`, and AuthBasic has no `autoSignIn` step.
- `bb-distributed-table` README documents that there is no atomic increment (with two counter patterns), and that errors should be matched with `isBlocksError` on an `unknown` catch.
