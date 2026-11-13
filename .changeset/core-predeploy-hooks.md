---
"@aws-blocks/core": minor
---

feat(core): run pre-deploy hooks that installed blocks declare

`npm run deploy` and `npm run sandbox` now read `aws-blocks.hooks.predeploy` in the `package.json` of every installed `@aws-blocks/*` package: the path of a module that exports `predeploy(context)`. Each hook receives the deploy stage, the project root, and a function that synthesizes the app and returns every stack template. A hook returns notes, which are printed, or stops, which abort the deploy before `cdk deploy` runs. A hook runs on both stages and reads the stage to skip one. A hook name that core does not run stops the deploy. `runPredeployHooks()` and the hook types are exported from `@aws-blocks/core/scripts`.
