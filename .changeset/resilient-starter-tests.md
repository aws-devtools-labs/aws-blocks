---
"@aws-blocks/create-blocks-app": patch
---

Make scaffolded starter e2e tests resilient to replacing the sample API.

Six templates' `test/e2e.test.ts` (bare, backend, auth-cognito, demo, default, react) previously asserted against the sample API by name (`greet`, the KV `setValue`/`getValue`, or the todo CRUD suite). Removing or renaming that sample API — the first thing most projects do — immediately left a freshly-scaffolded app with a failing test before any real code was written. Each of these templates now ships an always-on, sample-API-independent readiness assertion that checks `/.blocks-sandbox/config.json`, so a fresh scaffold is validated end to end even before you touch the sample API. The sample-API assertions still run and assert against the shipped sample API, with a comment telling you to update or delete them when you replace it. The `default`/`react` readiness loops also stop depending on the sample auth API. Complements the readiness-loop decoupling shipped earlier.
