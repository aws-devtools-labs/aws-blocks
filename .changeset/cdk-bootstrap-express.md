---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/hosting": patch
---

The `cdk bootstrap` command that `npm run sandbox` prints for an account and Region that were never bootstrapped now passes `--express`: `npx cdk bootstrap aws://<account-id>/<region> --app= --express`. CloudFormation then creates the `CDKToolkit` stack in Express mode, reporting each resource complete without waiting for it to stabilize, so the bootstrap finishes sooner. CDK CLI versions before 2.1129.0 ignore the flag and bootstrap as before.

Express mode runs with CloudFormation rollback off, and `cdk bootstrap` has no option to turn it on, so a failed bootstrap leaves the `CDKToolkit` stack in place, possibly with the version parameter that the bootstrap check reads. The sandbox message therefore adds the command that deletes the stack, to run before you bootstrap again. `npm run deploy` keeps printing the command without `--express`, as production deploys never use Express mode.

The `@aws-blocks/hosting` README now shows the `us-east-1` bootstrap command for Lambda@Edge with `--app=`, as the bootstrap check prints it.
