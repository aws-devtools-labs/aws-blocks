---
"@aws-blocks/core": minor
---

feat(core): run pre-deploy hooks that installed blocks declare

`npm run deploy` and `npm run sandbox` now read `aws-blocks.hooks.predeploy` in the `package.json` of every installed `@aws-blocks/*` package: the path of a module that exports `predeploy(context)`. Each hook receives the deploy stage, the project root, and a function that returns every stack template of the assembly that is about to be deployed. A hook returns notes, which are printed, or stops, which abort the deploy before `cdk deploy` runs. A hook runs on both stages and reads the stage to skip one. A hook name that core does not run stops the deploy. `runPredeployHooks()` and the hook types are exported from `@aws-blocks/core/scripts`.

`npm run deploy` now synthesizes the app once into its CDK output directory (`output` in `cdk.json`, by default `cdk.out`), runs the hooks on that assembly, then deploys it with `cdk deploy --app <dir>`, as `npm run sandbox` already did. `buildCdkDeployArgs()` takes the assembly directory.
