---
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/auth-common": patch
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/blocks": patch
---

docs: tighten agent guidance in the app AGENTS.md and block READMEs

- The scaffolded `AGENTS.md` now states the RPC namespace is the exported variable name (not the `ApiNamespace` construct ID), says to keep and update `test/e2e.test.ts` instead of deleting it, documents how stack names derive from `stackId` in `.blocks/config.json`, gives a realistic first-deploy duration and tool timeout, and explains that the CDN can briefly serve the previous `index.html` after a redeploy.
- `auth-common` and `bb-auth-basic` READMEs show that `setAuthState` is fully typed: a custom form needs no `as any`, and AuthBasic has no `autoSignIn` step.
- `bb-distributed-table` README documents that reads are eventually consistent, that there is no atomic increment (with two counter patterns), and that errors should be matched with `isBlocksError` on an `unknown` catch.
