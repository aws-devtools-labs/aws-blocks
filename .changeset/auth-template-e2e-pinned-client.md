---
"@aws-blocks/create-blocks-app": patch
---

fix: the auth template's e2e tests pin the client to the dev server or TEST_URL

- The auth template's `test/e2e.test.ts` now sets `BLOCKS_API_URL` to the dev server (or `TEST_URL`) before it imports `aws-blocks`, reads `TEST_URL`, and starts no dev server when `TEST_URL` names a deployed app — the same guard every other template got, so `npm run test:e2e` after a deploy never signs up users in the deployed stack.
- The template guard in `cli.test.ts` anchors on the awaited `import('aws-blocks')`, not a `typeof import(…)` type annotation, so a template that declares its module type inline is still checked.
