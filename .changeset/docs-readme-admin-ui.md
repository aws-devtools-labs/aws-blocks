---
"@aws-cdk-blocks/admin-ui": patch
---

docs(admin-ui): the README names `dashboard()` from `@aws-cdk-blocks/core/scripts` as the way to start the Admin UI, not `npm run dashboard`

- Corrected: "How it runs" said that `npm run dashboard` in an app starts the dashboard. No `create-blocks-app` template defines that script and the `aws-cdk-blocks` task runner has no `dashboard` command. The README now names the entry point that exists, `dashboard()` in `packages/core/src/scripts/dashboard.ts`.
- Stated: the one-time install of `@aws-cdk-blocks/admin-ui` is offered only in an interactive terminal and runs `npm install --save-dev`; the dashboard listens on the first free port from 4400, or on `--port <n>`.
- Removed: the line about a future in-account provider.
