---
"@aws-blocks/core": minor
---

feat(core): run pre-deploy hooks that installed blocks declare

`npm run deploy` and `npm run sandbox` now look for a `predeploy` entry under `aws-blocks` in the `package.json` of every installed `@aws-blocks/*` package. Each hook receives the deploy stage, the project root, and a function that synthesizes the app and returns every stack template. A hook returns notes, which are printed, or stops, which abort the deploy before `cdk deploy` runs. The `sandbox` stage runs only hooks that list it. `runPredeployHooks()` and the hook types are exported from `@aws-blocks/core/scripts`.
