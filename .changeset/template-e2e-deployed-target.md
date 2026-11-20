---
"@aws-cdk-blocks/create-blocks-app": patch
---

fix: the template e2e tests no longer fail when `TEST_URL` names a deployed app

`TEST_URL=<deployed URL> npm run test:e2e` failed in the `api-only`, `sql`, `default`, `react`, `demo` and `observability` templates: their signed-in tests confirm each sign-up with `getLastAuthCode()`, which reads the local mock's files, while a deployed backend emails the code.

- Those tests are now reported as skipped, with the reason, unless the server is the local mock — the same `skipUnlessLocal(t)` check the `auth` template uses. The public and signed-out checks still run against the deployed app. Without `TEST_URL` every test runs as before.
- `api-only`: the `/healthz` tests call the app under test instead of always calling `localhost`. Against a deployed app the trailing-slash probe is not checked.
- `sql`: a new test checks that the API rejects a signed-out caller, so a run against a deployed app checks something.
- The same tests also skip against a dev server that proxies to a sandbox, where they used to fail for the same reason.
